from __future__ import annotations

import hashlib
import html
import json
import re
from pathlib import Path
from typing import Any

from PIL import Image

from .contracts import hash_file, write_json


def _safe_relative(run_root: Path, path: Path) -> str:
    resolved = path.resolve()
    if run_root.resolve() not in resolved.parents:
        raise ValueError(f"artifact escaped runRoot: {path}")
    return resolved.relative_to(run_root.resolve()).as_posix()


def build_review(run_root: Path, captures: list[dict[str, Any]], baseline: dict[str, Any],
                 candidate: dict[str, Any] | None, trace: list[dict[str, Any]], truths: list[dict[str, Any]]) -> Path:
    review_root = run_root / "review"
    crop_root = review_root / "crops"
    crop_root.mkdir(parents=True, exist_ok=True)
    cap_map = {str(c["captureId"]): c for c in captures}
    base_rows = {(str(r.get("captureId")), int(r.get("ordinal", -1))): r for r in baseline.get("rows", [])}
    cand_rows = {(str(r.get("captureId")), int(r.get("ordinal", -1))): r for r in (candidate or {}).get("rows", [])}
    truth_map = {}
    for truth in truths:
        truth_map.setdefault((truth["imageSha256"], truth["field"]), []).append(truth)
    sections = []
    for index, item in enumerate(trace):
        cap = cap_map.get(str(item.get("captureId")))
        if not cap:
            continue
        field = str(item.get("field", ""))
        key = (str(item.get("captureId")), int(item.get("ordinal", -1)))
        base = base_rows.get(key, {}).get("fields", {}).get(field, {})
        cand = cand_rows.get(key, {}).get("fields", {}).get(field, {})
        box = item.get("matchedBox")
        crop_src = ""
        if box:
            source = Path(cap["imagePath"])
            try:
                with Image.open(source) as image:
                    crop = image.convert("RGB").crop((int(box["x"]), int(box["y"]), int(box["x"] + box["width"]), int(box["y"] + box["height"])))
                crop_path = crop_root / f"{index:05d}-{hashlib.sha256(crop.tobytes()).hexdigest()[:12]}.png"
                crop.save(crop_path)
                crop_src = crop_path.resolve().relative_to(review_root.resolve()).as_posix()
            except Exception:
                crop_src = ""
        image_sha = cap.get("imageSha256")
        matching_truths = truth_map.get((image_sha, field), [])
        truth_text = ", ".join(str(t.get("value")) for t in matching_truths) if matching_truths else "확인된 정답 없음"
        body = (f"<article><h2>{html.escape(field)} · {html.escape(str(item.get('status')))} / {html.escape(str(item.get('reason') or ''))}</h2>"
                f"<p>캡처 {html.escape(str(item.get('captureId')))} · 행 {html.escape(str(item.get('ordinal')))} · 종류 {html.escape(str(item.get('kind') or ''))}</p>"
                f"<p>정답: {html.escape(truth_text)} · B0: {html.escape(str(base.get('corrected')))} (review={html.escape(str(base.get('reviewRequired')))}) · 후보: {html.escape(str(cand.get('corrected')))} (review={html.escape(str(cand.get('reviewRequired')))})</p>"
                + (f'<figure><img src="{html.escape(crop_src)}" alt="source crop"><figcaption>원본 비교 crop</figcaption></figure>' if crop_src else "")
                + (f'<figure><img src="../data/png/{html.escape(str(image_sha))}.png" alt="full capture"><figcaption>원본 캡처</figcaption></figure>' if image_sha else "")
                + f"<p>reference: {html.escape(', '.join(item.get('referenceIds', [])))}</p></article>")
        sections.append(body)
    document = "<!doctype html><html lang=\"ko\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Trade template review</title><style>body{font:15px system-ui,sans-serif;background:#10151e;color:#e6edf7;margin:2rem}article{border:1px solid #344258;border-radius:10px;padding:1rem;margin:1rem 0}figure{display:inline-block;vertical-align:top;margin:.5rem}img{max-width:min(987px,90vw);max-height:300px;object-fit:contain;background:#222}p{overflow-wrap:anywhere;color:#c2d2e6}</style><h1>TRADE-TEMPLATE-V1 offline review</h1>" + "\n".join(sections) + "</html>"
    path = review_root / "review.html"
    path.write_text(document, encoding="utf-8")
    return path


def _money(value: Any, digits: int = 2) -> str:
    return "미측정" if value is None else f"{value:.{digits}f}"


