from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from types import ModuleType
from typing import Any

from .contracts import hash_file, sha256_bytes


def resolve_roots(manifest_path: Path, root_map_path: Path | None = None) -> dict[str, Path]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    roots = manifest["roots"]
    profile = Path(os.environ.get("USERPROFILE", str(Path.home()))).resolve()
    artifact = (profile / roots["artifactRoot"]["relative"]).resolve()
    if not artifact.is_dir():
        raise FileNotFoundError(f"artifactRoot missing: {artifact}")
    mapped: dict[str, Path] = {}
    if root_map_path:
        raw = json.loads(root_map_path.read_text(encoding="utf-8"))
        if set(raw) - {"artifactRoot", "installedAppReadOnly"}:
            raise ValueError("root-map contains unsupported keys")
        mapped = {key: Path(value).resolve() for key, value in raw.items()}
    artifact = mapped.get("artifactRoot", artifact).resolve()
    prep = (artifact / roots["preparationRoot"]["relative"]).resolve()
    run = (artifact / roots["runRoot"]["relative"]).resolve()
    installed = mapped.get("installedAppReadOnly", Path(roots["installedAppReadOnly"]["absoluteDefault"])).resolve()
    if artifact not in prep.parents or artifact not in run.parents:
        raise ValueError("derived root escaped artifactRoot")
    if run == installed or installed in run.parents or run in installed.parents:
        raise ValueError("runRoot overlaps protected installed root")
    if run == profile or profile not in run.parents:
        raise ValueError("runRoot must remain below USERPROFILE artifact root")
    return {"artifactRoot": artifact, "preparationRoot": prep, "runRoot": run,
            "installedAppReadOnly": installed}


def load_frozen_ocr(preparation_root: Path) -> tuple[ModuleType, Path, Path]:
    code_root = preparation_root / "baseline-source" / "_dev"
    source = code_root / "local_app" / "tools" / "trade_live_ocr.py"
    model = preparation_root / "baseline-model"
    name = "_trade_template_v1_frozen_ocr"
    spec = importlib.util.spec_from_file_location(name, source)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load frozen OCR: {source}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    module._experiment_catalog_path = code_root / "local_app" / "frontend" / "data" / "trade-catalog.json"
    return module, source, model


def instrument_reader(module: ModuleType) -> dict[str, Any]:
    original = module.LocalReader
    telemetry: dict[str, Any] = {"modelCalls": 0, "modelSeconds": 0.0, "modelInitSeconds": 0.0,
                                 "cacheHits": 0, "cacheMisses": 0, "legacyFieldCalls": 0}

    class MeasuredReader(original):
        def __init__(self, model_dir: Path):
            started = time.perf_counter()
            super().__init__(model_dir)
            telemetry["modelInitSeconds"] += time.perf_counter() - started

        def read(self, image, digits=False, allowed_digits=None):
            before = len(self.cache)
            key = (image.size, digits, allowed_digits)
            import hashlib
            import numpy as np
            rgb = np.asarray(image.convert("RGB"))[:, :, ::-1]
            full_key = (image.size, digits, allowed_digits, hashlib.sha256(rgb.tobytes()).digest())
            if full_key in self.cache:
                telemetry["cacheHits"] += 1
                return super().read(image, digits=digits, allowed_digits=allowed_digits)
            telemetry["cacheMisses"] += 1
            started = time.perf_counter()
            result = super().read(image, digits=digits, allowed_digits=allowed_digits)
            telemetry["modelSeconds"] += time.perf_counter() - started
            telemetry["modelCalls"] += 1
            return result

    module.LocalReader = MeasuredReader
    original_functions = ("read_catalog_name", "read_count", "read_requirement", "read_yield")
    for function_name in original_functions:
        if hasattr(module, function_name):
            original_function = getattr(module, function_name)

            def wrap(function):
                def measured(*args, **kwargs):
                    telemetry["legacyFieldCalls"] += 1
                    return function(*args, **kwargs)
                return measured

            setattr(module, function_name, wrap(original_function))
    return telemetry


def frozen_hashes(manifest: dict[str, Any], preparation_root: Path) -> dict[str, Any]:
    files = []
    for entry in manifest["snapshotFiles"]:
        path = preparation_root / entry["path"]
        if not path.is_file():
            raise FileNotFoundError(f"frozen source missing: {entry['path']}")
        actual = hash_file(path)
        if actual != entry["sha256"]:
            raise ValueError(f"frozen source hash mismatch: {entry['repoPath']}")
        files.append({"repoPath": entry["repoPath"], "sha256": actual, "bytes": path.stat().st_size})
    model_files = []
    for filename in ("inference.onnx", "inference.yml"):
        path = preparation_root / "baseline-model" / filename
        if not path.is_file():
            raise FileNotFoundError(f"frozen model missing: {filename}")
        model_files.append({"path": filename, "sha256": hash_file(path), "bytes": path.stat().st_size})
    return {"sourceFiles": files, "sourceBundleSha256": sha256_bytes("\n".join(x["sha256"] for x in files).encode()),
            "modelFiles": model_files, "modelBundleSha256": manifest["modelBundleSha256"]}


def assess_drift(manifest: dict[str, Any], repo_root: Path, installed_root: Path,
                 preparation_root: Path) -> dict[str, Any]:
    current = []
    drift = []
    for entry in manifest["snapshotFiles"]:
        path = repo_root / Path(entry["repoPath"].replace("/", os.sep))
        if not path.is_file():
            drift.append({"path": entry["repoPath"], "expected": entry["sha256"], "actual": None})
            continue
        actual = hash_file(path)
        current.append({"path": entry["repoPath"], "sha256": actual})
        if actual != entry["sha256"]:
            drift.append({"path": entry["repoPath"], "expected": entry["sha256"], "actual": actual})
    installed = []
    installed_errors = []
    for entry in manifest["installedReadOnlyChecks"]:
        path = installed_root / Path(entry["path"].replace("/", os.sep))
        if not path.is_file():
            installed_errors.append({"path": entry["path"], "reason": "MISSING"})
            continue
        actual = hash_file(path)
        installed.append({"path": entry["path"], "sha256": actual})
        if actual != entry["sha256"]:
            installed_errors.append({"path": entry["path"], "reason": "HASH_MISMATCH", "actual": actual})
    return {"workingTreeDrift": drift, "installedChecks": installed, "installedErrors": installed_errors,
            "baselineDrift": bool(drift or installed_errors), "frozenPreparationRoot": str(preparation_root)}
