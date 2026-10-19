from __future__ import annotations

import ctypes
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .contracts import write_json


class FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", ctypes.c_ulong), ("dwHighDateTime", ctypes.c_ulong)]


def _ft_value(value: FILETIME) -> int:
    return (int(value.dwHighDateTime) << 32) | int(value.dwLowDateTime)


def system_cpu_percent(sample_seconds: float = 1.0) -> float:
    kernel_a, user_a, idle_a = FILETIME(), FILETIME(), FILETIME()
    kernel_b, user_b, idle_b = FILETIME(), FILETIME(), FILETIME()
    get_times = ctypes.windll.kernel32.GetSystemTimes
    get_times.argtypes = [ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME)]
    get_times.restype = ctypes.c_int
    if not get_times(ctypes.byref(idle_a), ctypes.byref(kernel_a), ctypes.byref(user_a)):
        raise OSError("GetSystemTimes failed")
    time.sleep(sample_seconds)
    if not get_times(ctypes.byref(idle_b), ctypes.byref(kernel_b), ctypes.byref(user_b)):
        raise OSError("GetSystemTimes failed")
    idle = _ft_value(idle_b) - _ft_value(idle_a)
    total = (_ft_value(kernel_b) - _ft_value(kernel_a)) + (_ft_value(user_b) - _ft_value(user_a))
    return 100.0 * (1.0 - idle / total) if total > 0 else 0.0


def set_idle_priority() -> int:
    kernel = ctypes.windll.kernel32
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    kernel.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel.SetPriorityClass.restype = ctypes.c_int
    kernel.GetPriorityClass.argtypes = [ctypes.c_void_p]
    kernel.GetPriorityClass.restype = ctypes.c_ulong
    process = kernel.GetCurrentProcess()
    if not kernel.SetPriorityClass(process, 64):
        raise OSError(ctypes.get_last_error(), "SetPriorityClass failed")
    observed = int(kernel.GetPriorityClass(process))
    if observed != 64:
        raise OSError(f"priority verification failed: {observed}")
    return observed


def preflight_load(samples: int = 5) -> list[float]:
    return [system_cpu_percent(1.0) for _ in range(samples)]


