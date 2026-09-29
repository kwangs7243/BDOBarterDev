from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from recognition_policy_derivation import (  # noqa: E402
    DERIVATION_SPEC,
    build_result,
    canonical_hash,
    evaluate_candidate,
    generate_candidates,
    load_verified_records,
    observed_breakpoints,
    resolve_policy_decision,
    resolve_policy_file,
)


ARTIFACT = ROOT / "recognition-local" / "results" / "warehouse-candidates-t006b.json"
MANIFEST = ROOT / "tests" / "fixtures" / "recognition-v2" / "manifest.json"
POLICY = ROOT / "local_app" / "recognition_data" / "policy.json"


def _record(slot: str, *, truth_item: int = 1, predicted_item: int = 1,
            truth_quantity: int = 0, predicted_quantity: int = 0) -> dict:
    return {
        "fixtureId": "synthetic",
        "slot": slot,
        "truth": {"itemId": truth_item, "quantity": truth_quantity},
        "evidence": {"r0": {"bestItemId": predicted_item, "decision": "MATCH",
                             "quantity": {"status": "QUANTITY_MATCH", "value": predicted_quantity}}},
    }


class RecognitionPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.artifact = json.loads(ARTIFACT.read_text(encoding="utf-8"))
        cls.records, cls.scope_counts = load_verified_records(cls.artifact, MANIFEST)

    def test_observed_breakpoints_are_sorted_unique_and_include_midpoints(self):
        self.assertEqual(observed_breakpoints([3, 1, 1, 2]), [1.0, 1.5, 2.0, 2.5, 3.0])

    def test_candidate_generation_and_hash_are_deterministic(self):
        first = generate_candidates(self.records)
        second = generate_candidates(self.records)
        self.assertEqual(first, second)
        self.assertEqual([row["candidateHash"] for row in first],
                         [canonical_hash(row["conditions"]) for row in first])
        self.assertEqual(len({row["candidateId"] for row in first}), len(first))
        self.assertEqual(canonical_hash(DERIVATION_SPEC), canonical_hash(dict(DERIVATION_SPEC)))

    def test_policy_absent_unapproved_candidate_and_stratum_fail_closed(self):
        self.assertEqual(resolve_policy_decision(None, "candidate", "native")["automationDecision"], "REVIEW")
        self.assertEqual(resolve_policy_file(ROOT / "missing-policy-for-test.json", "candidate", "native")["automationDecision"], "REVIEW")
        policy = json.loads(POLICY.read_text(encoding="utf-8"))
        self.assertEqual(resolve_policy_decision(policy, None, None)["automationDecision"], "REVIEW")
        fabricated = {"approved": True, "usableReviewApproved": True, "releaseApproved": True,
                      "autoApproved": True, "approvedCandidateId": "known", "supportedStrata": ["native"]}
        self.assertEqual(resolve_policy_decision(fabricated, "unknown", "native")["reason"], "UNKNOWN_CANDIDATE")
        self.assertEqual(resolve_policy_decision(fabricated, "known", "unknown")["reason"], "UNKNOWN_STRATUM")
        self.assertEqual(resolve_policy_decision(fabricated, "known", "native")["automationDecision"], "REVIEW")

    def test_wrong_high_is_rejected_and_correct_review_is_separate(self):
        wrong = _record("R1C1", truth_item=2, predicted_item=1)
        candidate = {"candidateId": "wrong", "highSlots": ["synthetic:R1C1"]}
        result = evaluate_candidate(candidate, [wrong])
        self.assertEqual(result["observedWrongHigh"], 1)
        self.assertEqual(result["candidateStatus"], "REJECTED_ON_CALIBRATION")
        reviewed = evaluate_candidate({"candidateId": "review", "highSlots": []}, [_record("R1C2")])
        self.assertEqual(reviewed["correctReview"], 1)
        self.assertEqual(reviewed["hypotheticalHigh"], 0)

    def test_truth_scope_skips_empty_tier5_and_unknown_and_keeps_zero(self):
        self.assertEqual(self.scope_counts["targetVerified"], 105)
        self.assertEqual(self.scope_counts["emptySkipped"], 6)
        self.assertEqual(self.scope_counts["tier5Skipped"], 10)
        self.assertEqual(self.scope_counts["generalUnknownExcluded"], 5)
        zero_result = evaluate_candidate({"candidateId": "zero", "highSlots": []}, [_record("R1C1")])
        self.assertEqual(zero_result["correctReview"], 1)
        self.assertEqual(zero_result["unknownReview"], 0)

    def test_historical_seven_excluded_and_no_holdout_or_activation_claim(self):
        leakage = self.artifact["truthLeakageEvidence"]
        self.assertFalse(leakage["candidateReaderInputsContainTruth"])
        self.assertFalse(leakage["candidateReaderInputsContainCurrentStock"])
        self.assertFalse(leakage["candidateReaderInputsContainHumanCorrection"])
        self.assertTrue(leakage["candidateInferenceCompletedBeforeFixtureTruthEvaluation"])
        output = build_result(self.artifact, ARTIFACT, MANIFEST)
        self.assertEqual(output["historicalDocumentedAggregate"],
                         {"documentedCount": 7, "mapped": 0, "denominatorIncluded": False})
        self.assertEqual(output["captureWorkload"]["verifiedTargetSlots"], 105)
        semantic = dict(output)
        digest = semantic.pop("semanticHash")
        self.assertEqual(digest, canonical_hash(semantic))
        self.assertIn("blindHoldout=false", output["limitations"])
        self.assertIs(output["approval"]["approvedCandidateId"], None)
        self.assertFalse(output["approval"]["productionV2Activated"])
        self.assertFalse(output["approval"]["HIGHAuthority"])


if __name__ == "__main__":
    unittest.main()
