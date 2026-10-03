import io
import json
import unittest
import uuid

from PIL import Image

from local_app.backend.recognition_contracts import (
    MAX_IMAGE_BYTES,
    RecognitionContractError,
    validate_capture_metadata,
    validate_capture_payload,
)


def png_bytes(*, animated=False):
    frames = [Image.new("RGBA", (4, 3), (20, 30, 40, 255))]
    if animated:
        frames.append(Image.new("RGBA", (4, 3), (50, 60, 70, 255)))
    output = io.BytesIO()
    frames[0].save(output, format="PNG", save_all=animated, append_images=frames[1:], duration=100, loop=0)
    return output.getvalue()


def capture_metadata(*, width=4, height=3, task="warehouse"):
    return {
        "version": 1,
        "captureId": str(uuid.uuid4()),
        "batchId": None,
        "taskType": task,
        "sourceType": "file",
        "capturedAt": "2026-09-28T12:00:00Z",
        "frame": {"width": width, "height": height},
        "fidelity": {"sourceWidth": None, "sourceHeight": None, "rescaled": None, "evidence": "unknown"},
        "profileId": None,
        "profileVersion": 1,
        "context": {"baseRevision": 0, "sessionId": None, "sessionRevision": None},
        "observed": {"browserDpr": None, "windowsDpi": None, "gameResolution": None, "gameUiScale": None},
    }




class RecognitionContractTests(unittest.TestCase):
    def test_valid_capture_matches_actual_png_and_preserves_unknown_fidelity(self):
        metadata = capture_metadata()
        validated, width, height = validate_capture_payload(
            json.dumps(metadata), png_bytes(), content_type="image/png")
        self.assertEqual((width, height), (4, 3))
        self.assertEqual(validated["fidelity"]["evidence"], "unknown")
        self.assertIsNone(validated["fidelity"]["rescaled"])

    def test_missing_unknown_duplicate_and_non_finite_contract_fields_reject(self):
        missing = capture_metadata()
        del missing["observed"]
        with self.assertRaises(RecognitionContractError):
            validate_capture_metadata(missing)
        unknown = capture_metadata()
        unknown["futureAuthority"] = True
        with self.assertRaises(RecognitionContractError):
            validate_capture_metadata(unknown)
        raw = json.dumps(capture_metadata()).replace('"version": 1', '"version": 1, "version": 1', 1)
        with self.assertRaises(RecognitionContractError):
            validate_capture_payload(raw, png_bytes(), content_type="image/png")
        non_finite = json.dumps(capture_metadata()).replace('"browserDpr": null', '"browserDpr": NaN')
        with self.assertRaises(RecognitionContractError):
            validate_capture_payload(non_finite, png_bytes(), content_type="image/png")

    def test_version_task_source_and_timestamp_are_strict(self):
        for key, value in (("version", 2), ("taskType", "inventory"), ("sourceType", "native"),
                           ("capturedAt", "2026-09-28T12:00:00")):
            metadata = capture_metadata()
            metadata[key] = value
            with self.subTest(key=key), self.assertRaises(RecognitionContractError):
                validate_capture_metadata(metadata)
        with self.assertRaises(RecognitionContractError):
            validate_capture_metadata(capture_metadata(task="trade"), expected_task="warehouse")
        for key, value in (("taskType", []), ("sourceType", {}),
                           ("fidelity", {"sourceWidth": None, "sourceHeight": None, "rescaled": None, "evidence": []})):
            invalid = capture_metadata()
            invalid[key] = value
            with self.subTest(unhashable=key), self.assertRaises(RecognitionContractError):
                validate_capture_metadata(invalid)

    def test_png_mime_format_animation_and_frame_dimensions_are_checked(self):
        metadata = capture_metadata()
        with self.assertRaises(RecognitionContractError) as mime:
            validate_capture_payload(json.dumps(metadata), png_bytes(), content_type="image/jpeg")
        self.assertEqual(mime.exception.status, 415)
        with self.assertRaises(RecognitionContractError):
            validate_capture_payload(json.dumps(metadata), b"not a png", content_type="image/png")
        with self.assertRaises(RecognitionContractError):
            validate_capture_payload(json.dumps(metadata), png_bytes(animated=True), content_type="image/png")
        mismatch = capture_metadata(width=5)
        with self.assertRaises(RecognitionContractError) as frame:
            validate_capture_payload(json.dumps(mismatch), png_bytes(), content_type="image/png")
        self.assertEqual(frame.exception.code, "frame_mismatch")

    def test_metadata_and_image_byte_limits_reject_before_decode(self):
        with self.assertRaises(RecognitionContractError) as metadata:
            validate_capture_payload(" " * (64 * 1024 + 1), b"", content_type="image/png")
        self.assertEqual(metadata.exception.status, 413)
        with self.assertRaises(RecognitionContractError) as image:
            validate_capture_payload(json.dumps(capture_metadata()), b"x" * (MAX_IMAGE_BYTES + 1), content_type="image/png")
        self.assertEqual(image.exception.status, 413)





if __name__ == "__main__":
    unittest.main()