def run_arm(run_root: Path, run_id: str, captures: list[dict[str, Any]], variant: str,
            config_path: Path, manifest_path: Path, preparation_root: Path,
            bank_path: Path, provenance_path: Path, timeout_seconds: int = 300) -> dict[str, Any]:
    bench_root = run_root / "benchmark"
    arm_dir = bench_root / f"{variant}-{int(time.time() * 1000)}"
    arm_dir.mkdir(parents=True, exist_ok=False)
    input_path = arm_dir / "arm-input.json"
    output_path = arm_dir / "arm-output.json"
    input_payload = {"runId": run_id, "captures": [{"captureId": item["captureId"],
                    "imagePath": str(Path(item["imagePath"]).resolve()), "metadata": item.get("metadata", {}),
                    "imageSha256": item.get("imageSha256")} for item in captures],
                    "variant": variant, "batchId": f"template-v1-{run_id}-{variant}",
                    "preparationRoot": str(preparation_root), "configPath": str(config_path),
                    "manifestPath": str(manifest_path), "bankPath": str(bank_path),
                    "provenancePath": str(provenance_path), "outputPath": str(output_path)}
    write_json(input_path, input_payload)
    sandbox = bench_root / "localappdata" / f"{variant}-{int(time.time() * 1000)}"
    sandbox.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["LOCALAPPDATA"] = str(sandbox)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["OMP_NUM_THREADS"] = "1"
    env["OPENBLAS_NUM_THREADS"] = "1"
    env["MKL_NUM_THREADS"] = "1"
    command = [sys.executable, "-B", "-m", "tools.experiments.trade_template_v1.cli",
               "arm", "--input", str(input_path)]
    started = time.perf_counter()
    process = subprocess.Popen(command, cwd=str(Path(__file__).resolve().parents[3]), env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    kernel = ctypes.windll.kernel32
    class FILETIME(ctypes.Structure):
        _fields_ = [("dwLowDateTime", ctypes.c_ulong), ("dwHighDateTime", ctypes.c_ulong)]
    class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
    get_process_times = kernel.GetProcessTimes
    get_process_times.argtypes = [ctypes.c_void_p, ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME)]
    get_process_times.restype = ctypes.c_int
    creation, exit_time, kernel_before, user_before = FILETIME(), FILETIME(), FILETIME(), FILETIME()
    if not get_process_times(ctypes.c_void_p(process._handle), ctypes.byref(creation), ctypes.byref(exit_time), ctypes.byref(kernel_before), ctypes.byref(user_before)):
        process.kill()
        process.communicate()
        raise OSError("GetProcessTimes start sample failed")
    get_memory = ctypes.windll.psapi.GetProcessMemoryInfo
    get_memory.argtypes = [ctypes.c_void_p, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), ctypes.c_ulong]
    get_memory.restype = ctypes.c_int
    peak_working_set = None
    cpu_samples: list[float] = []
    timeout = time.monotonic() + timeout_seconds
    while process.poll() is None:
        if time.monotonic() >= timeout:
            process.kill()
            process.communicate()
            raise TimeoutError(f"benchmark arm exceeded {timeout_seconds}s: {variant}")
        time.sleep(1.0)
        if process.poll() is None:
            cpu_samples.append(system_cpu_percent(.01))
            counters = PROCESS_MEMORY_COUNTERS()
            counters.cb = ctypes.sizeof(counters)
            if get_memory(ctypes.c_void_p(process._handle), ctypes.byref(counters), counters.cb):
                peak_working_set = max(peak_working_set or 0, int(counters.WorkingSetSize))
    stdout, stderr = process.communicate()
    wall = time.perf_counter() - started
    if process.returncode != 0:
        write_json(arm_dir / "process-error.json", {"returnCode": process.returncode,
                                                      "stdout": stdout[-5000:], "stderr": stderr[-5000:]})
        raise RuntimeError(f"benchmark child failed ({variant}, rc={process.returncode}); see {arm_dir}")
    result = json.loads(output_path.read_text(encoding="utf-8"))
    metrics = result.pop("_experimentMetrics", {})
    if not get_process_times(ctypes.c_void_p(process._handle), ctypes.byref(creation), ctypes.byref(exit_time), ctypes.byref(kernel_before), ctypes.byref(user_before)):
        process_cpu = None
    else:
        ticks = 10_000_000
        process_cpu = ((int(kernel_before.dwHighDateTime) << 32 | int(kernel_before.dwLowDateTime))
                       + (int(user_before.dwHighDateTime) << 32 | int(user_before.dwLowDateTime))) / ticks
    payload = {"variant": variant, "processWallSeconds": wall,
               "recognitionWallSeconds": metrics.get("recognitionWallSeconds"),
               "processCpuSeconds": process_cpu, "modelInitSeconds": metrics.get("modelInitSeconds"),
               "modelCalls": metrics.get("modelCalls"), "modelSeconds": metrics.get("modelSeconds"),
               "templateLookupSeconds": sum(x.get("lookupSeconds", 0) for x in result.get("_trace", [])),
               "templateHits": sum(1 for x in result.get("_trace", []) if x.get("status") == "HIT"),
               "templateAbstentions": sum(1 for x in result.get("_trace", []) if x.get("status") == "ABSTAIN"),
               "fallbackFieldCalls": metrics.get("legacyFieldCalls"), "peakWorkingSetBytes": peak_working_set,
               "cpuLoadSamples": cpu_samples, "cpuLoadMedian": statistics.median(cpu_samples) if cpu_samples else None,
               "priorityClassObserved": metrics.get("priorityClassObserved"),
               "bankReferencesLoaded": metrics.get("bankReferencesLoaded"),
               "returnCode": process.returncode, "result": result, "trace": result.pop("_trace", [])}
    write_json(arm_dir / "arm-result.json", payload)
    return payload


def _worker(input_path: Path) -> int:
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    from .baseline import frozen_hashes, instrument_reader, load_frozen_ocr
    from .engine import run_experiment
    from .matcher import load_bank
    manifest = json.loads(Path(payload["manifestPath"]).read_text(encoding="utf-8"))
    prep_root = Path(payload["preparationRoot"])
    frozen_hashes(manifest, prep_root)
    priority = set_idle_priority()
    module, _, model_dir = load_frozen_ocr(prep_root)
    telemetry = instrument_reader(module)
    bank_disk = json.loads(Path(payload["bankPath"]).read_text(encoding="utf-8"))
    provenance = json.loads(Path(payload["provenancePath"]).read_text(encoding="utf-8"))
    run_root = Path(payload["bankPath"]).parents[1]
    bank = load_bank(run_root, provenance)
    captures = [{**item, "imagePath": Path(item["imagePath"])} for item in payload["captures"]]
    result, trace = run_experiment(captures, model_dir, payload["batchId"], payload["variant"],
                                   "FAST", bank, module, json.loads(Path(payload["configPath"]).read_text(encoding="utf-8")), telemetry)
    telemetry["priorityClassObserved"] = priority
    telemetry["bankReferencesLoaded"] = bank.get("summary", {}).get("references", 0)
    result["_experimentMetrics"] = {**result.get("_experimentMetrics", {}), **telemetry}
    result["_trace"] = trace
    write_json(Path(payload["outputPath"]), result)
    return 0
