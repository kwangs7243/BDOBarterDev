# Folder-based, windowed Windows distribution. Run from any working directory:
# python -m PyInstaller --clean --noconfirm local_app/packaging/bdo-suite.spec
from pathlib import Path
import os
import json
import numpy as np

ROOT = Path(SPECPATH).resolve().parents[1]
trade_model = Path(os.environ.get("BDO_PACKAGE_TRADE_MODEL_DIR", ROOT / ".local/models/trade"))
if not all((trade_model / name).is_file() for name in ("inference.onnx", "inference.yml")):
    raise RuntimeError("The verified local trade OCR model is required for packaging.")
warehouse_templates = Path(os.environ.get("BDO_PACKAGE_WAREHOUSE_TEMPLATES",
    ROOT / "barter" / "recognition_data" / "warehouse-templates.npz"))
if not warehouse_templates.is_file():
    raise RuntimeError("Verified warehouse feedback templates are required for packaging. "
                       "Set BDO_PACKAGE_WAREHOUSE_TEMPLATES to the calibrated quantity_templates.npz.")
with np.load(warehouse_templates, allow_pickle=False) as warehouse_data:
    feedback_keys = {"feedback_slots", "feedback_values", "feedback_item_names", "feedback_provenance_json"}
    if not feedback_keys.issubset(warehouse_data.files):
        raise RuntimeError("Warehouse packaging requires calibrated feedback; base templates are insufficient.")
    verified_rows = len(warehouse_data["feedback_slots"])
    provenance = json.loads(str(warehouse_data["feedback_provenance_json"]))
    if (verified_rows < 1 or provenance.get("verifiedRows") != verified_rows
            or len(warehouse_data["feedback_values"]) != verified_rows
            or len(warehouse_data["feedback_item_names"]) != verified_rows):
        raise RuntimeError("Warehouse feedback templates and their verified-row provenance do not agree.")
trade_templates = os.environ.get("BDO_PACKAGE_TRADE_TEMPLATES", str(ROOT / "barter/recognition_data/trade-templates.json"))
if trade_templates:
    import hashlib
    import sys
    sys.path.insert(0, str(ROOT))
    from barter.tools.trade_template_reader import BANK_SHA256
    trade_templates = Path(trade_templates)
    if hashlib.sha256(trade_templates.read_bytes()).hexdigest() != BANK_SHA256:
        raise RuntimeError("Trade template bank integrity verification failed.")

datas = [
    (str(ROOT / "local_app" / "frontend"), "local_app/frontend"),
    (str(ROOT / "alchemy" / "frontend"), "alchemy/frontend"),
    (str(ROOT / "alchemy" / "data"), "alchemy/data"),
    (str(trade_model / "inference.onnx"), "barter/recognition_data/trade-model"),
    (str(trade_model / "inference.yml"), "barter/recognition_data/trade-model"),
    (str(ROOT / "barter" / "tools" / "trade_live_ocr.py"), "barter/tools"),
    (str(ROOT / "barter" / "tools" / "trade_batch_worker.py"), "barter/tools"),
    (str(ROOT / "barter" / "frontend"), "barter/frontend"),
    (str(ROOT / "reference" / "barter_items.json"), "reference"),
    (str(ROOT / "reference" / "icons"), "reference/icons"),
    (str(ROOT / "tools" / "warehouse_patch" / "warehouse_patch.py"), "tools/warehouse_patch"),
    (str(warehouse_templates), "tools/warehouse_patch"),
]
if trade_templates:
    datas.append((str(trade_templates), "barter/recognition_data"))
datas.append((str(ROOT / "barter/tools/trade_template_reader.py"), "barter/tools"))
hiddenimports = [
    "barter.tools.trade_template_reader",
    "barter.tools.trade_batch_worker",
    "barter.tools.trade_live_ocr",
    "onnxruntime",
    "cv2",
    "yaml",
    "barter.backend.api.maintenance",
    "barter.backend.api.scan",
    "barter.backend.api.state",
    "barter.backend.services.warehouse_scan",
    "tools.warehouse_patch.warehouse_patch",
    "local_app.native_capture",
    "local_app.native_win32",
    "barter.backend.api.native_capture",
    "PIL.ImageGrab",
    "waitress",
    "waitress.server",
]


def canonicalize_warehouse_data(entries):
    return [("tools/warehouse_patch/quantity_templates.npz", source, kind)
            if Path(source).resolve() == warehouse_templates.resolve() else (destination, source, kind)
            for destination, source, kind in entries]


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
a.datas = canonicalize_warehouse_data(a.datas)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="BDO 실행",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    icon=str(ROOT / "local_app/frontend/bdo.ico"),
    version=str(ROOT / "local_app/packaging/version-info.txt"),
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
