import io
import json
import sqlite3
import tempfile
import threading
import time
import unittest
import uuid
from contextlib import closing
from pathlib import Path

from PIL import Image

from local_app.backend.app import create_app
from local_app.backend.recognition_contracts import UNSUPPORTED_FLAGS


ORIGIN = "http://127.0.0.1:18765"


def png_bytes(color=(40, 50, 60, 255)):
    output = io.BytesIO()
    Image.new("RGBA", (4, 3), color).save(output, format="PNG")
    return output.getvalue()


def metadata(capture_id=None):
    return {"version": 1, "captureId": capture_id or str(uuid.uuid4()), "batchId": None,
            "taskType": "warehouse", "sourceType": "file", "capturedAt": "2026-09-28T12:00:00Z",
            "frame": {"width": 4, "height": 3},
            "fidelity": {"sourceWidth": None, "sourceHeight": None, "rescaled": None, "evidence": "unknown"},
            "profileId": None, "profileVersion": 1,
            "context": {"baseRevision": 0, "sessionId": None, "sessionRevision": None},
            "observed": {"browserDpr": None, "windowsDpi": None, "gameResolution": None, "gameUiScale": None}}


def main_snapshot(path):
    with closing(sqlite3.connect(path)) as connection, connection:
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        return {table: sorted(connection.execute(f'SELECT * FROM "{table}"').fetchall(), key=repr) for table in tables}


class RecognitionSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.main_path = self.root / "main.sqlite3"
        self.sidecar_path = self.root / "recognition" / "recognition.sqlite3"
        self.app = create_app(self.main_path, recognition_database_path=self.sidecar_path, testing=False)
        self.client = self.app.test_client()
        self.same_origin = {"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"}

    def tearDown(self):
        self.temp.cleanup()

    def put_config(self, *, origin=True, flags=None, revision=0, headers=None, content_type=None):
        payload = {"version": 1, "expectedConfigRevision": revision,
                   "flags": flags or {key: False for key in UNSUPPORTED_FLAGS}, "profiles": []}
        merged = dict(self.same_origin if origin else {})
        if headers:
            merged.update(headers)
        kwargs = {"json": payload} if content_type is None else {"data": json.dumps(payload), "content_type": content_type}
        return self.client.put("/api/recognition/config", base_url=ORIGIN, headers=merged, **kwargs)

    def post_capture(self, metadata_value, image=None, *, origin=True, content_type=None, extra=None):
        data = {"metadata": json.dumps(metadata_value)}
        if image is not None:
            data["image"] = (io.BytesIO(image), "C:\\private\\user-capture.png", content_type or "image/png")
        if extra:
            data.update(extra)
        return self.client.post("/api/recognition/warehouse", base_url=ORIGIN,
                                headers=self.same_origin if origin else {}, data=data)

    def test_recognition_config_cas_and_unsupported_flags(self):
        before = main_snapshot(self.main_path)
        response = self.client.get("/api/recognition/config", base_url=ORIGIN)
        self.assertEqual(response.status_code, 200)
        config = response.get_json()["config"]
        self.assertEqual(config["configRevision"], 0)
        self.assertFalse(config["policy"]["releaseApproved"])
        self.assertEqual(config["policy"]["allowedStrata"], [])
        saved = self.put_config()
        self.assertEqual(saved.status_code, 200, saved.get_json())
        self.assertEqual(saved.get_json()["config"]["configRevision"], 1)
        stale = self.put_config(revision=0)
        self.assertEqual(stale.status_code, 409)
        enabled = {key: False for key in UNSUPPORTED_FLAGS}
        enabled["autoApply"] = True
        unsupported = self.put_config(revision=1, flags=enabled)
        self.assertEqual(unsupported.status_code, 422)
        self.assertEqual(main_snapshot(self.main_path), before)

    def test_exact_origin_fetch_metadata_host_and_preflight_guards(self):
        for origin_value in (None, "null", "http://evil.example"):
            headers = {} if origin_value is None else {"Origin": origin_value}
            response = self.put_config(origin=False, headers=headers)
            self.assertEqual(response.status_code, 403)
        for site in ("cross-site", "same-site", "none"):
            response = self.put_config(headers={"Sec-Fetch-Site": site})
            self.assertEqual(response.status_code, 403)
        mismatched_alias = self.client.put("/api/recognition/config", base_url="http://localhost:18765",
                                           headers={"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"},
                                           json={"version": 1, "expectedConfigRevision": 0,
                                                 "flags": {key: False for key in UNSUPPORTED_FLAGS}, "profiles": []})
        self.assertEqual(mismatched_alias.status_code, 403)
        spoofed = self.client.get("/api/recognition/config", base_url=ORIGIN, headers={"Host": "evil.example"})
        self.assertEqual(spoofed.status_code, 400)
        preflight = self.client.options("/api/recognition/config", base_url=ORIGIN,
                                        headers={"Origin": "http://127.0.0.1:18766", "Sec-Fetch-Site": "same-site"})
        self.assertEqual(preflight.status_code, 403)
        self.assertNotIn("Access-Control-Allow-Origin", preflight.headers)
        self.assertEqual(self.app.extensions["recognition_store"].get_config()["configRevision"], 0)

    def test_json_content_type_and_multipart_contract_fail_before_sidecar_or_main_write(self):
        before = main_snapshot(self.main_path)
        bad_json_type = self.put_config(content_type="text/plain", headers=self.same_origin)
        self.assertEqual(bad_json_type.status_code, 415)
        wrong_capture_type = self.post_capture(metadata(), png_bytes(), content_type="image/jpeg")
        self.assertEqual(wrong_capture_type.status_code, 415)
        spoofed_png = self.post_capture(metadata(), b"not a png")
        self.assertEqual(spoofed_png.status_code, 422)
        oversized_image = self.post_capture(metadata(), b"x" * (20 * 1024 * 1024 + 1))
        self.assertEqual(oversized_image.status_code, 413)
        mismatch = metadata()
        mismatch["frame"]["width"] = 99
        bad_dimensions = self.post_capture(mismatch, png_bytes())
        self.assertEqual(bad_dimensions.status_code, 422)
        duplicate = self.post_capture(metadata(), png_bytes(), extra={"image": [
            (io.BytesIO(png_bytes()), "one.png", "image/png"), (io.BytesIO(png_bytes()), "two.png", "image/png")
        ]})
        self.assertEqual(duplicate.status_code, 422)
        oversized = metadata()
        oversized["unused"] = "x" * (64 * 1024)
        too_large_metadata = self.post_capture(oversized, png_bytes())
        self.assertEqual(too_large_metadata.status_code, 413)
        with closing(sqlite3.connect(self.sidecar_path)) as connection, connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM recognition_run").fetchone()[0], 0)
        self.assertEqual(main_snapshot(self.main_path), before)

    def test_valid_capture_is_hash_only_unsupported_run_and_main_db_is_unchanged(self):
        before = main_snapshot(self.main_path)
        image = png_bytes()
        capture = metadata()
        first = self.post_capture(capture, image)
        self.assertEqual(first.status_code, 501, first.get_json())
        body = first.get_json()
        self.assertEqual(body["error"]["code"], "unsupported_feature")
        run_id = body["recognitionId"]
        saved = self.client.get(f"/api/recognition/{run_id}", base_url=ORIGIN).get_json()["run"]
        self.assertEqual(saved["runState"], "UNSUPPORTED_FEATURE")
        self.assertEqual(saved["report"]["automationEligible"], False)
        self.assertNotIn("C:\\private", json.dumps(saved))
        self.assertNotIn(image, self.sidecar_path.read_bytes())
        replay = self.post_capture(capture, image)
        self.assertEqual(replay.status_code, 501)
        self.assertTrue(replay.get_json()["duplicate"])
        conflict = self.post_capture(capture, png_bytes((1, 2, 3, 255)))
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(self.client.get("/api/recognition/config", base_url=ORIGIN).status_code, 200)
        self.assertEqual(main_snapshot(self.main_path), before)
        with closing(sqlite3.connect(self.main_path)) as connection, connection:
            self.assertEqual(connection.execute("SELECT schema_version FROM app_meta WHERE id=1").fetchone()[0], 3)

    def test_feedback_receipt_and_unsupported_apply_never_touch_main_db(self):
        before = main_snapshot(self.main_path)
        capture = self.post_capture(metadata(), png_bytes()).get_json()
        run_id = capture["recognitionId"]
        mutation_id = str(uuid.uuid4())
        payload = {"version": 1, "labelMutationId": mutation_id, "rows": [
            {"unitId": "R1C1", "fields": {"quantity": {"value": 0, "verification": "explicit", "reason": "confirmed"}}}
        ]}
        saved = self.client.post(f"/api/recognition/{run_id}/feedback", base_url=ORIGIN,
                                 headers=self.same_origin, json=payload)
        self.assertEqual(saved.status_code, 200, saved.get_json())
        duplicate = self.client.post(f"/api/recognition/{run_id}/feedback", base_url=ORIGIN,
                                     headers=self.same_origin, json=payload)
        self.assertTrue(duplicate.get_json()["duplicate"])
        conflict_payload = {**payload, "rows": [{"unitId": "R1C1", "fields": {
            "quantity": {"value": 1, "verification": "explicit", "reason": "changed"}}}]}
        conflict = self.client.post(f"/api/recognition/{run_id}/feedback", base_url=ORIGIN,
                                    headers=self.same_origin, json=conflict_payload)
        self.assertEqual(conflict.status_code, 409)
        apply = self.client.post(f"/api/recognition/{run_id}/apply", base_url=ORIGIN,
                                 headers=self.same_origin, json={"version": 1})
        self.assertEqual(apply.status_code, 501)
        missing_origin = self.client.post(f"/api/recognition/{run_id}/feedback", base_url=ORIGIN, json=payload)
        self.assertEqual(missing_origin.status_code, 403)
        self.assertEqual(main_snapshot(self.main_path), before)

    def test_working_session_requires_exact_origin_and_valid_v1_save_still_works(self):
        body = {"mutationId": str(uuid.uuid4()), "baseRevision": 0}
        missing = self.client.delete("/api/working-session", base_url=ORIGIN, json=body)
        self.assertEqual(missing.status_code, 403)
        saved = self.client.delete("/api/working-session", base_url=ORIGIN, headers=self.same_origin, json=body)
        self.assertEqual(saved.status_code, 200, saved.get_json())
        self.assertEqual(saved.get_json(), {"ok": True, "revision": 1, "idempotent": False})

    def test_sidecar_unavailable_or_future_schema_does_not_break_v1(self):
        blocked_parent = self.root / "file-parent"
        blocked_parent.write_text("not a directory", encoding="utf-8")
        app = create_app(self.root / "main-unavailable.sqlite3",
                         recognition_database_path=blocked_parent / "recognition.sqlite3", testing=False)
        client = app.test_client()
        self.assertEqual(client.get("/api/bootstrap", base_url=ORIGIN).status_code, 200)
        self.assertEqual(client.get("/api/recognition/config", base_url=ORIGIN).status_code, 503)

        future_path = self.root / "future-sidecar.sqlite3"
        with closing(sqlite3.connect(future_path)) as connection, connection:
            connection.execute("CREATE TABLE recognition_meta(id INTEGER PRIMARY KEY, schema_version INTEGER)")
            connection.execute("INSERT INTO recognition_meta VALUES (1, 99)")
        future_app = create_app(self.root / "main-future.sqlite3", recognition_database_path=future_path, testing=False)
        future_client = future_app.test_client()
        self.assertEqual(future_client.get("/api/bootstrap", base_url=ORIGIN).status_code, 200)
        self.assertEqual(future_client.get("/api/recognition/config", base_url=ORIGIN).status_code, 503)

    def test_recognition_requests_join_shutdown_drain_and_close_store(self):
        entered, release, get_done, shutdown_done = (threading.Event() for _ in range(4))
        store = self.app.extensions["recognition_store"]
        original_get_config = store.get_config

        def slow_get_config():
            entered.set()
            release.wait(timeout=5)
            return original_get_config()

        store.get_config = slow_get_config
        responses = {}

        def get_request():
            responses["get"] = self.app.test_client().get("/api/recognition/config", base_url=ORIGIN)
            get_done.set()

        def shutdown_request():
            responses["shutdown"] = self.app.test_client().post("/api/app/shutdown", base_url=ORIGIN)
            shutdown_done.set()

        get_thread = threading.Thread(target=get_request)
        get_thread.start()
        self.assertTrue(entered.wait(timeout=2))
        shutdown_thread = threading.Thread(target=shutdown_request)
        shutdown_thread.start()
        time.sleep(0.1)
        self.assertFalse(shutdown_done.is_set())
        release.set()
        get_thread.join(timeout=5)
        shutdown_thread.join(timeout=5)
        self.assertTrue(get_done.is_set())
        self.assertEqual(responses["get"].status_code, 200)
        self.assertEqual(responses["shutdown"].status_code, 200)
        self.assertTrue(self.app.extensions["bdo_shutdown_complete"].wait(timeout=2))
        with self.assertRaises(Exception):
            original_get_config()


if __name__ == "__main__":
    unittest.main()
