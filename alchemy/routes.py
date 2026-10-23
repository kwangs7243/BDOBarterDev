"""Independent alchemy pages sharing a small client entry point."""
from pathlib import Path
import re
from flask import Blueprint, request

alchemy_pages = Blueprint("alchemy", __name__, url_prefix="/alchemy", static_folder="frontend", static_url_path="/assets")


@alchemy_pages.get("/", strict_slashes=False)
@alchemy_pages.get("/inventory")
@alchemy_pages.get("/history")
@alchemy_pages.get("/settings")
@alchemy_pages.get("/recipes/<item_id>")
def index(item_id=None):
    return alchemy_pages.send_static_file("index.html")


@alchemy_pages.before_request
def legacy_icon_path():
    if request.endpoint != "alchemy.static":
        return None
    filename = (request.view_args or {}).get("filename", "")
    match = re.fullmatch(r"icons/(i-[0-9a-f]{12})\.png", filename)
    if match and not (Path(alchemy_pages.static_folder) / filename).is_file():
        canonical = f"icons/{match[1]}.webp"
        if (Path(alchemy_pages.static_folder) / canonical).is_file():
            response = alchemy_pages.send_static_file(canonical)
            response.mimetype = "image/webp"
            return response
    return None


@alchemy_pages.after_request
def icon_content_type(response):
    filename = (request.view_args or {}).get("filename", "")
    if request.endpoint == "alchemy.static" and filename.endswith(".webp") and response.status_code in {200, 206, 304}:
        response.mimetype = "image/webp"
    return response
