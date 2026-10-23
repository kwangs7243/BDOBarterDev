"""Barter page and its existing asset URLs."""
from flask import Blueprint

barter_pages = Blueprint("barter", __name__, static_folder="frontend", static_url_path="/assets")


@barter_pages.get("/barter/", strict_slashes=False)
def index():
    return barter_pages.send_static_file("index.html")
