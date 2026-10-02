import hashlib
import json
import sqlite3
import subprocess
import tempfile
import unittest
import uuid
import copy
from contextlib import closing
from pathlib import Path

from local_app.backend.api.master import MAX_MASTER_JSON_BYTES, _proposal_hash
from local_app.backend.app import create_app
from local_app.backend.master_store import MasterStore, master_bundle_content_hash


ORIGIN = "http://127.0.0.1:18765"
ROOT = Path(__file__).resolve().parents[2]


def make_bundle(*, name="검수 품목", created_at="2026-10-02T00:00:00.000Z", stable_id=None):
    stable_id = stable_id or str(uuid.uuid4())
    legacy = {"legacyNameKey": "legacy:item-1", "legacyKind": "MASTER_ITEM", "rawName": name,
              "tier": 1, "occurrences": [{"locator": "/masterData/1/0", "scope": "MASTER_TIER_1", "tier": 1}],
              "authorityStatus": "VERIFIED_CURATED"}
    entity = {"stableId": stable_id, "kind": "ITEM", "canonicalName": name,
              "displayNames": [{"text": name, "status": "VERIFIED_CURATED", "provenance": {"source": "owner"}}],
              "aliases": [], "legacyNames": [legacy], "tier": 1, "category": None,
              "status": "VERIFIED_CURATED", "provenance": {"note": "checked"}, "replacedBy": None}
    fields = {"createdAt": created_at, "entities": [entity],
              "compatibilityMappings": [{"stableId": stable_id, "legacyNameKeys": [legacy["legacyNameKey"]],
                                          "sourceLocators": ["/masterData/1/0"]}],
              "unresolvedLegacyNames": [], "sourceRevisions": [], "provenance": {"owner": "test"}}
    semantic = {"schemaVersion": 2, "entities": fields["entities"],
                "compatibilityMappings": fields["compatibilityMappings"], "unresolvedLegacyNames": [],
                "sourceRevisions": [], "provenance": fields["provenance"], "hashBasis": "MASTER_CANONICAL_JSON_V2"}
    digest = hashlib.sha256(json.dumps(semantic, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"schemaVersion": 2, "registryVersion": f"registry-v2:{digest}", **fields,
            "hashBasis": "MASTER_CANONICAL_JSON_V2", "contentHash": digest}


def db_snapshot(path):
    with closing(sqlite3.connect(path)) as connection:
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        return {table: connection.execute(f'SELECT * FROM "{table}"').fetchall() for table in tables}


class MasterApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.main_path = self.root / "main.sqlite3"
        self.sidecar_path = self.root / "recognition" / "recognition.sqlite3"
        self.master_path = self.root / "master" / "master.sqlite3"
        self.app = create_app(self.main_path, recognition_database_path=self.sidecar_path,
                              master_database_path=self.master_path, testing=False)
        self.client = self.app.test_client()
        self.headers = {"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"}

    def tearDown(self):
        self.temp.cleanup()

    def post(self, path, body, *, headers=None, content_type="application/json"):
        return self.client.post(path, base_url=ORIGIN, headers=headers or self.headers,
                                data=body if isinstance(body, (str, bytes)) else json.dumps(body, ensure_ascii=False),
                                content_type=content_type)

    def proposal(self, bundle, expected=None):
        return {"version": 1, "expectedRegistryVersion": expected, "bundle": bundle}

    def publish(self, bundle, proposal_hash, *, mutation=None, expected=None, owner=True):
        return {"version": 1, "mutationId": mutation or str(uuid.uuid4()),
                "expectedRegistryVersion": expected, "ownerApproved": owner,
                "proposalHash": proposal_hash, "bundle": bundle}

    def _reference_bundle(self):
        catalog_path = ROOT / "frontend" / "data" / "trade-catalog.json"
        manifest_path = ROOT / "frontend" / "data" / "trade-master-reference-manifest.json"
        registry_path = ROOT / "frontend" / "js" / "domain" / "trade-master-registry.js"
        master_path = ROOT / "frontend" / "js" / "domain" / "trade-master-bundle.js"
        script = f'''
          import fs from "node:fs";
          import {{ pathToFileURL }} from "node:url";
          const registry = await import(pathToFileURL({json.dumps(str(registry_path))}));
          const master = await import(pathToFileURL({json.dumps(str(master_path))}));
          const bytes = fs.readFileSync({json.dumps(str(catalog_path))});
          const catalog = JSON.parse(bytes.toString("utf8"));
          const sourceSha256 = await import("node:crypto").then((m) => m.createHash("sha256").update(bytes).digest("hex"));
          const snapshot = registry.adaptLegacyCatalog(catalog, {{sourceRevision:"api-reference-test-v1", sourceSha256}});
          const base = master.adaptRegistrySnapshotV1ToMasterBundleV2(snapshot, {{createdAt:"2026-10-02T07:20:43Z"}});
          const manifest = JSON.parse(fs.readFileSync({json.dumps(str(manifest_path))}, "utf8"));
          process.stdout.write(JSON.stringify(master.applyTradeMasterReferenceManifestToBundleV2(base, manifest, {{createdAt:"2026-10-02T07:20:43Z"}})));
        '''
        proc = subprocess.run(["node", "--input-type=module", "-e", script], text=True,
                              encoding="utf-8", capture_output=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def test_store_paths_are_separate_and_active_get_is_empty_read_only(self):
        self.assertNotEqual(self.main_path.resolve(), self.sidecar_path.resolve())
        self.assertNotEqual(self.main_path.resolve(), self.master_path.resolve())
        self.assertNotEqual(self.sidecar_path.resolve(), self.master_path.resolve())
        self.assertIsNotNone(self.app.extensions["master_store"])
        self.assertIsNone(self.app.extensions["master_store_error"])
        before_main, before_sidecar = db_snapshot(self.main_path), db_snapshot(self.sidecar_path)
        response = self.client.get("/api/master/active", base_url=ORIGIN)
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json(), {"ok": True, "storeRevision": 0, "activeRegistryVersion": None, "bundle": None})
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        self.assertEqual(self.app.extensions["master_store"].store_revision(), 0)
        self.assertEqual(db_snapshot(self.main_path), before_main)
        self.assertEqual(db_snapshot(self.sidecar_path), before_sidecar)

    def test_proposal_is_deterministic_cas_checked_and_has_zero_store_writes(self):
        bundle = make_bundle()
        payload = self.proposal(bundle)
        before = db_snapshot(self.master_path)
        first = self.post("/api/master/proposal", payload)
        second = self.post("/api/master/proposal", payload)
        self.assertEqual(first.status_code, 200, first.get_json())
        self.assertEqual(first.get_json(), second.get_json())
        self.assertEqual(first.get_json()["proposal"]["proposalHash"], _proposal_hash(None, bundle))
        self.assertEqual(db_snapshot(self.master_path), before)
        stale = self.post("/api/master/proposal", self.proposal(bundle, "registry-v2:" + "a" * 64))
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.get_json()["error"]["code"], "master_revision_conflict")
        self.assertEqual(db_snapshot(self.master_path), before)

    def test_reference_manifest_authority_is_enforced_at_proposal_and_temporary_publish(self):
        bundle = self._reference_bundle()
        before = db_snapshot(self.master_path)
        proposal_response = self.post("/api/master/proposal", self.proposal(bundle))
        self.assertEqual(proposal_response.status_code, 200, proposal_response.get_json())
        proposal = proposal_response.get_json()["proposal"]
        self.assertEqual(db_snapshot(self.master_path), before)

        # Re-hashing a modified candidate cannot make it authoritative. The API
        # checks content against the checked-in manifest, not just its hash.
        def reject_forgery(mutator):
            forged = copy.deepcopy(bundle)
            mutator(forged)
            forged["contentHash"] = master_bundle_content_hash(forged)
            forged["registryVersion"] = f"registry-v2:{forged['contentHash']}"
            response = self.post("/api/master/proposal", self.proposal(forged))
            self.assertEqual(response.status_code, 422, response.get_json())
            self.assertEqual(response.get_json()["error"]["code"], "invalid_master_bundle")
            self.assertEqual(db_snapshot(self.master_path), before)

        def reference_entity(candidate):
            return next(entity for entity in candidate["entities"] if entity["status"] == "VERIFIED_REFERENCE")

        def forge_status(candidate):
            reference_entity(candidate)["status"] = "MADE_UP_REFERENCE"

        def forge_source_url(candidate):
            reference_entity(candidate)["provenance"]["referenceEvidence"][0]["sourceUrl"] = "https://bdocodex.com/us/item/fake/"

        def forge_canonical(candidate):
            reference_entity(candidate)["canonicalName"] = "조작된 이름"

        def forge_stable_id(candidate):
            target = reference_entity(candidate)
            old_id = target["stableId"]
            new_id = str(uuid.uuid4())
            target["stableId"] = new_id
            for mapping in candidate["compatibilityMappings"]:
                if mapping["stableId"] == old_id:
                    mapping["stableId"] = new_id

        def forge_audit_hash(candidate):
            candidate["provenance"]["referenceAuditHash"] = "0" * 64

        for mutation in (forge_status, forge_source_url, forge_canonical, forge_stable_id, forge_audit_hash):
            reject_forgery(mutation)

        publish_body = self.publish(bundle, proposal["proposalHash"],
                                    mutation="b4f9d949-4778-47ba-b61d-3c2c35e04010", owner=True)
        saved = self.post("/api/master/publish", publish_body)
        self.assertEqual(saved.status_code, 200, saved.get_json())
        self.assertTrue(saved.get_json()["activated"])
        replay = self.post("/api/master/publish", publish_body)
        self.assertEqual(replay.status_code, 200, replay.get_json())
        self.assertEqual(replay.get_json(), saved.get_json())
        self.assertEqual(self.app.extensions["master_store"].get_active_bundle(), bundle)

    def test_publish_owner_proposal_first_save_pinned_read_and_exact_export(self):
        bundle = make_bundle()
        proposal = self.post("/api/master/proposal", self.proposal(bundle)).get_json()["proposal"]
        unapproved = self.post("/api/master/publish", self.publish(bundle, proposal["proposalHash"], owner="true"))
        self.assertEqual(unapproved.status_code, 422)
        wrong_hash = self.post("/api/master/publish", self.publish(bundle, "wrong"))
        self.assertEqual(wrong_hash.status_code, 422)
        saved = self.post("/api/master/publish", self.publish(bundle, proposal["proposalHash"], mutation="2bcb7340-0ae0-4ed4-b650-449bd0ec6430"))
        self.assertEqual(saved.status_code, 200, saved.get_json())
        receipt = saved.get_json()
        self.assertEqual(receipt["storeRevision"], 1)
        self.assertTrue(receipt["activated"])
        active = self.client.get("/api/master/active", base_url=ORIGIN).get_json()
        self.assertEqual(active["activeRegistryVersion"], bundle["registryVersion"])
        self.assertEqual(active["bundle"], bundle)
        pinned = self.client.get(f"/api/master/bundles/{bundle['registryVersion']}", base_url=ORIGIN)
        self.assertEqual(pinned.status_code, 200)
        self.assertEqual(pinned.get_json()["bundle"], bundle)
        exported = self.client.get(f"/api/master/bundles/{bundle['registryVersion']}/export", base_url=ORIGIN)
        self.assertEqual(exported.status_code, 200)
        self.assertIn("attachment;", exported.headers["Content-Disposition"])
        with closing(sqlite3.connect(self.master_path)) as connection:
            persisted = connection.execute("SELECT bundle_json FROM master_bundle WHERE registry_version=?", (bundle["registryVersion"],)).fetchone()[0]
        self.assertEqual(exported.data, persisted.encode("utf-8"))
        missing = self.client.get("/api/master/bundles/registry-v2:missing", base_url=ORIGIN)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.get_json()["error"]["code"], "master_bundle_not_found")

    def test_idempotent_retry_conflict_stale_publish_and_store_isolation(self):
        main_before, sidecar_before = db_snapshot(self.main_path), db_snapshot(self.sidecar_path)
        a = make_bundle()
        proposal_a = self.post("/api/master/proposal", self.proposal(a)).get_json()["proposal"]
        mutation_id = "2bcb7340-0ae0-4ed4-b650-449bd0ec6430"
        first_body = self.publish(a, proposal_a["proposalHash"], mutation=mutation_id)
        first = self.post("/api/master/publish", first_body)
        replay = self.post("/api/master/publish", first_body)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(replay.get_json(), first.get_json())
        changed_body = dict(first_body, bundle=make_bundle(created_at="2026-10-03T00:00:00.000Z",
                                                         stable_id=a["entities"][0]["stableId"]))
        conflict = self.post("/api/master/publish", changed_body)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.get_json()["error"]["code"], "master_mutation_conflict")
        b = make_bundle(name="두 번째")
        stale_payload = self.publish(b, _proposal_hash(None, b), mutation=str(uuid.uuid4()), expected=None)
        stale = self.post("/api/master/publish", stale_payload)
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.get_json()["error"]["code"], "master_revision_conflict")
        self.assertIsNone(self.app.extensions["master_store"].get_bundle(b["registryVersion"]))
        self.assertEqual(db_snapshot(self.main_path), main_before)
        self.assertEqual(db_snapshot(self.sidecar_path), sidecar_before)

    def test_bounded_utf8_json_unknown_keys_and_media_errors(self):
        valid_json = json.dumps(self.proposal(make_bundle()), ensure_ascii=False)
        bad_type = self.post("/api/master/proposal", valid_json, content_type="text/plain")
        self.assertEqual(bad_type.status_code, 415)
        compressed = self.post("/api/master/proposal", valid_json, headers={**self.headers, "Content-Encoding": "gzip"})
        self.assertEqual(compressed.status_code, 415)
        bad_json = self.post("/api/master/proposal", b"{", content_type="application/json")
        self.assertEqual(bad_json.status_code, 400)
        invalid_utf8 = self.post("/api/master/proposal", b"\xff", content_type="application/json")
        self.assertEqual(invalid_utf8.status_code, 400)
        unknown = self.post("/api/master/proposal", {"version": 1, "expectedRegistryVersion": None,
            "bundle": make_bundle(), "surprise": True})
        self.assertEqual(unknown.status_code, 422)
        duplicate_keys = self.post("/api/master/proposal", '{"version":1,"version":1}', content_type="application/json")
        self.assertEqual(duplicate_keys.status_code, 400)
        too_large = self.post("/api/master/proposal", b" " * (MAX_MASTER_JSON_BYTES + 1), content_type="application/json")
        self.assertEqual(too_large.status_code, 413)
        invalid = make_bundle()
        invalid["contentHash"] = "0" * 64
        invalid_bundle = self.post("/api/master/proposal", self.proposal(invalid))
        self.assertEqual(invalid_bundle.status_code, 422)
        self.assertEqual(invalid_bundle.get_json()["error"]["code"], "invalid_master_bundle")

    def test_same_origin_gate_host_preflight_and_shutdown_counter(self):
        bundle = make_bundle()
        missing = self.client.post("/api/master/proposal", base_url=ORIGIN, json=self.proposal(bundle))
        self.assertEqual(missing.status_code, 403)
        cross = self.client.post("/api/master/proposal", base_url=ORIGIN,
                                 headers={"Origin": "http://evil.example", "Sec-Fetch-Site": "cross-site"},
                                 json=self.proposal(bundle))
        self.assertEqual(cross.status_code, 403)
        bad_site = self.client.post("/api/master/proposal", base_url=ORIGIN,
                                    headers={"Origin": ORIGIN, "Sec-Fetch-Site": "same-site"}, json=self.proposal(bundle))
        self.assertEqual(bad_site.status_code, 403)
        preflight = self.client.options("/api/master/proposal", base_url=ORIGIN, headers={"Origin": "http://evil.example"})
        self.assertEqual(preflight.status_code, 403)
        self.assertNotIn("Access-Control-Allow-Origin", preflight.headers)
        invalid_host = self.client.get("/api/master/active", base_url=ORIGIN, headers={"Host": "evil.example"})
        self.assertEqual(invalid_host.status_code, 400)
        state = self.app.extensions["bdo_mutation_state"]
        self.assertEqual(state["active"], 0)

    def test_master_store_unavailable_does_not_break_app_or_touch_main(self):
        same_path = self.root / "same.sqlite3"
        app = create_app(same_path, recognition_database_path=self.root / "separate-rec.sqlite3",
                         master_database_path=same_path, testing=False)
        client = app.test_client()
        self.assertIsNone(app.extensions["master_store"])
        self.assertEqual(app.extensions["master_store_error"], "DatabasePathMustBeSeparate")
        before = db_snapshot(same_path)
        self.assertEqual(client.get("/api/bootstrap", base_url=ORIGIN).status_code, 200)
        response = client.get("/api/master/active", base_url=ORIGIN)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["error"]["code"], "master_store_unavailable")
        self.assertEqual(db_snapshot(same_path), before)


if __name__ == "__main__":
    unittest.main()
