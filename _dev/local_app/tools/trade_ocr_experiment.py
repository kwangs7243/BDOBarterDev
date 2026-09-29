"""Isolated T010B1 PaddleOCR experiment over frozen Trade lane crops."""
from __future__ import annotations

import argparse
import copy
import ctypes
import importlib.metadata
import json
import math
import os
import platform
import re
import statistics
import subprocess
import sys
import time
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from local_app.backend.services.trade_recognition import (  # noqa: E402
    _crop_hash, _lane_boxes, canonical_hash, sha256_file,
)
from local_app.tools.trade_recognition_experiments import (  # noqa: E402
    _trade_numeric_v2, load_json, run_trade_candidate,
)

FIELDS = ("island", "fromItem", "reqAmount", "toItem", "count", "yield")
TEXT_FIELDS = ("island", "fromItem", "toItem")
NUMERIC_FIELDS = ("reqAmount", "count", "yield")
MODEL_NAME = "korean_PP-OCRv5_mobile_rec"
ENGINE = "onnxruntime"


def normalize_text(raw_text: str | None) -> str | None:
    if raw_text is None:
        return None
    return unicodedata.normalize("NFKC", raw_text).strip()


def strict_numeric_candidate(field: str, raw_text: str | None) -> tuple[int | None, str]:
    if field not in NUMERIC_FIELDS:
        raise ValueError(f"not a numeric Trade field: {field}")
    if raw_text is None:
        return None, "OCR_ERROR"
    if raw_text == "":
        return None, "EMPTY_OCR"
    if re.fullmatch(r"[0-9]+", raw_text) is None:
        return None, "INVALID_NUMERIC_TOKEN"
    value = int(raw_text)
    if (field == "count" and value < 0) or (field != "count" and value < 1):
        return None, "INVALID_NUMERIC_TOKEN"
    return value, "OCR_CANDIDATE_UNVERIFIED"


def _distance(left: str, right: str) -> int:
    if not left:
        return len(right)
    if not right:
        return len(left)
    previous = list(range(len(right) + 1))
    for i, char_left in enumerate(left, 1):
        current = [i]
        for j, char_right in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1,
                               previous[j - 1] + (char_left != char_right)))
        previous = current
    return previous[-1]


def catalog_candidate_evidence(raw_text: str | None, candidates: list[str]) -> dict[str, Any]:
    """Local, non-importer candidate evidence matching the documented safe thresholds."""
    normalized = normalize_text(raw_text) or ""
    target = re.sub(r"\s+", "", normalized)
    unique = list(dict.fromkeys(candidate for candidate in candidates if candidate))
    if not target:
        return {"status": "NO_CATALOG_MATCH", "candidates": []}
    normalized_candidates = {candidate: re.sub(r"\s+", "", candidate) for candidate in unique}
    exact = [candidate for candidate in unique if normalized_candidates[candidate] == target]
    if exact:
        return {"status": "EXACT_CATALOG_MATCH",
                "candidates": [{"value": candidate, "distance": 0, "similarity": 1.0} for candidate in exact]}
    max_distance = min(3, max(1, math.ceil(len(target) * 0.25)))
    qualified = []
    for candidate in unique:
        normalized_candidate = normalized_candidates[candidate]
        distance = _distance(target, normalized_candidate)
        similarity = 1 - distance / max(len(target), len(normalized_candidate))
        if distance <= max_distance and similarity >= 0.75:
            qualified.append({"value": candidate, "distance": distance, "similarity": similarity})
    if len(qualified) == 1:
        return {"status": "UNIQUE_SAFE_CANDIDATE", "candidates": qualified}
    if len(qualified) > 1:
        return {"status": "AMBIGUOUS_CATALOG_MATCH", "candidates": qualified}
    return {"status": "NO_CATALOG_MATCH", "candidates": []}


def extract_recognition_output(result: Any) -> dict[str, Any]:
    payload = getattr(result, "json", result)
    if callable(payload):
        payload = payload()
    if isinstance(payload, str):
        payload = json.loads(payload)
    if not isinstance(payload, dict):
        raise TypeError("PaddleOCR result must contain a JSON object")
    if isinstance(payload.get("res"), dict):
        payload = payload["res"]
    raw_text = payload.get("rec_text")
    score = payload.get("rec_score")
    if raw_text is not None and not isinstance(raw_text, str):
        raise TypeError("rec_text must be a string or null")
    if score is not None:
        score = float(score)
    return {"rawText": raw_text, "ocrScore": score}


