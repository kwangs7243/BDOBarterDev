from pathlib import Path
import tempfile
import unittest

from local_app.backend.app import create_app


class PortalTests(unittest.TestCase):
    def test_workspace_pages_and_assets_preserve_barter_state(self):
        with tempfile.TemporaryDirectory(prefix="bdo-portal-") as temporary:
            database = Path(temporary) / "isolated.sqlite3"
            client = create_app(database, testing=True).test_client()
            before = client.get("/api/bootstrap").get_json()
            for path, marker in (
                ("/", "모험의 다음 장을"),
                ("/barter/", 'id="trade-session-panel"'),
                ("/barter", 'id="trade-session-panel"'),
                ("/alchemy/", "제작 작업실"),
                ("/alchemy", "제작 작업실"),
                ("/portal-assets/portal.css", ".workspace-grid"),
                ("/portal-assets/horizon.svg", "<svg"),
                ("/assets/js/state.js", "state"),
                ("/alchemy/assets/alchemy.css", ".tree-node"),
            ):
                with self.subTest(path=path), client.get(path) as response:
                    self.assertEqual(response.status_code, 200)
                    self.assertIn(marker, response.get_data(as_text=True))
            self.assertEqual(client.get("/api/bootstrap").get_json(), before)
            restarted = create_app(database, testing=True).test_client()
            self.assertEqual(restarted.get("/api/bootstrap").get_json(), before)

    def test_workspace_routes_keep_local_host_restriction(self):
        with tempfile.TemporaryDirectory(prefix="bdo-portal-origin-") as temporary:
            client = create_app(Path(temporary) / "isolated.sqlite3", testing=True).test_client()
            for path in ("/", "/barter/", "/alchemy/", "/portal-assets/portal.css"):
                with self.subTest(path=path):
                    self.assertEqual(client.get(path, base_url="http://example.com").status_code, 400)
