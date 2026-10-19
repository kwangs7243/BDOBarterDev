import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
SPEC = ROOT / 'local_app/packaging/bdo-barter.spec'
BASE = ROOT / 'tools/warehouse_patch/quantity_templates.npz'


class WarehousePackageAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='warehouse-package-assets-')
        self.root = Path(self.temporary.name)
        self.spec_path = self.root / 'local_app/packaging'
        self.spec_path.mkdir(parents=True)
        bank = self.root / 'local_app/recognition_data/trade-templates.json'
        bank.parent.mkdir(parents=True)
        shutil.copyfile(ROOT / 'local_app/recognition_data/trade-templates.json', bank)
        self.trade = self.root / 'trade-model'
        self.trade.mkdir()
        for filename in ('inference.onnx', 'inference.yml'):
            (self.trade / filename).write_bytes(b'fixture')
        self.environment = patch.dict(os.environ, {'BDO_PACKAGE_TRADE_MODEL_DIR': str(self.trade)})
        self.environment.start()
        os.environ.pop('BDO_PACKAGE_WAREHOUSE_TEMPLATES', None)

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def load_assets(self):
        namespace = {'SPECPATH': str(self.spec_path)}
        # Run the actual asset selection without starting PyInstaller or its executables.
        source = SPEC.read_text(encoding='utf-8').split('\na = Analysis(', 1)[0]
        exec(compile(source, str(SPEC), 'exec'), namespace)
        return namespace

    def calibrated(self, *, verified_rows=1):
        path = self.root / 'calibrated.npz'
        with np.load(BASE, allow_pickle=False) as archive:
            data = {key: archive[key] for key in archive.files}
        data.update(feedback_slots=np.zeros((1, 43, 43, 3), dtype=np.uint8),
                    feedback_values=np.array([17]), feedback_item_names=np.array(['checked item']),
                    feedback_provenance_json=np.asarray(json.dumps({'verifiedRows': verified_rows})))
        np.savez_compressed(path, **data)
        return path

    def test_worktree_missing_calibration_cannot_fall_back_to_base(self):
        base = self.root / 'tools/warehouse_patch/quantity_templates.npz'
        base.parent.mkdir(parents=True)
        shutil.copyfile(BASE, base)
        with self.assertRaisesRegex(RuntimeError, 'Verified warehouse feedback templates are required'):
            self.load_assets()

    def test_explicit_base_templates_are_rejected(self):
        os.environ['BDO_PACKAGE_WAREHOUSE_TEMPLATES'] = str(BASE)
        with self.assertRaisesRegex(RuntimeError, 'base templates are insufficient'):
            self.load_assets()

    def test_explicit_calibration_is_included_in_installed_resource_path(self):
        calibrated = self.calibrated()
        os.environ['BDO_PACKAGE_WAREHOUSE_TEMPLATES'] = str(calibrated)
        assets = self.load_assets()
        self.assertIn((str(calibrated), 'tools/warehouse_patch'), assets['datas'])
        self.assertIn((str(self.root / 'local_app/recognition_data/trade-templates.json'),
                       'local_app/recognition_data'), assets['datas'])
        self.assertEqual(assets['canonicalize_warehouse_data']([
            ('tools/warehouse_patch/calibrated.npz', str(calibrated), 'DATA')]), [
            ('tools/warehouse_patch/quantity_templates.npz', str(calibrated), 'DATA')])
        self.assertEqual(assets['verified_rows'], 1)

    def test_mismatched_verified_row_provenance_is_rejected(self):
        os.environ['BDO_PACKAGE_WAREHOUSE_TEMPLATES'] = str(self.calibrated(verified_rows=2))
        with self.assertRaisesRegex(RuntimeError, 'verified-row provenance do not agree'):
            self.load_assets()
