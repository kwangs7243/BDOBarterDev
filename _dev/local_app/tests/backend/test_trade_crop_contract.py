from __future__ import annotations

import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image, ImageDraw, PngImagePlugin

from local_app.tools import trade_batch_draft_experiment as draft
from local_app.tools import trade_batch_worker as worker
from local_app.backend.services.trade_recognition import FIELDS


ROW_PARAMETERS = {"separatorPixelDelta": 24, "separatorSupportThreshold": .55,
                  "rowHeightMin": 55, "rowHeightMax": 90}
NUMERIC_PARAMETERS = {"minimumHeightRatio": .2, "maximumHeightRatio": .95,
                      "minimumWidthRatio": .015, "maximumWidthRatio": .55,
                      "minimumArea": 8, "minimumAspectRatio": .08,
                      "maximumAspectRatio": 6.0}
LANES = {
    "island": {"x0": .01, "x1": .14, "y0": .10, "y1": .90},
    "fromItem": {"x0": .16, "x1": .30, "y0": .10, "y1": .90},
    "reqAmount": {"x0": .32, "x1": .40, "y0": .10, "y1": .90},
    "toItem": {"x0": .42, "x1": .59, "y0": .10, "y1": .90},
    "count": {"x0": .61, "x1": .72, "y0": .10, "y1": .90},
    "yield": {"x0": .74, "x1": .88, "y0": .10, "y1": .90},
}
VALUES = {"island": "해모섬", "fromItem": "원료", "reqAmount": "0",
          "toItem": "획득품", "count": "0", "yield": "1,000"}


class FakeReader:
    def __init__(self, values=None):
        self.calls = []
        self.values = dict(VALUES if values is None else values)

    def predict(self, *, input, batch_size):
        assert batch_size == 1
        field = FIELDS[len(self.calls) % len(FIELDS)]
        self.calls.append((field, input.copy()))
        return [{"rec_text": self.values[field], "rec_score": .9875}]


def _image(mode="RGB"):
    image = Image.new("RGB", (320, 140), (25, 28, 30))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 24, 319, 25), fill=(190, 190, 190))
    draw.rectangle((0, 94, 319, 95), fill=(190, 190, 190))
    for box, color in [((8, 43, 24, 55), (230, 220, 175)),
                       ((57, 42, 77, 56), (210, 180, 90)),
                       ((104, 42, 110, 56), (245, 245, 245)),
                       ((140, 42, 160, 56), (200, 210, 220)),
                       ((201, 42, 205, 56), (255, 255, 255)),
                       ((246, 42, 259, 56), (235, 240, 250))]:
        draw.rectangle(box, fill=color)
    if mode == "RGBA":
        return image.convert("RGBA")
    if mode == "L":
        return image.convert("L")
    if mode == "P":
        return image.convert("P", palette=Image.Palette.ADAPTIVE, colors=256)
    return image


def _capture(tmp_path: Path, capture_id="cap-z", *, mode="RGB", metadata=True, reencoded=False):
    path = tmp_path / f"{capture_id}.png"
    image = _image(mode)
    if metadata:
        info = PngImagePlugin.PngInfo()
        info.add_text("fixture", "same decoded pixels")
        image.save(path, pnginfo=info)
    else:
        image.save(path)
    return {"captureId": capture_id, "batchId": "batch-fixture", "imagePath": str(path),
            "sourceType": "FILE",
            "sourceFidelity": {"sourceWidth": 320, "sourceHeight": 140,
                               "rescaled": False, "evidence": "file-metadata"},
            "reencoded": reencoded}


