# Folder-based, windowed Windows distribution. Run from any working directory:
# python -m PyInstaller --clean --noconfirm local_app/packaging/bdo-barter.spec
from pathlib import Path

ROOT = Path(SPECPATH).resolve().parents[1]
datas = [
    (str(ROOT / "local_app" / "frontend"), "local_app/frontend"),
    (str(ROOT / "reference" / "barter_items.json"), "reference"),
    (str(ROOT / "reference" / "icons"), "reference/icons"),
    (str(ROOT / "tools" / "warehouse_patch" / "warehouse_patch.py"), "tools/warehouse_patch"),
    (str(ROOT / "tools" / "warehouse_patch" / "quantity_templates.npz"), "tools/warehouse_patch"),
]
hiddenimports = [
    "local_app.backend.api.maintenance",
    "local_app.backend.api.scan",
    "local_app.backend.api.state",
    "local_app.backend.services.warehouse_scan",
    "tools.warehouse_patch.warehouse_patch",
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
