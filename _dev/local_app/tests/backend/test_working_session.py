from copy import deepcopy
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from local_app.backend.app import create_app


class WorkingSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bdo-spec007-")
        self.path = Path(self.temp.name) / "isolated.sqlite3"
        self.app = create_app(self.path, testing=True)
        self.client = self.app.test_client()
        self.origin = "http://127.0.0.1:18765"
        self.sequence = 0

    def tearDown(self):
        self.temp.cleanup()

    def bootstrap(self):
        return self.client.get("/api/bootstrap", base_url=self.origin).get_json()

    def send(self, method, path, payload=None, *, revision=None, mutation=None):
        self.sequence += 1
        body = {"mutationId": mutation or f"test-{self.sequence}", "baseRevision": self.bootstrap()["revision"] if revision is None else revision, **(payload or {})}
        headers = {"Origin": self.origin, "Sec-Fetch-Site": "same-origin"}
        return self.client.open(path, method=method, json=body, base_url=self.origin, headers=headers), body

    def session(self):
        settings = self.bootstrap()["settings"]
        return {
            "version": 1, "id": "session-a",
            "scannedTrades": [{"island": "베이루와 섬", "fromItem": "갈퀴 꽃 씨앗 주머니", "toItem": "괴생물 촉수", "reqAmount": 1, "count": 3, "yield": 3, "disabled": False, "deleted": False}],
            "schedule": {"speed": [{"trades": [{"island": "베이루와 섬", "originalIndex": 0, "execC": 3, "completed": False, "timerActive": True, "timerEnd": 9999999999999}], "reqItems": {}}], "balance": []},
            "completed": None, "remainingParley": 1500000,
            "config": {key: settings[key] for key in ("ship", "parley", "tuning")},
            "selection": {"briefMode": "speed", "selectedScheduleSlot": 1},
            "diagnostics": {"generatedAt": 123, "engineDebug": {"reason": "test"}},
        }

    def save(self, session):
        response, _ = self.send("PUT", "/api/working-session", {"session": session})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

    def test_working_snapshot_and_slots_survive_a_fresh_process(self):
        session = self.session()
        self.save(session)
        response, _ = self.send("PUT", "/api/schedule-slots/1", {"snapshot": {"version": 1, "createdAt": 456, "session": session}})
        self.assertEqual(response.status_code, 200)
        code = "from local_app.backend.app import create_app; import json,sys; print(json.dumps(create_app(sys.argv[1], testing=True).extensions['bdo_storage'].bootstrap(),ensure_ascii=False))"
        result = subprocess.run([sys.executable, "-X", "utf8", "-c", code, str(self.path)], capture_output=True, text=True, encoding="utf-8", check=True)
        snapshot = json.loads(result.stdout)
        self.assertEqual(snapshot["workingSession"]["scannedTrades"], session["scannedTrades"])
        self.assertEqual(snapshot["workingSession"]["config"], session["config"])
        self.assertEqual(snapshot["scheduleSlots"]["1"]["session"]["diagnostics"], session["diagnostics"])
        trade = snapshot["workingSession"]["schedule"]["speed"][0]["trades"][0]
        self.assertNotIn("timerActive", trade)
        self.assertNotIn("timerEnd", trade)

    def test_reset_keeps_durable_data_and_other_slots(self):
        session = self.session()
        self.save(session)
        for slot in (1, 2):
            response, _ = self.send("PUT", f"/api/schedule-slots/{slot}", {"snapshot": {"version": 1, "createdAt": slot, "session": session}})
            self.assertEqual(response.status_code, 200)
        before = self.bootstrap()
        response, _ = self.send("DELETE", "/api/working-session")
        self.assertEqual(response.status_code, 200)
        after = self.bootstrap()
        self.assertIsNone(after["workingSession"])
        self.assertEqual(after["settings"], before["settings"])
        self.assertEqual(after["inventory"], before["inventory"])
        self.assertEqual(after["scheduleSlots"], before["scheduleSlots"])
        response, _ = self.send("DELETE", "/api/schedule-slots/1")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(self.bootstrap()["scheduleSlots"]["1"])
        self.assertEqual(self.bootstrap()["scheduleSlots"]["2"], before["scheduleSlots"]["2"])

    def completion(self):
        session = self.session()
        self.save(session)
        session["scannedTrades"][0]["count"] = 0
        session["scannedTrades"][0]["deleted"] = True
        session["remainingParley"] -= 32919
        session["schedule"]["speed"][0]["trades"][0]["completed"] = True
        return {"kind": "completion", "patch": {"items": {"갈퀴 꽃 씨앗 주머니": {"stock": 97}, "괴생물 촉수": {"stock": 9}}}, "session": session, "sessionRevision": self.bootstrap()["sessionRevision"]}

    def test_atomic_completion_and_replay_after_later_mutation(self):
        payload = self.completion()
        response, body = self.send("POST", "/api/working-session/completion", payload, mutation="one-completion")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        after = self.bootstrap()
        self.assertTrue(after["workingSession"]["schedule"]["speed"][0]["trades"][0]["completed"])
        self.assertEqual(after["workingSession"]["remainingParley"], 1467081)
        self.send("PATCH", "/api/inventory", {"kind": "manual", "patch": {"items": {"괴생물 촉수": {"stock": 15}}}})
        replay = self.client.post("/api/working-session/completion", json=body, base_url=self.origin,
                                  headers={"Origin": self.origin, "Sec-Fetch-Site": "same-origin"})
        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.get_json()["idempotent"])
        self.assertEqual(next(row["stock"] for row in self.bootstrap()["inventory"] if row["programName"] == "괴생물 촉수"), 15)
        self.assertEqual(self.bootstrap()["workingSession"], after["workingSession"])

    def test_completion_rollback_keeps_inventory_and_working_snapshot(self):
        payload = self.completion()
        before = self.bootstrap()
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("CREATE TRIGGER fail_session BEFORE UPDATE ON working_session BEGIN SELECT RAISE(ABORT, 'test failure'); END")
            db.commit()
        response, _ = self.send("POST", "/api/working-session/completion", payload)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.bootstrap(), before)

    def test_no_inventory_change_still_persists_completed_trade(self):
        payload = self.completion()
        payload["patch"] = {"items": {}}
        response, _ = self.send("POST", "/api/working-session/completion", payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.bootstrap()["workingSession"]["scannedTrades"][0]["count"], 0)

    def test_changed_session_or_stale_revision_cannot_be_overwritten(self):
        payload = self.completion()
        changed = self.session()
        changed["remainingParley"] = 999
        self.save(changed)
        before = self.bootstrap()
        response, _ = self.send("POST", "/api/working-session/completion", payload)
        self.assertEqual(response.status_code, 409)
        response, _ = self.send("PUT", "/api/working-session", {"session": self.session()}, revision=0)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.bootstrap(), before)

    def test_invalid_snapshot_slot_and_endpoint_id_reuse_are_atomic(self):
        session = self.session()
        for change in ({"version": True}, {"remainingParley": True}, {"timers": {}}, {"selection": {"drag": 1}}):
            response, _ = self.send("PUT", "/api/working-session", {"session": {**session, **change}})
            self.assertEqual(response.status_code, 422)
        snapshot = {"version": 1, "createdAt": 123, "session": session}
        response, _ = self.send("PUT", "/api/schedule-slots/6", {"snapshot": snapshot})
        self.assertEqual(response.status_code, 422)
        response, _ = self.send("PUT", "/api/schedule-slots/1", {"snapshot": snapshot}, mutation="slot-reuse")
        self.assertEqual(response.status_code, 200)
        response, _ = self.send("PUT", "/api/schedule-slots/2", {"snapshot": snapshot}, mutation="slot-reuse")
        self.assertEqual(response.status_code, 409)
        self.assertIsNone(self.bootstrap()["scheduleSlots"]["2"])


    def test_future_schema_is_refused_without_reset(self):
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("UPDATE app_meta SET schema_version = 99")
            db.commit()
        with self.assertRaises(RuntimeError):
            self.app.extensions["bdo_storage"].initialize()
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute("SELECT schema_version FROM app_meta").fetchone()[0], 99)

    def test_receipts_are_bounded_and_both_mode_restores(self):
        session = self.session()
        session["selection"]["briefMode"] = "both"
        for index in range(130):
            session["remainingParley"] = 1500000 - index
            self.save(session)
        self.assertEqual(self.bootstrap()["workingSession"]["selection"]["briefMode"], "both")
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM mutation_receipt").fetchone()[0], 128)
            self.assertEqual(db.execute("SELECT count(*) FROM working_session").fetchone()[0], 1)