def _build(captures, reader=None, lanes=None, **kwargs):
    return draft.build_raw_evidence_snapshot_v2_once(
        captures, LANES if lanes is None else lanes, ROW_PARAMETERS, NUMERIC_PARAMETERS,
        reader or FakeReader(), recognition_batch_id="batch-fixture", **kwargs,
    )


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def test_snapshot_has_exact_shape_and_hashes_real_capture_and_crop_pixels(tmp_path):
    capture = _capture(tmp_path)
    reader = FakeReader()
    snapshot = _build([capture], reader)

    assert set(snapshot) == {"schemaVersion", "recognitionBatchId", "captures", "sourceRows", "edgeSegments"}
    assert snapshot["schemaVersion"] == 2
    assert snapshot["recognitionBatchId"] == "batch-fixture"
    assert len(reader.calls) == 6
    image = Image.open(capture["imagePath"]).convert("RGB")
    raw_capture = snapshot["captures"][0]
    assert set(raw_capture) == {"captureId", "captureOrdinal", "imageSha256", "bitmapSha256", "sourceType",
                                "frame", "sourceFidelity", "reencoded", "completeRowCount"}
    assert raw_capture["frame"] == {"width": 320, "height": 140}
    assert raw_capture["imageSha256"] == _sha(Path(capture["imagePath"]).read_bytes())
    assert raw_capture["bitmapSha256"] == _sha(image.tobytes())
    assert raw_capture["imageSha256"] != raw_capture["bitmapSha256"]
    assert raw_capture["sourceType"] == "FILE"
    assert raw_capture["sourceFidelity"] == capture["sourceFidelity"]
    assert raw_capture["reencoded"] is False

    assert len(snapshot["sourceRows"]) == raw_capture["completeRowCount"] == 1
    row = snapshot["sourceRows"][0]
    assert row["sourceRowId"] == "cap-z:draft-row-02"
    assert row["ordinal"] == 1
    assert row["rowBox"] == {"x": 0, "y": 26, "width": 320, "height": 68}
    assert [field["field"] for field in row["fields"]] == list(FIELDS)
    assert [field["confidence"] for field in row["fields"]] == ["0.9875"] * 6
    assert row["fields"][2]["rawNumeric"] is None
    assert row["fields"][4]["rawNumeric"] == 0
    assert row["fields"][5]["rawText"] == "1,000"
    assert row["fields"][5]["rawNumeric"] is None
    for field, (_reader_field, reader_pixels) in zip(row["fields"], reader.calls):
        assert field["field"] == _reader_field
        ref, = field["cropRefs"]
        assert set(ref) == {"cropRefId", "sourceRowId", "captureId", "field", "bitmapSha256", "frame",
                            "coordinateSpace", "box", "pixelHashBasis", "pixelSha256", "pngArtifactSha256"}
        assert ref["cropRefId"] == f"{row['sourceRowId']}:{field['field']}"
        assert ref["coordinateSpace"] == "CAPTURE_BITMAP_PIXELS"
        assert ref["pixelHashBasis"] == "RGB8_ROW_MAJOR_V1"
        assert ref["bitmapSha256"] == raw_capture["bitmapSha256"]
        assert ref["pngArtifactSha256"] is None
        box = ref["box"]
        recrop = image.crop((box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]))
        assert recrop.tobytes() == reader_pixels.tobytes()
        assert ref["pixelSha256"] == _sha(reader_pixels.tobytes()) == _sha(recrop.tobytes())


def test_row_local_box_translates_using_nonzero_row_origin():
    assert draft._capture_pixel_box(
        {"x": 7, "y": 20, "width": 90, "height": 40},
        {"x": 11, "y": 5, "width": 20, "height": 10},
        {"width": 120, "height": 80},
    ) == {"x": 18, "y": 25, "width": 20, "height": 10}


@pytest.mark.parametrize("box", [
    {"x": -1, "y": 0, "width": 2, "height": 2},
    {"x": 0, "y": -1, "width": 2, "height": 2},
    {"x": 0, "y": 0, "width": 0, "height": 2},
    {"x": 0, "y": 0, "width": 2, "height": 0},
    {"x": 99, "y": 0, "width": 2, "height": 2},
])
def test_invalid_box_bounds_rejected(box):
    with pytest.raises(ValueError):
        draft._raw_box(box, {"width": 100, "height": 100}, "test")


def test_same_pixels_different_png_metadata_have_distinct_file_hashes(tmp_path):
    first = _capture(tmp_path, "cap-first", metadata=False)
    second = _capture(tmp_path, "cap-second", metadata=True)
    one = _build([first])
    two = _build([second])
    assert one["captures"][0]["imageSha256"] != two["captures"][0]["imageSha256"]
    assert one["captures"][0]["bitmapSha256"] == two["captures"][0]["bitmapSha256"]
    assert [[ref["pixelSha256"] for field in row["fields"] for ref in field["cropRefs"]]
            for row in one["sourceRows"]] == [[ref["pixelSha256"] for field in row["fields"] for ref in field["cropRefs"]]
                                               for row in two["sourceRows"]]


@pytest.mark.parametrize("mode", ["L", "P"])
def test_grayscale_and_palette_decode_to_rgb8_hash(mode, tmp_path):
    capture = _capture(tmp_path, f"cap-{mode}", mode=mode)
    snapshot = _build([capture])
    rgb = Image.open(capture["imagePath"]).convert("RGB")
    assert snapshot["captures"][0]["bitmapSha256"] == _sha(rgb.tobytes())
    assert snapshot["captures"][0]["frame"] == {"width": 320, "height": 140}


