"""Thin local live-list worker for Python and the bundled executable."""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from local_app.backend.services.trade_batch_runtime import MODEL_ONNX_SHA256, MODEL_CONFIG_SHA256, _sha256
from local_app.tools.trade_live_ocr import recognize_live

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--model-dir', type=Path, required=True)
    args = parser.parse_args()
    for name, digest in [('inference.onnx', MODEL_ONNX_SHA256), ('inference.yml', MODEL_CONFIG_SHA256)]:
        if _sha256(args.model_dir / name) != digest:
            raise ValueError('model integrity verification failed')
    manifest = json.loads(args.request.read_text(encoding='utf-8'))
    if manifest.get('version') != 1 or not isinstance(manifest.get('batchId'), str):
        raise ValueError('invalid worker manifest')
    captures = manifest.get('captures')
    if not isinstance(captures, list) or not 1 <= len(captures) <= 100:
        raise ValueError('invalid worker captures')
    checked = []
    for index, capture in enumerate(captures, 1):
        name = f'capture-{index:04d}.png'
        if capture.get('imagePath') != name or not isinstance(capture.get('captureId'), str):
            raise ValueError('invalid worker image reference')
        path = args.request.resolve().parent / name
        if not path.is_file():
            raise ValueError('worker image is missing')
        checked.append({**capture, 'imagePath': path})
    result = recognize_live(checked, args.model_dir, manifest['batchId'])
    args.out.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