def recognize_one(reader: Any, crop: Image.Image) -> dict[str, Any]:
    """Run only the recognition module on one already-cropped field image."""
    output = reader.predict(input=np.asarray(crop.convert("RGB")), batch_size=1)
    if not output:
        return {"rawText": "", "ocrScore": None}
    return extract_recognition_output(output[0])


def postprocess_field(field: str, raw_result: dict[str, Any], crop_hash: str,
                      geometry: dict[str, Any], catalog: list[str]) -> dict[str, Any]:
    raw_text = raw_result.get("rawText")
    score = raw_result.get("ocrScore")
    normalized = normalize_text(raw_text)
    status = "OCR_CANDIDATE_UNVERIFIED"
    candidate: Any = None
    candidates: list[dict[str, Any]] = []
    reason_codes: list[str] = []
    if raw_text is None:
        status = "OCR_ERROR"
        reason_codes.append("OCR_OUTPUT_MISSING")
    elif field in NUMERIC_FIELDS:
        candidate, status = strict_numeric_candidate(field, raw_text)
        if status == "INVALID_NUMERIC_TOKEN":
            reason_codes.append("STRICT_INTEGER_PARSE_FAILED")
        elif status == "OCR_CANDIDATE_UNVERIFIED":
            candidate = {"integer": candidate}
    elif not normalized:
        status = "EMPTY_OCR"
    elif field == "island":
        status = "RAW_OCR_ONLY"
        candidate = {"text": normalized}
    else:
        catalog_result = catalog_candidate_evidence(normalized, catalog)
        status = catalog_result["status"]
        candidates = catalog_result["candidates"]
        candidate = {"text": normalized}
        if status == "NO_CATALOG_MATCH":
            # Land materials and future items remain raw evidence; no closed-world rejection.
            reason_codes.append("RAW_TEXT_PRESERVED_NO_CATALOG_ENTRY")
    return {
        "rawText": raw_text, "normalizedText": normalized, "ocrCandidate": candidate,
        "ocrScore": score, "catalogCandidates": candidates, "value": None,
        "status": status,
        "verificationStatus": "OCR_CANDIDATE_UNVERIFIED" if raw_text else status,
        "readerEvidence": {**geometry, "readerId": "paddleocr-text-recognition-v1",
                           "engine": ENGINE, "model": MODEL_NAME,
                           "device": "cpu", "reconstructable": False},
        "cropHash": crop_hash, "reasonCodes": reason_codes,
    }


def _directory_size(path: Path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file()) if path.exists() else 0


def _sha256_files(root: Path, names: tuple[str, ...]) -> tuple[dict[str, str], str]:
    hashes = {name: sha256_file(root / name) for name in names}
    bundle_hash = canonical_hash([{"path": name, "sha256": hashes[name]} for name in sorted(hashes)])
    return hashes, bundle_hash


def _pip_freeze() -> list[str]:
    try:
        completed = subprocess.run([sys.executable, "-m", "pip", "freeze", "--all"],
                                   check=True, capture_output=True, text=True, encoding="utf-8")
    except (FileNotFoundError, subprocess.CalledProcessError):
        # uv-created venvs do not seed pip by default; uv can report the exact
        # installed distribution set without installing tooling into the venv.
        env = os.environ.copy()
        env.setdefault("UV_CACHE_DIR", str(ROOT / "recognition-local" / "cache" / "t010b1"))
        completed = subprocess.run(["uv", "pip", "freeze", "--python", sys.executable],
                                   check=True, capture_output=True, text=True, encoding="utf-8", env=env)
    return sorted(line.strip() for line in completed.stdout.splitlines() if line.strip())


def _peak_working_set_bytes() -> int | None:
    if os.name != "nt":
        return None
    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    process = ctypes.windll.kernel32.GetCurrentProcess()
    if ctypes.windll.psapi.GetProcessMemoryInfo(process, ctypes.byref(counters), counters.cb):
        return int(counters.PeakWorkingSetSize)
    return None