def test_opaque_alpha_allowed_but_translucent_rejected_only_in_v2(tmp_path):
    opaque = _capture(tmp_path, "opaque", mode="RGBA")
    assert _build([opaque])["captures"][0]["bitmapSha256"] == _sha(
        Image.open(opaque["imagePath"]).convert("RGB").tobytes())

    translucent_image = _image("RGBA")
    translucent_image.putpixel((12, 12), (20, 30, 40, 128))
    path = tmp_path / "transparent.png"
    translucent_image.save(path)
    invalid = {**opaque, "captureId": "transparent", "imagePath": str(path)}
    reader = FakeReader()
    with pytest.raises(ValueError, match="RAW_EVIDENCE_ALPHA_NOT_OPAQUE"):
        _build([invalid], reader)
    assert reader.calls == []

    legacy = draft.build_batch_drafts_once([invalid], LANES, ROW_PARAMETERS, NUMERIC_PARAMETERS, FakeReader())
    assert legacy["captureEvidence"][0]["captureId"] == "transparent"


def test_invalid_geometry_has_no_crop_ref_or_reader_call(tmp_path):
    capture = _capture(tmp_path)
    reader = FakeReader()
    lanes = {**LANES, "island": {"x0": .2, "x1": .1, "y0": .1, "y1": .9}}
    snapshot = _build([capture], reader, lanes=lanes)
    island = snapshot["sourceRows"][0]["fields"][0]
    assert island["readerStatus"] == "GEOMETRY_ABSTAIN"
    assert island["rawText"] is None and island["rawNumeric"] is None
    assert island["cropRefs"] == []
    assert len(reader.calls) == 5


def test_clipped_numeric_field_keeps_cropref_and_raw_candidate(tmp_path):
    capture = _capture(tmp_path)
    reader = FakeReader({**VALUES, "yield": "148"})
    structure = {"readerEvidence": {"plausibleTokenBoundaryContact": {"left": False, "right": True}}}
    with patch.object(draft, "infer_trade_numeric_field_v2", return_value=structure):
        snapshot = _build([capture], reader)
    result = snapshot["sourceRows"][0]["fields"][-1]
    assert result["readerStatus"] == "FIELD_CLIPPED"
    assert result["rawNumeric"] == 148
    assert len(result["cropRefs"]) == 1
    assert result["cropRefs"][0]["pixelSha256"]


def test_confidence_is_decimal_text_and_nonfinite_score_rejected(tmp_path):
    capture = _capture(tmp_path)
    snapshot = _build([capture], FakeReader())
    assert all(isinstance(field["confidence"], str) for field in snapshot["sourceRows"][0]["fields"])

    class NonFiniteReader(FakeReader):
        def predict(self, *, input, batch_size):
            self.calls.append(("island", input.copy()))
            return [{"rec_text": "text", "rec_score": float("nan")}]

    with pytest.raises(ValueError, match="RAW_EVIDENCE_INVALID_CONFIDENCE"):
        _build([capture], NonFiniteReader())


def test_capture_order_and_edge_accounting_are_preserved(tmp_path):
    first = _capture(tmp_path, "z-first")
    second = _capture(tmp_path, "a-second")
    snapshot = _build([first, second])
    assert [capture["captureId"] for capture in snapshot["captures"]] == ["z-first", "a-second"]
    assert [capture["captureOrdinal"] for capture in snapshot["captures"]] == [1, 2]
    assert [row["captureId"] for row in snapshot["sourceRows"]] == ["z-first", "a-second"]
    assert [row["ordinal"] for row in snapshot["sourceRows"]] == [1, 2]
    assert len(snapshot["edgeSegments"]) == 4
    assert all(set(edge) == {"edgeId", "captureId", "ordinal", "reason", "rowBox", "sourceRefs"}
               and len(edge["sourceRefs"]) == 1
               and edge["sourceRefs"][0] == {"sourceRowId": edge["edgeId"], "captureId": edge["captureId"],
                                             "ordinal": edge["ordinal"]}
               for edge in snapshot["edgeSegments"])
    assert all("fields" not in edge for edge in snapshot["edgeSegments"])
    assert {edge["edgeId"] for edge in snapshot["edgeSegments"]} == {
        f"{edge['captureId']}:edge-row-{edge['ordinal']}" for edge in snapshot["edgeSegments"]
    }