def write_report(run_root: Path, report: dict[str, Any], variant_reports: dict[str, dict[str, Any]],
                 data_summary: dict[str, Any], bank_summary: dict[str, Any], performance: dict[str, Any],
                 limitations: list[str]) -> Path:
    lines = ["# 물교 기준 이미지 실험 결과", "", f"- 전체 판정: **{report['overallStatus']}**",
             f"- 최종 후보: **{report.get('finalCandidate') or '없음'}**",
             f"- 검증 정답 필드: {data_summary.get('truthFieldCount', 0)}개 / 격리: {data_summary.get('quarantinedFieldCount', 0)}개",
             f"- bank: {bank_summary.get('references', 0)}개 기준 crop / {bank_summary.get('contexts', 0)}개 문맥",
             f"- bank 종류별 crop: `{json.dumps(bank_summary.get('byKind', {}), ensure_ascii=False)}`",
             f"- warehouse history는 별도 감사만 수행: {data_summary.get('warehouseRecordsAuditedOnly', 0)}건",
             "", "## 후보 비교", "", "| 버전 | 판정 | 확인 필드 정확도 | 신규 자동 오답 | 미확인 변경 | paired wall 단축 | 6장 호출 수 / paired 감소 |", "|---|---|---:|---:|---:|---:|---:|"]
    for variant in ("B0", "V1", "V2", "V3"):
        item = variant_reports.get(variant, {})
        quality = item.get("quality", {})
        perf = item.get("performance", {})
        screen_calls = perf.get("screeningModelCalls")
        lines.append(f"| {variant} | {item.get('status', 'NOT_RUN')} | {_money(quality.get('verifiedFieldAccuracy') * 100 if quality.get('verifiedFieldAccuracy') is not None else None)}% | {quality.get('newVerifiedWrongAutoAccept', 0)} | {quality.get('unverifiedChangedFields', 0)} / {quality.get('unverifiedReviewRelaxations', 0)} | {_money(perf.get('observedMedianGain') * 100 if perf.get('observedMedianGain') is not None else None)}% | {screen_calls if screen_calls is not None else '미측정'} / {_money(perf.get('modelCallReduction') * 100 if perf.get('modelCallReduction') is not None else None)}% |")
    lines += ["", "## 자료와 판정 근거", "", f"- 정답 종류별 수: `{json.dumps(data_summary.get('truthCountsByClass', {}), ensure_ascii=False)}`",
              f"- split group: `{json.dumps(data_summary.get('splitGroupCounts', {}), ensure_ascii=False)}`",
              f"- 확인 필드 bank 적용: `{json.dumps(bank_summary.get('byKind', {}), ensure_ascii=False)}`",
              f"- 실제 앱 변경: 아니오 · 운영 DB/API 쓰기: 0 · 서버 재시작: 아니오 · commit/push: 아니오",
              "- 이 결과는 offline 비교이며 실제 게임/실사용 승인이나 앱 적용을 의미하지 않습니다.", "", "## 한계", ""]
    lines.extend(f"- {value}" for value in limitations)
    lines += ["", "세부 오류·검수 변화와 source crop은 `review/review.html`에서 확인할 수 있습니다.", ""]
    path = run_root / "REPORT.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def validate_report(report: dict[str, Any]) -> list[str]:
    errors = []
    required = {"schemaVersion", "specId", "overallStatus", "stageStatus", "production", "provenance",
                "data", "variants", "finalCandidate", "limitations", "artifactFiles"}
    errors.extend(f"missing:{key}" for key in sorted(required - set(report)))
    if report.get("schemaVersion") != 1 or report.get("specId") != "TRADE-TEMPLATE-V1":
        errors.append("schema/spec version mismatch")
    statuses = {"EXECUTION_FAILED", "NO_GO_QUALITY", "HOLD_DATA", "HOLD_BASELINE_DRIFT", "BENCH_CONTENDED", "HOLD_PERFORMANCE", "NO_OP", "OFFLINE_REVIEW_READY"}
    if report.get("overallStatus") not in statuses:
        errors.append("invalid overallStatus")
    for name in ("S0", "S1", "S2", "S3", "S4", "S5", "S6"):
        if report.get("stageStatus", {}).get(name) not in {"NOT_RUN", "PASS", "FAIL", "HOLD_DATA"}:
            errors.append(f"invalid stageStatus:{name}")
    for name, value in report.get("provenance", {}).items():
        if "Sha256" in name and value is not None and not re.fullmatch(r"[0-9a-f]{64}", value):
            errors.append(f"invalid hash:{name}")
    production = report.get("production", {})
    if production != {"appChanged": False, "liveDbWrites": 0, "liveApiWrites": 0,
                      "serverRestarted": False, "committed": False, "pushed": False}:
        errors.append("production boundary fields changed")
    for item in report.get("artifactFiles", []):
        if not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", "")):
            errors.append(f"invalid artifact hash:{item.get('path')}")
    return errors


def build_artifact_index(run_root: Path) -> Path:
    entries = []
    for path in sorted(run_root.rglob("*")):
        if not path.is_file() or path.name in {"artifact-index.json", "report.json"}:
            continue
        entries.append({"path": _safe_relative(run_root, path), "bytes": path.stat().st_size,
                        "sha256": hash_file(path)})
    target = run_root / "artifact-index.json"
    write_json(target, {"schemaVersion": 1, "files": entries})
    return target
