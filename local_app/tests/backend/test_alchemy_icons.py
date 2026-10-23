from hashlib import sha256
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

from alchemy.catalog import AlchemyError, load_catalog, validate_catalog
from local_app.backend.app import create_app


class AlchemyIconTests(unittest.TestCase):
    def test_every_catalog_item_has_a_decodable_local_icon_with_traceable_source(self):
        root = Path(__file__).resolve().parents[3] / "alchemy"
        catalog = load_catalog()
        manifest = json.loads((root / "data/icon-sources.json").read_text(encoding="utf-8"))
        sources = {row["item_id"]: row for row in manifest["items"]}
        self.assertEqual(set(sources), {item["item_id"] for item in catalog["items"]})
        with tempfile.TemporaryDirectory(prefix="bdo-icons-") as temporary:
            client = create_app(Path(temporary) / "barter.sqlite3", testing=True).test_client()
            for item in catalog["items"]:
                with self.subTest(item=item["name"]):
                    source = sources[item["item_id"]]
                    path = root / "frontend" / item["icon"]
                    self.assertEqual(source["matched_name"], item["name"])
                    self.assertEqual(source["file"], item["icon"])
                    self.assertTrue(source["source_page"].startswith("https://"))
                    self.assertTrue(source["source_image"].startswith("https://"))
                    self.assertEqual(sha256(path.read_bytes()).hexdigest(), source["sha256"])
                    with Image.open(path) as image:
                        image.load()
                        self.assertEqual(image.size, (source["width"], source["height"]))
                        self.assertGreaterEqual(min(image.size), 16)
                    with client.get("/alchemy/assets/" + item["icon"]) as response:
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(response.data, path.read_bytes())
            self.assertFalse((Path(temporary) / "barter.sqlite3").exists())
            self.assertFalse((Path(temporary) / "alchemy.sqlite3").exists())

    def test_imported_icons_cannot_load_remote_or_traversal_paths(self):
        for path in ("https://example.com/a.png", "../a.png", "icons/a.svg", "icons/a.png?x=1"):
            with self.subTest(path=path):
                catalog = load_catalog()
                catalog["items"][0]["icon"] = path
                with self.assertRaises(AlchemyError):
                    validate_catalog(catalog)