def _load_reader(model_dir: Path) -> tuple[Any, float]:
    model_dir = model_dir.resolve()
    cache_home = model_dir.parent.parent
    os.environ["PADDLE_PDX_CACHE_HOME"] = str(cache_home)
    # Use PaddleX's documented default source (HuggingFace); do not inherit a BOS override.
    os.environ.pop("PADDLE_PDX_MODEL_SOURCE", None)
    from paddleocr import TextRecognition
    started = time.perf_counter()
    reader = TextRecognition(model_name=MODEL_NAME, model_dir=str(model_dir),
                             engine=ENGINE, device="cpu", cpu_threads=1, enable_hpi=False)
    return reader, (time.perf_counter() - started) * 1000.0


def _load_catalog(path: Path) -> tuple[dict[str, Any], list[str]]:
    catalog = load_json(path)
    master = catalog.get("masterData")
    if not isinstance(master, dict):
        raise ValueError("trade catalog masterData is missing")
    names = list(dict.fromkeys(name for values in master.values() if isinstance(values, list)
                               for name in values if isinstance(name, str)))
    return catalog, names


def _semantic_signature(rows: list[dict[str, Any]]) -> str:
    def without_scores(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: without_scores(item) for key, item in value.items() if key != "ocrScore"}
        if isinstance(value, list):
            return [without_scores(item) for item in value]
        return value
    return canonical_hash(without_scores(rows))


def _summary_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    text_metrics: dict[str, Any] = {}
    for field in TEXT_FIELDS:
        records = [row["fields"][field] for row in rows]
        counts = Counter(record["status"] for record in records)
        text_metrics[field] = {
            "ocrAttempted": sum(record["readerEvidence"].get("geometryEligible") is True for record in records),
            "nonEmptyOcr": sum(bool(record["rawText"] and record["rawText"].strip()) for record in records),
            "emptyOcr": counts["EMPTY_OCR"], "ocrErrors": counts["OCR_ERROR"],
            "exactCatalogCandidate": counts["EXACT_CATALOG_MATCH"],
            "uniqueSafeCandidate": counts["UNIQUE_SAFE_CANDIDATE"],
            "ambiguousCandidate": counts["AMBIGUOUS_CATALOG_MATCH"],
            "noCatalogMatch": counts["NO_CATALOG_MATCH"],
            "rawOcrOnly": counts["RAW_OCR_ONLY"],
        }
    numeric_metrics: dict[str, Any] = {}
    for field in NUMERIC_FIELDS:
        records = [row["fields"][field] for row in rows]
        counts = Counter(record["status"] for record in records)
        numeric_metrics[field] = {
            "rowsTotal": len(records),
            "geometryEligibleForOcr": sum(record["readerEvidence"].get("geometryEligible") is True for record in records),
            "ocrAttempted": sum(record["readerEvidence"].get("geometryEligible") is True for record in records),
            "strictIntegerCandidate": sum(record["status"] == "OCR_CANDIDATE_UNVERIFIED" and
                                           isinstance(record["ocrCandidate"], dict) and
                                           type(record["ocrCandidate"].get("integer")) is int for record in records),
            "invalidOcrToken": counts["INVALID_NUMERIC_TOKEN"],
            "geometryAbstain": counts["GEOMETRY_ABSTAIN"],
            "ocrEmpty": counts["EMPTY_OCR"], "ocrErrors": counts["OCR_ERROR"],
        }
    row_metrics = {"rowsTotal": len(rows), "someOcrOrStructureCandidate": 0,
                   "text3CandidateComplete": 0, "numeric3CandidateComplete": 0,
                   "allSixCandidateComplete": 0}
    for row in rows:
        fields = row["fields"]
        text_complete = all(bool(fields[field]["rawText"] and fields[field]["rawText"].strip()) for field in TEXT_FIELDS)
        numeric_complete = all(fields[field]["status"] == "OCR_CANDIDATE_UNVERIFIED" and
                               isinstance(fields[field]["ocrCandidate"], dict) and
                               type(fields[field]["ocrCandidate"].get("integer")) is int
                               for field in NUMERIC_FIELDS)
        any_candidate = any((fields[field].get("ocrCandidate") is not None or
                             fields[field]["readerEvidence"].get("geometryCandidate") is True)
                            for field in FIELDS)
        row_metrics["someOcrOrStructureCandidate"] += int(any_candidate)
        row_metrics["text3CandidateComplete"] += int(text_complete)
        row_metrics["numeric3CandidateComplete"] += int(numeric_complete)
        row_metrics["allSixCandidateComplete"] += int(text_complete and numeric_complete)
    row_metrics["candidateCompletenessDefinition"] = (
        "text3 requires three non-empty OCR strings; numeric3 requires three strict integer candidates; "
        "allSix requires both; none imply verified truth")
    return {"text": text_metrics, "numeric": numeric_metrics, "rows": row_metrics}


