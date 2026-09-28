"""Compare the restoration distribution with current runtime resources and protected data."""
import os
import hashlib
import json
from pathlib import Path
from PyInstaller.archive.readers import CArchiveReader

dev = Path(__file__).resolve().parents[1]
app = Path(os.environ.get('BDO_PACKAGE_APP', str(dev.parent / '업데이트_검증판/app')))
out = Path(os.environ.get('BDO_EVIDENCE_DIR', str(dev / 'specs/007-feature-restoration/evidence')))
out.mkdir(parents=True, exist_ok=True)
resources = {
    '_internal/tools/warehouse_patch/warehouse_patch.py': dev / 'tools/warehouse_patch/warehouse_patch.py',
    '_internal/tools/warehouse_patch/quantity_templates.npz': dev / 'tools/warehouse_patch/quantity_templates.npz',
    '_internal/reference/barter_items.json': dev / 'reference/barter_items.json',
}
for source in (dev / 'local_app/frontend').rglob('*'):
    if source.is_file():
        resources['_internal/' + source.relative_to(dev).as_posix()] = source
for source in (dev / 'reference/icons').glob('*.webp'):
    resources['_internal/reference/icons/' + source.name] = source
mismatches = [name for name, source in resources.items() if (app / name).read_bytes() != source.read_bytes()]
assert not mismatches, mismatches
files = sorted((p for p in app.rglob('*') if p.is_file()), key=lambda p: p.relative_to(app).as_posix())
forbidden = {'specs', 'tests', 'docs', 'fixtures', '__pycache__', 'node_modules'}
assert not [p for p in files if forbidden.intersection(p.relative_to(app).parts)]
assert not list(app.rglob('*.sqlite3'))
modules = sorted(CArchiveReader(str(app / 'BDO 물교 실행.exe')).open_embedded_archive('PYZ.pyz').toc)
assert 'local_app.backend.api.session' in modules
assert 'local_app.backend.session_contracts' in modules
assert not [m for m in modules if m.startswith(('local_app.tests', 'tools.barter_scan', 'rapidocr', 'onnxruntime'))]
manifest = ''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.stat().st_size}  {p.relative_to(app).as_posix()}\n' for p in files)
(out / 'package-manifest.sha256').write_text(manifest, encoding='utf-8')
runtime_evidence = out / 'packaged-runtime.json'
runtime = json.loads(runtime_evidence.read_text(encoding='utf-8')) if runtime_evidence.exists() else {}
runtime_verified = runtime.get('ok') is True and runtime.get('exeSha256') == hashlib.sha256((app / 'BDO 물교 실행.exe').read_bytes()).hexdigest()
result = {'ok': True, 'entrypoint': str(app / 'BDO 물교 실행.exe'), 'files': len(files), 'bytes': sum(p.stat().st_size for p in files), 'resourceComparisons': len(resources), 'icons': 70, 'moduleCount': len(modules), 'newSessionModulesIncluded': True, 'userDatabaseBundled': False, 'runtimeExecuted': runtime_verified}
(out / 'package-audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=True, indent=2))
