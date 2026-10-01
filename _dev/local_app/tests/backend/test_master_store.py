import copy
import hashlib
import json
import sqlite3
import subprocess
import tempfile
import unittest
import uuid
from contextlib import closing
from pathlib import Path

from local_app.backend.master_store import (
    FutureMasterSchemaError,
    InvalidMasterBundle,
    MasterMutationConflict,
    MasterRevisionConflict,
    MasterStore,
    MasterStoreError,
    master_bundle_content_hash,
    validate_master_bundle,
)


ROOT = Path(__file__).resolve().parents[2]
M1_MODULE = ROOT / "frontend" / "js" / "domain" / "trade-master-bundle.js"


def _entity(stable_id=None, *, kind="ITEM", legacy_key="legacy:sample", name="샘플 품목", tier=1):
    stable_id = stable_id or str(uuid.uuid4())
    legacy = [] if legacy_key is None else [{
        "legacyNameKey": legacy_key,
        "legacyKind": "ISLAND" if kind == "ISLAND" else "MASTER_ITEM",
        "rawName": name,
        "tier": None if kind == "ISLAND" else tier,
        "occurrences": [{"locator": "/fixture/0", "scope": "FIXTURE", "tier": None if kind == "ISLAND" else tier}],
        "authorityStatus": "LEGACY_UNVERIFIED",
    }]
    return {
        "stableId": stable_id, "kind": kind, "canonicalName": name,
        "displayNames": [], "aliases": [], "legacyNames": legacy,
        "tier": None if kind == "ISLAND" else tier,
        "category": None, "status": "LEGACY_UNVERIFIED", "provenance": {"ownerNote": "검수 초안"},
        "replacedBy": None,
    }


def _fields(*, entities=None, unresolved=None, created_at="2026-10-01T00:00:00Z", provenance=None):
    entities = list(entities or [])
    unresolved = list(unresolved or [])
    mappings = []
    for entity in entities:
        if entity["legacyNames"]:
            mappings.append({"stableId": entity["stableId"],
                             "legacyNameKeys": [r["legacyNameKey"] for r in entity["legacyNames"]],
                             "sourceLocators": [o["locator"] for r in entity["legacyNames"] for o in r["occurrences"]]})
    return {"createdAt": created_at, "entities": entities, "compatibilityMappings": mappings,
            "unresolvedLegacyNames": unresolved, "sourceRevisions": [], "provenance": provenance or {"source": "test"}}