def run_trade_ocr_candidate(manifest_path: str | Path, selection_path: str | Path,
                            t010a2_artifact_path: str | Path, t010a_selection_path: str | Path,
                            catalog_path: str | Path, model_dir: str | Path,
                            runs: int = 10) -> dict[str, Any]:
    """Run one offline OCR model over frozen crops; the signature accepts no oracle data."""
    if runs != 10:
        raise ValueError("T010B1 determinism requires exactly 10 inference runs")
    manifest_path, selection_path = Path(manifest_path), Path(selection_path)
    t010a2_artifact_path, t010a_selection_path = Path(t010a2_artifact_path), Path(t010a_selection_path)
    catalog_path, model_dir = Path(catalog_path), Path(model_dir)
    selection = load_json(selection_path)
    t010a2 = load_json(t010a2_artifact_path)
    t010a_selection = load_json(t010a_selection_path)
    t010a2_selection_path = selection_path.parent / "trade-t010a2-experiment.json"
    t010a2_selection = load_json(t010a2_selection_path)
    if (selection.get("task") != "T010B1" or selection.get("approved") is not False
            or selection.get("production") is not False or selection.get("engineSelectedForProduction") is not False
            or selection.get("importerIntegration") is not False or selection.get("ocrCandidate", {}).get("package") != "paddleocr==3.7.0"):
        raise ValueError("T010B1 selection is not an unapproved experiment-only specification")
    candidate = selection["ocrCandidate"]
    if (candidate.get("candidateId") != "paddle-korean-ppocrv5-mobile-onnx-cpu-v1"
            or candidate.get("onnxruntimePackage") != "onnxruntime==1.30.0"
            or candidate.get("model") != MODEL_NAME or candidate.get("engine") != ENGINE
            or candidate.get("device") != "cpu" or selection.get("highAuthority") != 0):
        raise ValueError("T010B1 OCR candidate differs from the frozen selection")
    if t010a2.get("task") != "T010A2" or t010a2.get("status") != "T010A2_NUMERIC_CROPS_READY_FOR_OCR_EXPERIMENT":
        raise ValueError("the verified T010A2 selection artifact is unavailable")
    t010a2_semantic_payload = {key: value for key, value in t010a2.items()
                               if key not in {"semanticHash", "baseCommit"}}
    if canonical_hash(t010a2_semantic_payload) != t010a2.get("semanticHash"):
        raise ValueError("T010A2 source artifact semantic hash mismatch")
    if t010a2.get("sourceT010AHash") != selection.get("sourceT010ASemanticHash"):
        raise ValueError("T010A2 artifact points to an unexpected T010A baseline")
    if (t010a2_selection.get("task") != "T010A2"
            or t010a2_selection.get("componentPlausibility") is None
            or t010a2_selection.get("baselineT010ACommit") != selection.get("baselineT010ACommit")):
        raise ValueError("T010A2 frozen component-plausibility parameters are unavailable")
    numeric_lane_selection = t010a2["selectedExperimentLaneCandidate"]["laneDefinitions"]
    if set(numeric_lane_selection) != set(NUMERIC_FIELDS):
        raise ValueError("T010A2 selected numeric lanes are incomplete")

    # Reproduce the original T010A semantics before deriving rows. Normalize only
    # the historical baseCommit provenance embedded in the original semantic hash.
    v1 = run_trade_candidate(manifest_path, t010a_selection_path, runs=10)
    v1_payload = {key: value for key, value in v1.items() if key not in {"timing", "semanticHash"}}
    v1_payload["baseCommit"] = selection["baselineT010ACommit"]
    if canonical_hash(v1_payload) != selection["sourceT010ASemanticHash"]:
        raise ValueError("T010A frozen reader/geometry semantic hash changed")

    # Read only the capture/image portion into the crop-preparation boundary.
    manifest = load_json(manifest_path)
    capture_records = manifest.get("trade", {}).get("captures", [])
    captures = {item["captureId"]: item for item in capture_records}
    if len(captures) != 16:
        raise ValueError(f"T010B1 requires 16 archive captures, got {len(captures)}")
    rows_by_capture: dict[str, list[dict[str, Any]]] = {capture_id: [] for capture_id in captures}
    for row in v1["rowDetection"]["rows"]:
        capture_id = row["rowId"].split(":candidate-", 1)[0]
        rows_by_capture[capture_id].append(row)
    base_lanes = copy.deepcopy(t010a_selection["parameters"]["lanes"])
    for field in NUMERIC_FIELDS:
        base_lanes[field] = numeric_lane_selection[field]

    rows: list[dict[str, Any]] = []
    samples: list[dict[str, Any]] = []
    capture_set = []
    for capture in capture_records:
        capture_id = capture["captureId"]
        image_path = (manifest_path.parent / capture["imagePath"]).resolve()
        image_hash = sha256_file(image_path)
        if image_hash != capture["imageHash"]:
            raise ValueError(f"Trade image hash mismatch: {capture_id}")
        capture_set.append({"captureId": capture_id, "imageHash": image_hash})
        with Image.open(image_path) as source:
            image = source.convert("RGB")
        for source_row in rows_by_capture[capture_id]:
            box = source_row["box"]
            row_crop = image.crop((box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]))
            lanes, lane_errors = _lane_boxes(row_crop.width, row_crop.height, base_lanes)
            row = {"rowId": source_row["rowId"], "ordinal": source_row["ordinal"],
                   "box": source_row["box"], "clipped": bool(source_row["clipped"]),
                   "rowCropHash": source_row["rowCropHash"], "fields": {},
                   "importerEligible": False, "automationDecision": "REVIEW"}
            for field in FIELDS:
                lane = lanes.get(field, {})
                base_geometry = {"geometryEligible": False, "geometryCandidate": False,
                                 "rowClipped": bool(source_row["clipped"]), "laneErrors": lane_errors}
                if not lane.get("valid"):
                    row["fields"][field] = {"rawText": None, "normalizedText": None,
                                            "ocrCandidate": None, "ocrScore": None,
                                            "catalogCandidates": [], "value": None,
                                            "status": "GEOMETRY_ABSTAIN", "verificationStatus": "UNVERIFIED",
                                            "readerEvidence": {**base_geometry, "reason": "LANE_INVALID"},
                                            "cropHash": None, "reasonCodes": ["LANE_INVALID"]}
                    continue
                lane_box = lane["box"]
                crop = row_crop.crop((lane_box["x"], lane_box["y"],
                                      lane_box["x"] + lane_box["width"],
                                      lane_box["y"] + lane_box["height"]))
                if field in TEXT_FIELDS:
                    if source_row["clipped"]:
                        row["fields"][field] = {"rawText": None, "normalizedText": None,
                                                "ocrCandidate": None, "ocrScore": None,
                                                "catalogCandidates": [], "value": None,
                                                "status": "GEOMETRY_ABSTAIN", "verificationStatus": "UNVERIFIED",
                                                "readerEvidence": {**base_geometry, "lane": lane_box},
                                                "cropHash": _crop_hash(crop), "reasonCodes": ["ROW_BOUNDARY_CONTACT"]}
                    else:
                        row["fields"][field] = {"rawText": None, "normalizedText": None,
                                                "ocrCandidate": None, "ocrScore": None,
                                                "catalogCandidates": [], "value": None,
                                                "status": "PENDING_OCR", "verificationStatus": "UNVERIFIED",
                                                "readerEvidence": {"geometryEligible": True,
                                                                   "geometryCandidate": False,
                                                                   "lane": lane_box,
                                                                   "inputKind": "frozen-text-lane-crop"},
                                                "cropHash": _crop_hash(crop), "reasonCodes": []}
                        samples.append({"row": row, "field": field, "crop": crop,
                                        "cropHash": _crop_hash(crop), "geometry": {"geometryEligible": True,
                                                                                   "geometryCandidate": False,
                                                                                   "lane": lane_box,
                                                                                   "inputKind": "frozen-text-lane-crop"}})
                else:
                    geometry = _trade_numeric_v2(crop, field, source_row["boundaryContact"], t010a2_selection)
                    reader_evidence = geometry["readerEvidence"]
                    eligible = (not source_row["clipped"] and
                                geometry["status"] == "UNVERIFIED_NUMERIC_CANDIDATE" and
                                isinstance(reader_evidence.get("tokenBox"), dict))
                    if eligible:
                        token_box = reader_evidence["tokenBox"]
                        token_crop = crop.crop((token_box["x"], token_box["y"],
                                                token_box["x"] + token_box["width"],
                                                token_box["y"] + token_box["height"]))
                        geo_summary = {"geometryEligible": True, "geometryCandidate": True,
                                       "geometryStatus": geometry["status"], "lane": lane_box,
                                       "laneCropHash": geometry["cropHash"], "tokenBox": token_box,
                                       "readerEvidence": reader_evidence,
                                       "inputKind": "t010a2-localized-plausible-token-crop"}
                        row["fields"][field] = {"rawText": None, "normalizedText": None,
                                                "ocrCandidate": None, "ocrScore": None,
                                                "catalogCandidates": [], "value": None,
                                                "status": "PENDING_OCR", "verificationStatus": "UNVERIFIED",
                                                "readerEvidence": geo_summary,
                                                "cropHash": _crop_hash(token_crop), "reasonCodes": []}
                        samples.append({"row": row, "field": field, "crop": token_crop,
                                        "cropHash": _crop_hash(token_crop), "geometry": geo_summary})
                    else:
                        reasons = list(geometry.get("reasonCodes", []))
                        row["fields"][field] = {"rawText": None, "normalizedText": None,
                                                "ocrCandidate": None, "ocrScore": None,
                                                "catalogCandidates": [], "value": None,
                                                "status": "GEOMETRY_ABSTAIN", "verificationStatus": "UNVERIFIED",
                                                "readerEvidence": {"geometryEligible": False,
                                                                   "geometryCandidate": False,
                                                                   "geometryStatus": geometry["status"],
                                                                   "lane": lane_box,
                                                                   "laneCropHash": geometry.get("cropHash"),
                                                                   "readerEvidence": reader_evidence,
                                                                   "inputKind": "no-ocr-geometry-abstain"},
                                                "cropHash": geometry.get("cropHash"),
                                                "reasonCodes": reasons or ["GEOMETRY_ABSTAIN"]}
            if set(row["fields"]) != set(FIELDS):
                raise RuntimeError("Trade row does not contain exactly six fields")
            rows.append(row)

    if not samples:
        raise ValueError("no geometry-eligible Trade crops were produced")
    catalog, catalog_names = _load_catalog(catalog_path)
    model_dir = model_dir.resolve()
    model_files = ("inference.onnx", "inference.yml")
    if any(not (model_dir / name).is_file() for name in model_files):
        raise FileNotFoundError(f"required PaddleOCR ONNX model files are missing from {model_dir}")
    reader, model_init_ms = _load_reader(model_dir)
    raw_runs: list[list[dict[str, Any]]] = []
    inference_latencies: list[float] = []
    run_errors: list[dict[str, Any]] = []
    for run_index in range(runs):
        outputs = []
        for sample_index, sample in enumerate(samples):
            started = time.perf_counter()
            try:
                output = recognize_one(reader, sample["crop"])
                outputs.append(output)
            except Exception as error:  # Per-crop failure is explicit evidence; never substitute a value.
                outputs.append({"rawText": None, "ocrScore": None,
                                "error": f"{type(error).__name__}: {error}"})
                run_errors.append({"run": run_index + 1, "sample": sample_index,
                                   "field": sample["field"], "errorType": type(error).__name__})
            inference_latencies.append((time.perf_counter() - started) * 1000.0)
        raw_runs.append(outputs)
        print(f"T010B1 inference run {run_index + 1}/{runs}: {len(outputs)} crops", flush=True)

    # OCR for every crop and repeat has finished before any catalog matching begins.
    run_field_records: list[list[dict[str, Any]]] = []
    signatures = []
    scores_by_sample: list[list[float | None]] = [[] for _ in samples]
    for outputs in raw_runs:
        postprocessed = []
        for sample, output, sample_index in zip(samples, outputs, range(len(samples))):
            evidence = dict(sample["geometry"])
            if output.get("error"):
                record = postprocess_field(sample["field"], {"rawText": None, "ocrScore": None},
                                           sample["cropHash"], evidence, catalog_names)
                record["status"] = "OCR_ERROR"
                record["readerEvidence"]["errorType"] = output.get("error", "").split(":", 1)[0]
                record["reasonCodes"] = ["OCR_INFERENCE_ERROR"]
            else:
                record = postprocess_field(sample["field"], output, sample["cropHash"], evidence, catalog_names)
            postprocessed.append(record)
            scores_by_sample[sample_index].append(record["ocrScore"])
        run_field_records.append(postprocessed)
        signatures.append(canonical_hash([{key: value for key, value in record.items() if key != "ocrScore"}
                                          for record in postprocessed]))

    for sample, record in zip(samples, run_field_records[0]):
        sample["row"]["fields"][sample["field"]] = record
    semantic_determinism = len(set(signatures)) == 1
    score_deltas = [max((score for score in scores if score is not None), default=0.0) -
                    min((score for score in scores if score is not None), default=0.0)
                    for scores in scores_by_sample]
    score_observations = [score for scores in scores_by_sample for score in scores if score is not None]
    score_exact = all(len({score for score in scores if score is not None}) <= 1 for scores in scores_by_sample)
    errors_in_first_run = sum(error["run"] == 1 for error in run_errors)
    metrics = _summary_metrics(rows)
    runtime_version = importlib.metadata.version("paddleocr")
    onnx_version = importlib.metadata.version("onnxruntime")
    if runtime_version != "3.7.0" or onnx_version != "1.30.0":
        raise RuntimeError(f"unexpected experiment packages: paddleocr={runtime_version}, onnxruntime={onnx_version}")
    freeze = _pip_freeze()
    model_hashes, bundle_hash = _sha256_files(model_dir, model_files)
    capture_set_hash = canonical_hash(capture_set)
    complete_rows = sum(not row["clipped"] for row in rows)
    status = ("T010B1_OCR_CANDIDATE_READY_FOR_HUMAN_VALIDATION"
              if semantic_determinism and not errors_in_first_run else "T010B1_BLOCKED_REQUIRES_SOL")
    artifact = {
        "version": 1, "task": "T010B1", "status": status,
        "baseCommit": subprocess.run(["git", "-C", str(ROOT.parent), "rev-parse", "HEAD"],
                                     check=True, capture_output=True, text=True).stdout.strip(),
        "sourceT010A2SemanticHash": t010a2["semanticHash"],
        "experimentSelection": {"candidateId": selection["ocrCandidate"]["candidateId"],
                                "framework": "PaddleOCR", "package": f"paddleocr=={runtime_version}",
                                "model": MODEL_NAME, "engine": ENGINE, "device": "cpu",
                                "runs": runs, "selectionHash": sha256_file(selection_path)},
        "runtimeProvenance": {"pythonVersion": platform.python_version(),
                              "pythonImplementation": platform.python_implementation(),
                              "pythonExecutableIdentity": {"implementation": platform.python_implementation(),
                                                          "version": platform.python_version(),
                                                          "abi": f"cp{sys.version_info.major}{sys.version_info.minor}",
                                                          "architecture": platform.machine()},
                              "paddleocrVersion": runtime_version, "onnxruntimeVersion": onnx_version,
                              "pipFreeze": freeze, "pipFreezeSha256": canonical_hash(freeze),
                              "remoteOcrRequests": 0},
        "modelProvenance": {"modelId": MODEL_NAME, "resolvedModelId": model_dir.name,
                            "modelSource": "PaddleX official default source (HuggingFace)",
                            "modelDirectory": str(model_dir.relative_to(ROOT)),
                            "modelFiles": model_hashes, "logicalBundleSha256": bundle_hash},
        "captureSet": {"captureCount": len(capture_set), "candidateRows": len(rows),
                       "completeRows": complete_rows, "captureSetSha256": capture_set_hash,
                       "rowDetector": "repeated-horizontal-separator-pair-v1",
                       "oracleRowCount": 80, "mappedOracleRows": 0,
                       "oracleMappingStatus": "UNRESOLVED"},
        "textCandidateMetrics": metrics["text"],
        "numericCandidateMetrics": metrics["numeric"],
        "rowCandidateMetrics": metrics["rows"],
        "catalogEvidence": {"catalogSha256": sha256_file(catalog_path),
                            "catalogCandidateSource": "trade-catalog.masterData only",
                            "safeUniqueSemanticsReference": "getSafeUniqueItemMatch distance<=min(3,max(1,ceil(length*0.25))) and similarity>=0.75",
                            "importerCalled": False, "catalogClosedWorldForFromItem": False},
        "rows": rows,
        "determinism": {"runs": runs, "semanticDeterminism": semantic_determinism,
                        "semanticRunHashes": signatures, "rawScoreDeterminism": score_exact,
                        "scoreVariation": {"samplesWithVariation": sum(delta > 0 for delta in score_deltas),
                                           "maxAbsoluteDelta": max(score_deltas, default=0.0),
                                           "observations": len(score_observations)},
                        "semanticOutputsCompared": ["rec_text", "normalizedText", "catalog candidate set",
                                                    "numeric parse", "field status"],
                        "timingExcludedFromSemanticHash": True},
        "latency": {"modelInitializationMs": model_init_ms,
                    "firstInferenceMs": inference_latencies[0] if inference_latencies else None,
                    "warmInferenceMeanMs": (statistics.mean(inference_latencies[1:])
                                             if len(inference_latencies) > 1 else None),
                    "warmInferenceP95Ms": (sorted(inference_latencies[1:])[max(0, math.ceil(0.95 * len(inference_latencies[1:])) - 1)]
                                           if len(inference_latencies) > 1 else None),
                    "latencySamples": len(inference_latencies), "inferenceErrorsAcrossAllRuns": len(run_errors),
                    "firstRunInferenceErrors": errors_in_first_run},
        "diskCost": {"environmentBytes": _directory_size(ROOT / "recognition-local" / "envs" / "t010b1-ocr"),
                     "modelDirectoryBytes": _directory_size(model_dir),
                     "peakWorkingSetBytes": _peak_working_set_bytes()},
        "accuracy": {"fieldAccuracy": None, "rowExactMatch": None,
                     "captureExactMatch": None, "fullListExact": None},
        "limitations": ["All OCR outputs remain unverified candidates; no accuracy can be claimed while screenshot-row mapping is unresolved.",
                        "No nearest-item forcing, defaults, importer integration, persistence, or production activation.",
                        "Land materials absent from the item catalog remain raw OCR evidence."],
        "approval": {"approved": False, "production": False, "engineSelectedForProduction": False,
                     "HIGH": 0, "importerIntegration": False, "automationDecision": "REVIEW",
                     "automationEligible": False},
        "userDatabaseAccessed": False, "userDatabaseChanged": False,
        "textOcrImplemented": True, "digitReconstructionImplemented": False,
    }
    artifact["semanticHash"] = canonical_hash({
        "task": artifact["task"], "sourceT010A2SemanticHash": artifact["sourceT010A2SemanticHash"],
        "captureSetSha256": capture_set_hash, "modelBundleSha256": bundle_hash,
        "rows": _semantic_signature(rows), "metrics": metrics,
        "semanticRunHashes": signatures,
    })
    return artifact


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "tests" / "fixtures" / "recognition-v2" / "manifest.json")
    parser.add_argument("--selection", type=Path, default=ROOT / "local_app" / "recognition_data" / "trade-t010b1-experiment.json")
    parser.add_argument("--t010a2-artifact", type=Path, default=ROOT / "recognition-local" / "results" / "trade-candidate-t010a2.json")
    parser.add_argument("--t010a-selection", type=Path, default=ROOT / "local_app" / "recognition_data" / "trade-t010a-experiment.json")
    parser.add_argument("--catalog", type=Path, default=ROOT / "local_app" / "frontend" / "data" / "trade-catalog.json")
    parser.add_argument("--model-dir", type=Path, default=ROOT / "recognition-local" / "models" / "t010b1" / "official_models" / f"{MODEL_NAME}_onnx")
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--out", type=Path, default=ROOT / "recognition-local" / "results" / "trade-ocr-t010b1.json")
    args = parser.parse_args()
    artifact = run_trade_ocr_candidate(args.manifest, args.selection, args.t010a2_artifact,
                                       args.t010a_selection, args.catalog, args.model_dir, args.runs)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = {"status": artifact["status"], "semanticHash": artifact["semanticHash"],
               "captureCount": artifact["captureSet"]["captureCount"],
               "textCandidateMetrics": artifact["textCandidateMetrics"],
               "numericCandidateMetrics": artifact["numericCandidateMetrics"],
               "out": str(args.out)}
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if artifact["status"] == "T010B1_OCR_CANDIDATE_READY_FOR_HUMAN_VALIDATION" else 2


if __name__ == "__main__":
    raise SystemExit(main())
