from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


KINDS = ("YIELD_23", "YIELD_BLACKSTONE", "NAME_ISLAND", "NAME_FROM_ITEM", "NAME_TO_ITEM")
REASONS = (
    "LAYOUT_UNSUPPORTED", "ANCHOR_UNCERTAIN", "COVERAGE_SUSPECT", "CONTEXT_UNCERTAIN",
    "RULE_ALREADY_FIXED", "NO_REFERENCE", "CROP_INCOMPLETE", "AMBIGUOUS_REFERENCE",
    "NO_EXACT_MATCH", "GLYPH_UNCERTAIN", "CALIBRATION_DISABLED", "DISTANCE_REJECTED",
    "MARGIN_REJECTED", "OUT_OF_CATALOG", "TEMPLATE_ERROR",
)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


@dataclass(frozen=True)
class LayoutProbe:
    valid: bool
    offset_x: int | None
    anchor_supports: tuple[float, ...]
    reason: str | None = None


@dataclass(frozen=True)
class TemplateMatch:
    status: str
    value: Any = None
    reference_ids: tuple[str, ...] = ()
    method: str | None = None
    score: float | None = None
    margin: float | None = None
    matched_box: dict[str, int] | None = None
    reason: str | None = None
    timings: dict[str, float] | None = None

    def json(self) -> dict[str, Any]:
        value = asdict(self)
        value["reference_ids"] = list(self.reference_ids)
        return value