def _bundle(**kwargs):
    fields = _fields(**kwargs)
    draft = {"schemaVersion": 2, "registryVersion": "", **fields,
             "hashBasis": "MASTER_CANONICAL_JSON_V2", "contentHash": ""}
    semantic = {k: v for k, v in draft.items() if k not in {"createdAt", "registryVersion", "contentHash"}}
    digest = hashlib.sha256(json.dumps(semantic, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    draft["contentHash"] = digest
    draft["registryVersion"] = f"registry-v2:{digest}"
    return draft


class MasterStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / "master" / "master.sqlite3"
        self.store = MasterStore(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def _publish(self, bundle=None, mutation="mutation-1", expected=None):
        return self.store.publish_bundle(bundle or _bundle(), mutation_id=mutation,
                                         expected_registry_version=expected, owner_approved=True)

    def test_initialize_fresh_schema_reopen_and_read_baseline(self):
        self.store.initialize()
        self.store.initialize()
        self.assertIsNone(self.store.get_active_bundle())
        self.assertIsNone(self.store.get_active_registry_version())
        self.assertEqual(self.store.store_revision(), 0)
        with closing(sqlite3.connect(self.path)) as db, db:
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertTrue({"master_meta", "master_bundle", "master_activation_history", "master_mutation_receipt"} <= names)
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 0)  # enabled per store connection
        self.assertEqual(self.store.get_active_bundle(), None)

    def test_future_schema_and_unknown_foreign_database_rejected(self):
        self.path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("CREATE TABLE master_meta(id INTEGER PRIMARY KEY, schema_version INTEGER)")
            db.execute("INSERT INTO master_meta VALUES (1, 2)")
        with self.assertRaises(FutureMasterSchemaError):
            self.store.initialize()
        other = self.root / "other.sqlite3"
        with closing(sqlite3.connect(other)) as db, db:
            db.execute("CREATE TABLE unrelated(value TEXT)")
        with self.assertRaises(MasterStoreError):
            MasterStore(other).initialize()

    def test_first_publish_approval_cas_idempotency_and_reopen(self):
        self.store.initialize()
        bundle = _bundle()
        with self.assertRaises(MasterStoreError):
            self.store.publish_bundle(bundle, mutation_id="no-approval", expected_registry_version=None, owner_approved=False)
        with self.assertRaises(MasterRevisionConflict):
            self._publish(bundle, expected="not-active")
        self.assertIsNone(self.store.get_bundle(bundle["registryVersion"]))
        first = self._publish(bundle)
        self.assertEqual(first["storeRevision"], 1)
        self.assertTrue(first["activated"])
        replay = self._publish(bundle)
        self.assertEqual(replay, first)
        self.assertEqual(self.store.store_revision(), 1)
        self.assertEqual(self.store.get_active_bundle(), bundle)
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute("SELECT count(*) FROM master_activation_history").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM master_mutation_receipt").fetchone()[0], 1)
        reopened = MasterStore(self.path)
        self.assertEqual(reopened.get_active_bundle(), bundle)

    def test_mutation_reuse_with_different_body_conflicts(self):
        self.store.initialize()
        self._publish(_bundle(), mutation="same")
        changed = _bundle(created_at="2026-10-02T00:00:00Z")
        with self.assertRaises(MasterMutationConflict):
            self.store.publish_bundle(changed, mutation_id="same", expected_registry_version=None, owner_approved=True)
        self.assertEqual(self.store.store_revision(), 1)

    def test_semantic_duplicate_reuses_immutable_bundle_and_revision_only_changes_on_activation(self):
        self.store.initialize()
        first_bundle = _bundle()
        first = self._publish(first_bundle, mutation="first")
        semantically_same = _bundle(created_at="2026-10-02T00:00:00Z")
        self.assertEqual(first_bundle["contentHash"], semantically_same["contentHash"])
        result = self._publish(semantically_same, mutation="duplicate", expected=first_bundle["registryVersion"])
        self.assertTrue(result["semanticDuplicate"])
        self.assertFalse(result["activated"])
        self.assertEqual(result["storeRevision"], 1)
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute("SELECT count(*) FROM master_bundle").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM master_activation_history").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT created_at FROM master_bundle").fetchone()[0], first_bundle["createdAt"])

    def test_second_version_rollback_and_old_bundle_immutability(self):
        self.store.initialize()
        a = _bundle()
        self._publish(a, mutation="a")
        entity = _entity(legacy_key=None, name="다른 이름")
        b = _bundle(entities=[entity], created_at="2026-10-02T00:00:00Z")
        self._publish(b, mutation="b", expected=a["registryVersion"])
        old_bytes = json.dumps(self.store.get_bundle(a["registryVersion"]), ensure_ascii=False, sort_keys=True)
        rollback = self.store.activate_existing_bundle(a["registryVersion"], mutation_id="rollback",
                                                      expected_registry_version=b["registryVersion"], owner_approved=True)
        self.assertEqual(rollback["storeRevision"], 3)
        self.assertEqual(self.store.get_active_registry_version(), a["registryVersion"])
        self.assertEqual(json.dumps(self.store.get_bundle(a["registryVersion"]), ensure_ascii=False, sort_keys=True), old_bytes)
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute("SELECT count(*) FROM master_activation_history").fetchone()[0], 3)

    def test_stable_uuid_kind_identity_mapping_and_unresolved_continuity(self):
        self.store.initialize()
        stable_id = str(uuid.uuid4())
        key = "legacy:one"
        one = _entity(stable_id, legacy_key=key)
        first = _bundle(entities=[one])
        self._publish(first, mutation="first")
        # Existing ID removal and kind mutation are rejected.
        with self.assertRaises(InvalidMasterBundle):
            self._publish(_bundle(), mutation="removed", expected=first["registryVersion"])
        island = _entity(stable_id, kind="ISLAND", legacy_key=None, name="섬")
        with self.assertRaises(InvalidMasterBundle):
            self._publish(_bundle(entities=[island]), mutation="kind", expected=first["registryVersion"])
        reassigned = _entity(str(uuid.uuid4()), legacy_key=key)
        with self.assertRaises(InvalidMasterBundle):
            self._publish(_bundle(entities=[reassigned]), mutation="reassigned", expected=first["registryVersion"])

    def test_unresolved_to_resolved_allowed_but_unexplained_disappearance_rejected(self):
        self.store.initialize()
        unresolved = {"legacyNameKey": "legacy:pending", "legacyKind": "MASTER_ITEM", "rawName": "보류",
                      "tier": 1, "occurrences": [{"locator": "/pending", "scope": "TEST", "tier": 1}],
                      "authorityStatus": "LEGACY_UNVERIFIED", "reason": "NO_CURATED_IDENTITY"}
        a = _bundle(unresolved=[unresolved])
        self._publish(a, mutation="unresolved")
        b = _bundle()
        with self.assertRaises(InvalidMasterBundle):
            self._publish(b, mutation="disappear", expected=a["registryVersion"])
        entity = _entity(legacy_key="legacy:pending", name="보류")
        entity["legacyNames"][0]["occurrences"][0]["locator"] = "/pending"
        resolved = _bundle(entities=[entity])
        # fix helper's locator-derived mapping is already exact
        accepted = self._publish(resolved, mutation="resolved", expected=a["registryVersion"])
        self.assertTrue(accepted["activated"])

    def test_invalid_hash_and_unsafe_numbers_rejected(self):
        self.store.initialize()
        b = _bundle()
        tampered = copy.deepcopy(b)
        tampered["contentHash"] = "0" * 64
        with self.assertRaises(InvalidMasterBundle):
            validate_master_bundle(tampered)
        for bad_value in (1.25, float("nan"), float("inf"), 2**53):
            bad = _bundle(provenance={"value": bad_value})
            with self.assertRaises(InvalidMasterBundle):
                validate_master_bundle(bad)

    def test_uuid_is_canonical_and_replaced_by_cycles_rejected(self):
        self.store.initialize()
        entity = _entity("not-a-uuid", legacy_key=None)
        with self.assertRaises(InvalidMasterBundle):
            validate_master_bundle(_bundle(entities=[entity]))
        a_id, b_id = str(uuid.uuid4()), str(uuid.uuid4())
        a, b = _entity(a_id, legacy_key=None), _entity(b_id, legacy_key=None)
        a["status"], a["replacedBy"] = "DEPRECATED", b_id
        b["status"], b["replacedBy"] = "DEPRECATED", a_id
        with self.assertRaises(InvalidMasterBundle):
            validate_master_bundle(_bundle(entities=[a, b]))

    def test_input_and_read_results_are_detached(self):
        self.store.initialize()
        bundle = _bundle()
        original = copy.deepcopy(bundle)
        self._publish(bundle)
        self.assertEqual(bundle, original)
        read = self.store.get_active_bundle()
        read["provenance"]["source"] = "mutated"
        self.assertEqual(self.store.get_active_bundle(), original)

    def test_activation_failure_rolls_back_bundle_history_pointer_and_receipt(self):
        self.store.initialize()
        candidate = _bundle()
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("CREATE TRIGGER fail_activation BEFORE UPDATE OF active_registry_version ON master_meta BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self._publish(candidate, mutation="will-rollback")
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute("SELECT count(*) FROM master_bundle").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM master_activation_history").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM master_mutation_receipt").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT store_revision,active_registry_version FROM master_meta").fetchone(), (0, None))

    def test_backup_is_verified_snapshot_and_does_not_overwrite(self):
        self.store.initialize()
        a = _bundle()
        self._publish(a, mutation="a")
        backup_path = self.root / "backup" / "master.sqlite3"
        self.store.backup_to(backup_path)
        b = _bundle(entities=[_entity(legacy_key=None, name="두 번째")], created_at="2026-10-03T00:00:00Z")
        self._publish(b, mutation="b", expected=a["registryVersion"])
        backup = MasterStore(backup_path)
        self.assertEqual(backup.get_active_registry_version(), a["registryVersion"])
        self.assertIsNone(backup.get_bundle(b["registryVersion"]))
        with closing(sqlite3.connect(backup_path)) as db, db:
            self.assertEqual(db.execute("SELECT count(*) FROM master_activation_history").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM master_mutation_receipt").fetchone()[0], 1)
        with self.assertRaises(FileExistsError):
            self.store.backup_to(backup_path)
        with self.assertRaises(MasterStoreError):
            self.store.backup_to(self.path)

    def test_python_hash_matches_m1_node_for_unicode_and_normalization_distinctions(self):
        self.store.initialize()
        entity = _entity(legacy_key=None, name="한글 ASCII 공백 e\u0301 é")
        bundle = _bundle(entities=[entity], provenance={"한글": " 값 ", "ASCII": "A", "decomposed": "e\u0301", "composed": "é"})
        script = f'''
          import fs from "node:fs";
          import {{ pathToFileURL }} from "node:url";
          const mod = await import(pathToFileURL({json.dumps(str(M1_MODULE))}));
          const input = JSON.parse(fs.readFileSync(0, "utf8"));
          const result = mod.createMasterBundleV2(input);
          process.stdout.write(JSON.stringify({{bundle: result, hash: mod.masterBundleContentHash(result)}}));
        '''
        proc = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps(_fields(entities=[entity], provenance=bundle["provenance"]), ensure_ascii=False),
                              text=True, encoding="utf-8", capture_output=True, check=False)
        self.assertEqual(proc.returncode, 0, msg=f"Node/M1 parity contract must run; stderr={proc.stderr}")
        actual = json.loads(proc.stdout)
        self.assertEqual(actual["bundle"]["contentHash"], bundle["contentHash"])
        self.assertEqual(actual["hash"], master_bundle_content_hash(bundle))
        self.assertNotEqual("e\u0301", "é")
        self.assertNotEqual(hashlib.sha256("e\u0301".encode()).digest(), hashlib.sha256("é".encode()).digest())

    def test_master_bundle_v2_fixed_golden_vector(self):
        bundle = _bundle(
            entities=[_entity("123e4567-e89b-12d3-a456-426614174000", legacy_key=None, name="한글 ASCII e\u0301 é")],
            provenance={"alpha": "A", "조합": "e\u0301", "완성": "é"},
        )
        self.assertEqual(bundle["contentHash"], "647fd05ad0de51d8e00331adda37be87981e2fdd4f453841ff22231d8b845d76")
        self.assertEqual(master_bundle_content_hash(bundle), bundle["contentHash"])


if __name__ == "__main__":
    unittest.main()
