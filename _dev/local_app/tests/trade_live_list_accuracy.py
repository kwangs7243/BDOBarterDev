"""Real-image accuracy: oracle is read only here, never by the runtime."""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from local_app.tools.trade_live_ocr import FIELDS, recognize_live


def evaluate(result, mapping, oracle):
    metrics = dict(images=len(mapping), expectedRows=0, detectedRows=len(result["rows"]),
                   missingRows=0, extraRows=0, fullyCorrectRows=0,
                   **{field + "Exact": 0 for field in FIELDS})
    errors = []
    for image in mapping:
        actual = [row for row in result["rows"] if row["captureId"] == image["captureId"]]
        expected = [oracle[index] for index in image["oracleRows"]]
        metrics["expectedRows"] += len(expected)
        metrics["missingRows"] += max(0, len(expected) - len(actual))
        metrics["extraRows"] += max(0, len(actual) - len(expected))
        for index, truth in enumerate(expected):
            correct = True
            for field in FIELDS:
                observation = actual[index]["fields"][field] if index < len(actual) else {}
                value = observation.get("corrected")
                exact = value == truth[field]
                metrics[field + "Exact"] += int(exact)
                correct &= exact
                if not exact:
                    errors.append(dict(image=image["image"], row=index + 1, field=field,
                                       expected=truth[field], rawOCR=observation.get("rawOCR"), corrected=value))
            metrics["fullyCorrectRows"] += int(correct)
    return {"metrics": metrics, "wrongFields": errors}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--baseline", type=Path)
    args = parser.parse_args()
    fixtures = Path(__file__).parent / "fixtures/trade-recognition"
    mapping = json.loads((fixtures / "live-list-mapping.json").read_text(encoding="utf-8"))
    oracle = json.loads((fixtures / "정답.json").read_text(encoding="utf-8"))
    import hashlib
    for image in mapping:
        assert hashlib.sha256((fixtures / image["image"]).read_bytes()).hexdigest() == image["sha256"]
    assert sorted(index for image in mapping for index in image["oracleRows"]) == list(range(len(oracle)))
    started = time.monotonic()
    if args.baseline:
        baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
        from local_app.tools.trade_live_ocr import correct_name, NUMERIC
        catalog = json.loads((ROOT / "local_app/frontend/data/trade-catalog.json").read_text(encoding="utf-8"))
        items = [name for names in catalog["masterData"].values() for name in names] + catalog["specialItems"]
        result = {"rows": []}
        for row in baseline["draftRows"]:
            fields = {}
            for field, data in row["fields"].items():
                raw = data.get("rawText") or ""
                value = data.get("rawNumericCandidate") if field in NUMERIC else correct_name(raw, catalog["islands"] if field == "island" else items)[0]
                fields[field] = {"rawOCR": raw, "corrected": value}
            result["rows"].append({**row, "fields": fields})
    else:
        result = recognize_live([{**image, "imagePath": fixtures / image["image"]} for image in mapping],
                                args.model_dir, "accuracy")
    report = {**evaluate(result, mapping, oracle), "durationSeconds": round(time.monotonic() - started, 2),
              "result": result}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "result"}, ensure_ascii=False, indent=2))
    return int(report["metrics"]["missingRows"] > 0 or report["metrics"]["extraRows"] > 0)


if __name__ == "__main__":
    raise SystemExit(main())
