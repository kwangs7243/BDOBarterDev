# Folder-based, windowed Windows distribution. Run from any working directory:
# python -m PyInstaller --clean --noconfirm local_app/packaging/bdo-barter.spec
from pathlib import Path
import os

ROOT = Path(SPECPATH).resolve().parents[1]
trade_model = Path(os.environ.get("BDO_PACKAGE_TRADE_MODEL_DIR", ROOT / "recognition-local/models/t010b1/official_models/korean_PP-OCRv5_mobile_rec_onnx"))
if not all((trade_model / name).is_file() for name in ("inference.onnx", "inference.yml")):
    raise RuntimeError("The verified local trade OCR model is required for packaging.")
warehouse_templates = ROOT / "recognition-local" / "models" / "warehouse" / "quantity_templates.npz"
if not warehouse_templates.is_file():
    warehouse_templates = ROOT / "tools" / "warehouse_patch" / "quantity_templates.npz"
datas = [
    (str(trade_model / "inference.onnx"), "local_app/recognition_data/trade-model"),
    (str(trade_model / "inference.yml"), "local_app/recognition_data/trade-model"),
    (str(ROOT / "local_app" / "tools" / "trade_live_ocr.py"), "local_app/tools"),
    (str(ROOT / "local_app" / "tools" / "trade_batch_worker.py"), "local_app/tools"),
    (str(ROOT / "local_app" / "frontend"), "local_app/frontend"),
    (str(ROOT / "reference" / "barter_items.json"), "reference"),
    (str(ROOT / "reference" / "icons"), "reference/icons"),
    (str(ROOT / "tools" / "warehouse_patch" / "warehouse_patch.py"), "tools/warehouse_patch"),
    (str(warehouse_templates), "tools/warehouse_patch"),
]
hiddenimports = [
    "local_app.tools.trade_batch_worker",
    "local_app.tools.trade_live_ocr",
    "onnxruntime",
    "cv2",
    "yaml",
    "local_app.backend.api.maintenance",
    "local_app.backend.api.scan",
    "local_app.backend.api.state",
    "local_app.backend.services.warehouse_scan",
    "tools.warehouse_patch.warehouse_patch",
    "local_app.native_capture",
    "local_app.native_win32",
    "local_app.backend.api.native_capture",
    "PIL.ImageGrab",
    "waitress",
    "waitress.server",
]

a = Analysis(
    [str(ROOT / "local_app" / "launcher.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "unittest.mock", "IPython", "notebook"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="BDO 물교 실행",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
)
collect = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="app",
)
