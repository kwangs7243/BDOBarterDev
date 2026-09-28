"""Warehouse image upload endpoint."""
from __future__ import annotations

from flask import Blueprint, current_app, jsonify, request

from ..services.warehouse_scan import WarehouseScanError, process_warehouse_upload

scan_api = Blueprint("warehouse_scan_api", __name__, url_prefix="/api")


@scan_api.post("/warehouse-scan")
def warehouse_scan():
    if request.mimetype != "multipart/form-data":
        return jsonify({"ok": False, "error": {"code": "unsupported_image_format", "message": "multipart/form-data로 PNG 한 장을 보내야 합니다."}}), 415

    files = [upload for key in request.files for upload in request.files.getlist(key)]
    if not files:
        return jsonify({"ok": False, "error": {"code": "missing_file", "message": "판독할 PNG 파일을 선택하세요."}}), 422
    if len(files) != 1:
        for upload in files:
            upload.close()
        return jsonify({"ok": False, "error": {"code": "single_file_required", "message": "한 번에 PNG 한 장만 판독할 수 있습니다."}}), 422

    store = current_app.extensions["bdo_storage"]
    try:
        patch, report = process_warehouse_upload(
            files[0], store.catalog,
            temporary_directory=current_app.config.get("WAREHOUSE_SCAN_TEMP_DIR"),
            record_scan=store.record_warehouse_scan,
        )
    except WarehouseScanError as error:
        return jsonify({"ok": False, "error": {"code": error.code, "message": str(error)}}), error.status
    finally:
        files[0].close()
    return jsonify({"ok": True, "patch": patch, "report": report})


@scan_api.get("/warehouse-dataset")
def warehouse_dataset():
    """Export a consistent local snapshot; unverified guesses never become labels."""
    from ..warehouse_evidence import label_verification
    import json
    import tempfile
    import zipfile
    from contextlib import closing
    from io import BytesIO
    from PIL import Image
    from flask import send_file

    archive = tempfile.SpooledTemporaryFile(max_size=4 * 1024 * 1024)
    samples = tempfile.SpooledTemporaryFile(max_size=1024 * 1024)
    count = 0
    try:
        store = current_app.extensions["bdo_storage"]
        with closing(store.connect()) as connection, zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            connection.execute("BEGIN")
            for record in connection.execute("SELECT * FROM warehouse_scan ORDER BY created_at, scan_id"):
                count += 1
                scan_id = record["scan_id"]
                base = f"scans/{scan_id}"
                report = json.loads(record["report_json"])
                feedback = [dict(row) for row in connection.execute("SELECT * FROM warehouse_feedback WHERE scan_id = ? ORDER BY created_at, mutation_id", (scan_id,))]
                for row in feedback:
                    row["feedback"] = json.loads(row.pop("feedback_json"))
                    row["appliedItems"] = json.loads(row.pop("applied_items_json"))
                bundle.writestr(f"{base}/input.png", record["image_png"])
                bundle.writestr(f"{base}/output.json", record["report_json"])
                bundle.writestr(f"{base}/provenance.json", record["provenance_json"])
                bundle.writestr(f"{base}/feedback.json", json.dumps(feedback, ensure_ascii=False))
                with Image.open(BytesIO(record["image_png"])) as image:
                    for slot in report["slots"]:
                        crop_name = None
                        if all(type(slot.get(key)) is int for key in ("x", "y")) and type(report.get("grid", {}).get("slotWidth")) is int:
                            width = report["grid"]["slotWidth"]
                            crop_name = f"{base}/slots/{slot['slot']}.png"
                            pixels = BytesIO()
                            image.crop((slot["x"], slot["y"], slot["x"] + width, slot["y"] + width)).save(pixels, format="PNG")
                            bundle.writestr(crop_name, pixels.getvalue())
                        labels = [{"mutationId": entry["mutation_id"], "createdAt": entry["created_at"], "user": row,
                                   **label_verification(row)}
                                  for entry in feedback for row in entry["feedback"]["rows"] if row["slot"] == slot["slot"]]
                        sample = {"scanId": scan_id, "createdAt": record["created_at"], "sourceImage": f"{base}/input.png", "crop": crop_name, "modelOutput": slot, "humanFeedback": labels}
                        samples.write((json.dumps(sample, ensure_ascii=False) + "\n").encode("utf-8"))
            samples.seek(0)
            with bundle.open("samples.jsonl", "w") as target:
                import shutil
                shutil.copyfileobj(samples, target)
            bundle.writestr("manifest.json", json.dumps({"formatVersion": 2, "scanCount": count, "itemLabels": "Explicit four-way item/quantity checks are verified independently. Legacy match/different checks verify only the item. Automatic output, unchecked and excluded rows are not ground truth.", "quantityLabels": "Original output and final human values are separate. Only explicit four-way checks verify quantity labels; unknown OCR quantities never count as a match.", "trainingPerformed": False}, ensure_ascii=False))
        archive.seek(0)
        response = send_file(archive, mimetype="application/zip", as_attachment=True, download_name="warehouse-recognition-dataset.zip", max_age=0)
        response.call_on_close(archive.close)
        return response
    except Exception:
        archive.close()
        raise
    finally:
        samples.close()
