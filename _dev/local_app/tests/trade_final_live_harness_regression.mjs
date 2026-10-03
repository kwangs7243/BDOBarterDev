#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyExportIndependence, sourceRowsFromExport } from "./browser_trade_review_live.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const harnessPath = path.join(ROOT, "local_app", "tests", "browser_trade_review_live.mjs");
const harness = await readFile(harnessPath, "utf8");

assert.match(harness, /L1_ROOT = path\.join\(ROOT, "recognition-local", "live-validation", "l1-final"\)/);
assert.doesNotMatch(harness, /const EXPECTED_BASELINE\s*=\s*"9d413d6/);
assert.match(harness, /L1_BASELINE_PARENT = "c08b8ae5a3914a2e95515bfc895c9f470d6de8d9"/);
assert.match(harness, /trade-final-review-evaluation-v3/);
assert.match(harness, /reviewed-trade-dto-mapping-v3/);
assert.match(harness, /exportRecord\?\.schemaVersion !== 3/);
assert.match(harness, /exportRecord\.exportType !== "TRADE_FINAL_REVIEW_OBSERVATION"/);
assert.match(harness, /USER_FINAL_LIST_CONFIRMED/);
assert.match(harness, /HUMAN_CROP_VERIFIED_ONLY/);
assert.match(harness, /ownerUsabilityDecision: null/);
assert.match(harness, /sessionState === "APPLIED"/);
assert.match(harness, /entries\.length\) throw new Error\(`L1 live freeze는 clean working tree/);
assert.doesNotMatch(harness, /\.trade-review-table/);
assert.doesNotMatch(harness, /querySelector\([^\n]*(?:recognize-trade|confirm|apply-reviewed)[^\n]*\)\?*\.click\(/);
assert.match(harness, /browser\.truthLabelPosts\.length/);
assert.match(harness, /isolated-master/);
assert.match(harness, /buildRepositoryBaselineMasterBundle/);
assert.match(harness, /isolated_repository_catalog_and_reference_manifest/);
assert.match(harness, /publishIsolatedMasterBundle/);
assert.match(harness, /api\/master\/active/);
assert.match(harness, /isolatedMasterDb/);

const h = (letter) => letter.repeat(64);
const exportCapture = { captureId: "capture-new", sourceType: "STREAM", bitmapSha256: h("a"), imageSha256: h("b"), sourceSha256: null };
const freeze = { preFreezeImageEvidence: [{ sha256: h("c"), path: "old.png" }], preFreezeImageHashes: [h("c")] };
const sourceMatch = { status: "SOURCE_PROVENANCE_MATCH" };
const mode = "STREAM";
assert.equal(classifyExportIndependence([exportCapture], freeze, [], sourceMatch, mode).independentCandidate, true);
assert.equal(classifyExportIndependence([{ ...exportCapture, bitmapSha256: h("c") }], freeze, [], sourceMatch, mode).status,
  "DUPLICATE_NON_INDEPENDENT");
assert.equal(classifyExportIndependence([exportCapture], freeze,
  [{ task: "R011", caseId: "historic", status: "legacy", sourceCaptures: [] }], sourceMatch, mode).status,
"INDEPENDENCE_UNVERIFIABLE_PRIOR_CASE_HASHES_MISSING");

const export3 = { schemaVersion: 3, exportType: "TRADE_FINAL_REVIEW_OBSERVATION", hashBasis: "TRADE_EXPORT_JSON_V3", semantic: { observation: {
  schemaVersion: 3, reviewMode: "FINAL_CORRECTED_RESULT", sourceContext: { rawEvidence: { snapshot: { schemaVersion: 2, captures: [
    { captureId: "capture-1", captureOrdinal: 0, sourceType: "STREAM", bitmapSha256: h("d"), frame: { width: 20, height: 10 } },
  ], sourceRows: [{ captureId: "capture-1" }], edgeSegments: [] } } } } } };
assert.deepEqual(sourceRowsFromExport(export3), [{ captureId: "capture-1", captureOrdinal: 0, sourceType: "STREAM",
  capturedAt: null, frame: { width: 20, height: 10 }, fidelity: null, sourceSha256: null,
  bitmapSha256: h("d"), imageSha256: null, bitmapBytes: null, sourceBytes: null, reencoded: false,
  completeRowCount: 1, edgeSegmentCount: 0 }]);
assert.throws(() => sourceRowsFromExport({ schemaVersion: 1, semantic: { observation: { sourceContext: { captures: [] } } } }),
  /현재 Export3\/RawEvidenceSnapshot2 계약/);

process.stdout.write("trade_final_live_harness_regression: PASS (L1 contract, Export3 source accounting, hash duplicate guard, no auto truth/session action)\n");
