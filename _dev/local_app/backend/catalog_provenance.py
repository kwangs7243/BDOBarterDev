"""Cross-platform text digest for the trade catalog source."""

from __future__ import annotations

import hashlib
import json
from typing import Any


CATALOG_PROVENANCE_SCHEMA_VERSION = 2
CATALOG_PROVENANCE_HASH_BASIS = "CATALOG_UTF8_CRLF_TO_LF_V2"
_FIELDS = {"masterData", "specialItems", "islands", "t6Islands", "t7Islands"}
_TIERS = {str(value) for value in range(1, 8)}


def _nonempty_js_string(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    # Match ECMAScript String.prototype.trim whitespace for the registry's
    # existing nonempty-string catalog rule.
    return bool(value.strip("\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"))


def validate_catalog_shape(catalog: Any) -> None:
    if not isinstance(catalog, dict) or set(catalog) != _FIELDS:
        raise ValueError("catalog must contain only masterData, specialItems, islands, t6Islands, and t7Islands")
    master_data = catalog["masterData"]
    if not isinstance(master_data, dict) or set(master_data) != _TIERS:
        raise ValueError("catalog.masterData must contain tiers 1 through 7")
    arrays = [(f"masterData/{tier}", master_data[tier]) for tier in sorted(_TIERS, key=int)]
    arrays.extend((name, catalog[name]) for name in ("specialItems", "islands", "t6Islands", "t7Islands"))
    for label, values in arrays:
        if not isinstance(values, list):
            raise ValueError(f"catalog.{label} must be an array")
        for index, value in enumerate(values):
            if not _nonempty_js_string(value):
                raise ValueError(f"catalog.{label}[{index}] must be a nonempty string")


def compute_catalog_provenance_v2(raw_bytes: bytes) -> dict[str, Any]:
    if not isinstance(raw_bytes, bytes):
        raise TypeError("catalog source must be bytes")
    if raw_bytes.startswith(b"\xef\xbb\xbf"):
        raise ValueError("catalog UTF-8 BOM is not permitted")
    text = raw_bytes.decode("utf-8", errors="strict")
    normalized_text = text.replace("\r\n", "\n")
    if "\r" in normalized_text:
        raise ValueError("catalog contains a standalone CR byte")

    def reject_constant(value: str) -> None:
        raise ValueError(f"catalog JSON constant {value} is not permitted")

    catalog = json.loads(normalized_text, parse_constant=reject_constant)
    validate_catalog_shape(catalog)
    digest = hashlib.sha256(normalized_text.encode("utf-8", errors="strict")).hexdigest()
    return {"schemaVersion": CATALOG_PROVENANCE_SCHEMA_VERSION,
            "hashBasis": CATALOG_PROVENANCE_HASH_BASIS,
            "sha256": digest, "catalog": catalog}
