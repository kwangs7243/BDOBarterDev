"""Audit distributable paths, bundled module names, resources, and a SHA-256 manifest."""
import hashlib
import json
from pathlib import Path
from PyInstaller.archive.readers import CArchiveReader

DEV = Path(__file__).resolve().parents[1]
APP = DEV.parent / "app"
OUT = DEV / "reports/freeze-20260926"
forbidden_tokens = ("barter_scan", "phase5", "rapidocr", "korean_pp-ocrv4", "numeric-model", "numeric-parameters", "gemini", "node_modules")
forbidden_parts = {"tests", "specs", "docs", "venv", "__pycache__", ".pytest_cache", "fixtures", "물교리스트스샷"}
files = sorted((p for p in APP.rglob("*") if p.is_file()), key=lambda p:p.relative_to(APP).as_posix())
bad = [p.relative_to(APP).as_posix() for p in files if any(t in p.relative_to(APP).as_posix().lower() for t in forbidden_tokens) or forbidden_parts.intersection(p.relative_to(APP).parts)]
assert not bad, bad
assert not list(APP.rglob("*.sqlite3")), "Database bundled into distributable"
resources = {
    "_internal/tools/warehouse_patch/warehouse_patch.py": "tools/warehouse_patch/warehouse_patch.py",
    "_internal/tools/warehouse_patch/quantity_templates.npz": "tools/warehouse_patch/quantity_templates.npz",
    "_internal/reference/barter_items.json": "reference/barter_items.json",
}
for source in (DEV / "local_app/frontend").rglob("*"):
    if source.is_file():
        resources["_internal/" + source.relative_to(DEV).as_posix()] = source.relative_to(DEV).as_posix()
for packaged, original in resources.items():
    assert (APP / packaged).read_bytes() == (DEV / original).read_bytes(), packaged
icons = list((APP / "_internal/reference/icons").glob("*.webp"))
assert len(icons) == 70
for icon in icons:
    assert icon.read_bytes() == (DEV / "reference/icons" / icon.name).read_bytes()
archive = CArchiveReader(str(APP / "BDO 물교 실행.exe"))
modules = sorted(archive.open_embedded_archive("PYZ.pyz").toc)
bad_modules = [n for n in modules if n.startswith(("tools.barter_scan", "local_app.tests", "pytest", "rapidocr", "onnxruntime")) or any(t in n.lower() for t in forbidden_tokens)]
assert not bad_modules, bad_modules
# Library names such as jinja2.tests implement runtime template predicates, not project test suites.
runtime_helpers = [n for n in modules if "test" in n.lower()]
manifest = "".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.stat().st_size}  {p.relative_to(APP).as_posix()}\n" for p in files)
(OUT / "package-manifest.sha256").write_bytes(manifest.encode("utf-8"))
result = {
    "ok": True, "files": len(files), "bytes": sum(p.stat().st_size for p in files),
    "manifestSha256": hashlib.sha256(manifest.encode("utf-8")).hexdigest(),
    "manifestFormat": "UTF-8 without BOM; POSIX relative-path ordinal sort; SHA256, two spaces, decimal bytes, two spaces, path, LF",
    "forbiddenPaths": bad, "forbiddenPrototypeOrProjectTestModules": bad_modules,
    "warehouseIcons": len(icons), "resourceContentComparisons": len(resources)+len(icons),
    "bundledModuleCount": len(modules), "libraryRuntimeTestNamedHelpers": runtime_helpers,
    "databaseFiles": 0, "entrypoint": "app/BDO 물교 실행.exe"
}
(OUT / "package-audit.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
(OUT / "bundled-module-names.txt").write_text("\n".join(modules)+"\n", encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, indent=2))
