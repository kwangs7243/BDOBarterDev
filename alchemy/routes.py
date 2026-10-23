"""Independent alchemy pages sharing a small client entry point."""
from flask import Blueprint

alchemy_pages = Blueprint("alchemy", __name__, url_prefix="/alchemy", static_folder="frontend", static_url_path="/assets")


@alchemy_pages.get("/", strict_slashes=False)
@alchemy_pages.get("/inventory")
@alchemy_pages.get("/history")
@alchemy_pages.get("/settings")
@alchemy_pages.get("/recipes/<item_id>")
def index(item_id=None):
    return alchemy_pages.send_static_file("index.html")
