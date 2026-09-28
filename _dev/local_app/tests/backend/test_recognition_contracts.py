import io
import json
import unittest
import uuid

from PIL import Image

from local_app.backend.recognition_contracts import (
    MAX_IMAGE_BYTES,
    RecognitionContractError,
    UNSUPPORTED_FLAGS,
    validate_capture_metadata,
    validate_capture_payload,
    validate_config_update,
    validate_feedback_payload,
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


def profile():
    return {
        "version": 1,
        "id": str(uuid.uuid4()),
        "profileVersion": 1,
        "taskType": "warehouse",
        "sourceType": "file",
        "referenceFrame": {"width": 1920, "height": 1080},
        "region": {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0},
        "anchorSetId": "unapproved-anchor-set",
        "anchorSetHash": "a" * 64,
        "anchorOffsets": {},
        "canonicalGeometry": {},
        "observed": {"windowsDpi": None, "gameResolution": None, "gameUiScale": None},
        "verifiedStratumIds": [],
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

    def test_profile_region_and_unknown_fields_are_validated(self):
        valid = profile()
        from local_app.backend.recognition_contracts import validate_profile
        self.assertEqual(validate_profile(valid)["profileVersion"], 1)
        invalid = profile()
        invalid["region"]["w"] = 1.1
        with self.assertRaises(RecognitionContractError):
            validate_profile(invalid)
        invalid = profile()
        invalid["releaseApproved"] = True
        with self.assertRaises(RecognitionContractError):
            validate_profile(invalid)

    def test_config_defaults_cannot_become_authority_and_flags_are_closed(self):
        config = {"version": 1, "expectedConfigRevision": 0,
                  "flags": {key: False for key in UNSUPPORTED_FLAGS}, "profiles": [profile()]}
        self.assertEqual(len(validate_config_update(config)["profiles"]), 1)
        enabled = dict(config)
        enabled["flags"] = {**config["flags"], "warehouseV2": True}
        with self.assertRaises(RecognitionContractError) as error:
            validate_config_update(enabled)
        self.assertEqual(error.exception.code, "unsupported_feature")
        unknown = dict(config)
        unknown["flags"] = {**config["flags"], "unknown": True}
        with self.assertRaises(RecognitionContractError):
            validate_config_update(unknown)

    def test_explicit_feedback_accepts_true_zero_but_not_boolean_quantity(self):
        payload = {"version": 1, "labelMutationId": str(uuid.uuid4()), "rows": [
            {"unitId": "R1C1", "fields": {"quantity": {"value": 0, "verification": "explicit", "reason": "confirmed"}}}
        ]}
        self.assertEqual(validate_feedback_payload(payload)["rows"][0]["fields"]["quantity"]["value"], 0)
        payload["rows"][0]["fields"]["quantity"]["value"] = True
        with self.assertRaises(RecognitionContractError):
            validate_feedback_payload(payload)


if __name__ == "__main__":
    unittest.main()