def test_v2_source_metadata_required_and_duplicate_capture_ids_rejected(tmp_path):
    capture = _capture(tmp_path)
    calls = FakeReader()
    invalid = {key: value for key, value in capture.items() if key != "reencoded"}
    with pytest.raises(ValueError, match="RAW_EVIDENCE_INVALID_REENCODED"):
        _build([invalid], calls)
    assert calls.calls == []
    with pytest.raises(ValueError, match="RAW_EVIDENCE_DUPLICATE_CAPTURE_ID"):
        _build([capture, capture], calls)
    assert calls.calls == []


def test_worker_v2_opt_in_and_default_v1_preserved(tmp_path):
    capture = _capture(tmp_path)
    expected_inputs = ("batch-fixture", [capture], LANES, ROW_PARAMETERS, NUMERIC_PARAMETERS)
    parser = worker._build_parser()
    args = parser.parse_args(["--request", "request.json", "--out", "out.json", "--model-dir", "models"])
    assert args.raw_evidence_version == 1

    v2_out = tmp_path / "v2.json"
    with patch.object(worker, "_load_inputs", return_value=expected_inputs), \
            patch("local_app.tools.trade_ocr_experiment._load_reader", return_value=(FakeReader(), 0)):
        worker.run(tmp_path / "request.json", v2_out, tmp_path / "models", raw_evidence_version=2)
    v2 = json.loads(v2_out.read_text(encoding="utf-8"))
    assert set(v2) == {"schemaVersion", "recognitionBatchId", "captures", "sourceRows", "edgeSegments"}

    v1_out = tmp_path / "v1.json"
    with patch.object(worker, "_load_inputs", return_value=expected_inputs), \
            patch("local_app.tools.trade_ocr_experiment._load_reader", return_value=(FakeReader(), 0)):
        worker.run(tmp_path / "request.json", v1_out, tmp_path / "models")
    v1 = json.loads(v1_out.read_text(encoding="utf-8"))
    assert v1["version"] == 1
    assert set(v1) == {"version", "batchId", "captureIds", "captures", "draftRows", "edgeSegments", "metrics"}


def test_worker_v2_validation_rejects_duplicate_crop_and_bad_source_mapping(tmp_path):
    capture = _capture(tmp_path)
    snapshot = _build([capture])
    worker._validate_raw_evidence_snapshot_v2(snapshot, "batch-fixture", ["cap-z"])
    broken = json.loads(json.dumps(snapshot))
    broken["sourceRows"][0]["fields"][1]["cropRefs"][0]["cropRefId"] = \
        broken["sourceRows"][0]["fields"][0]["cropRefs"][0]["cropRefId"]
    with pytest.raises(ValueError, match="RAW_EVIDENCE_V2_INVALID_CROP_REF"):
        worker._validate_raw_evidence_snapshot_v2(broken, "batch-fixture", ["cap-z"])
    broken = json.loads(json.dumps(snapshot))
    broken["sourceRows"][0]["fields"][0]["cropRefs"][0]["sourceRowId"] = "unknown"
    with pytest.raises(ValueError, match="RAW_EVIDENCE_V2_INVALID_CROP_REF"):
        worker._validate_raw_evidence_snapshot_v2(broken, "batch-fixture", ["cap-z"])


def test_worker_v2_validation_rejects_duplicate_capture_and_accounting_spoof(tmp_path):
    capture = _capture(tmp_path)
    snapshot = _build([capture])

    broken = json.loads(json.dumps(snapshot))
    broken["captures"][0]["captureId"] = "other"
    with pytest.raises(ValueError, match="RAW_EVIDENCE_V2_INVALID_ACCOUNTING"):
        worker._validate_raw_evidence_snapshot_v2(broken, "batch-fixture", ["cap-z"])

    broken = json.loads(json.dumps(snapshot))
    broken["captures"][0]["completeRowCount"] += 1
    with pytest.raises(ValueError, match="RAW_EVIDENCE_V2_COMPLETE_COUNT_MISMATCH"):
        worker._validate_raw_evidence_snapshot_v2(broken, "batch-fixture", ["cap-z"])

    broken = json.loads(json.dumps(snapshot))
    broken["sourceRows"][0]["fields"][0]["rawNumeric"] = 123
    with pytest.raises(ValueError, match="RAW_EVIDENCE_V2_INVALID_FIELD"):
        worker._validate_raw_evidence_snapshot_v2(broken, "batch-fixture", ["cap-z"])
