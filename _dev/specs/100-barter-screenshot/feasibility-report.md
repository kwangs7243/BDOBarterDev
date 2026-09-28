# SPEC-100 Barter Screenshot Feasibility

## Samples

`물교리스트스샷/` contains one expected JSON (`정답.json`) and 16 PNG screenshots. Treating the 16 time-ordered captures as one batch paired with that JSON is supported by matching row totals: the geometry detector finds 80 rows, the JSON contains 80 rows, and all 80 expected identity tuples are distinct. This is a batch-level pairing; the supplied files do not contain per-image row IDs or scroll positions to prove row-by-row correspondence. No screenshot-only or JSON-only files were found. Visible row identity overlap was not observed, but cannot be ruled out solely from the batch totals.

| Screenshot | Resolution | Detected rows |
|---|---:|---:|
| `Codex 이미지 2026년 9월 25일 오후 08_43_53.png` | 986×455 | 6 |
| `Codex 이미지 2026년 9월 25일 오후 08_44_44.png` | 990×302 | 4 |
| `Codex 이미지 2026년 9월 25일 오후 08_44_48.png` | 988×455 | 6 |
| `Codex 이미지 2026년 9월 25일 오후 08_44_52.png` | 994×303 | 4 |
| `Codex 이미지 2026년 9월 25일 오후 08_44_56.png` | 986×455 | 6 |
| `Codex 이미지 2026년 9월 25일 오후 08_44_59.png` | 990×378 | 5 |
| `Codex 이미지 2026년 9월 25일 오후 08_45_03.png` | 986×454 | 6 |
| `Codex 이미지 2026년 9월 25일 오후 08_45_09.png` | 985×376 | 5 |
| `Codex 이미지 2026년 9월 25일 오후 08_45_13.png` | 987×456 | 6 |
| `Codex 이미지 2026년 9월 25일 오후 08_45_16.png` | 989×157 | 2 |
| `Codex 이미지 2026년 9월 25일 오후 08_45_20.png` | 985×458 | 6 |
| `Codex 이미지 2026년 9월 25일 오후 08_45_25.png` | 989×458 | 6 |
| `Codex 이미지 2026년 9월 25일 오후 08_45_28.png` | 990×455 | 6 |
| `Codex 이미지 2026년 9월 25일 오후 08_45_33.png` | 987×77 | 1 |
| `Codex 이미지 2026년 9월 25일 오후 08_45_37.png` | 990×451 | 6 |
| `Codex 이미지 2026년 9월 25일 오후 08_45_41.png` | 991×378 | 5 |

The set contains general barter and Crow Coin rows (11 Crow Coin rows in the oracle). Both required ellipsis examples are visible in this capture batch. `금주화가 담긴 낡은 ...` is represented as the full canonical `fromItem` in the oracle. The oracle's row 74 instead stores the island as `까마귀 상단 소유의 ...`; that disagrees with the instruction to use the canonical full island when resolvable. The oracle was not edited.

## Original Import Contract

The original HTML's trade screenshot prompt emits objects with `island`, `fromItem`, `reqAmount`, `toItem`, `count`, and `yield`; its meaning is unchanged here. SPEC-004 `processParsedTrades` uses a closed item catalog and safe unique item matching for outputs and non-land inputs, island matching according to output tier, and keeps the raw land input for 0→1 rows. It defaults invalid/missing `reqAmount` to 1 and `count` to 0 only after required matching succeeds. This prototype adds no filtering and does not change the importer.

Importing the expected JSON directly through the existing SPEC-004 importer accepted 78 rows, rejected 2 unmatched `toItem` rows, and reported no duplicates or conflicts. Rejected rows (zero-based JSON indexes 67 and 68) have outputs `심해의 기억이 담긴 아교` and `섬나무 증착합판`, respectively, neither of which matched the current importer catalog. Those results are application filtering, not recognition accuracy.

## Screen Layout

The screenshots are tightly cropped row-list captures, 985–994 px wide and 77–458 px tall. Pixel-difference autocorrelation independently finds a 75 px vertical row period in every image (correlation 0.859–1.000); rounding image height against that period gives 1–6 rows per capture and 80 total. This detects the repeated row structure without relying on a fixed absolute y origin. The visible row contains an island and remaining-count text at left, an input icon/name/quantity and negotiation cost, a centered arrow, then an output icon/name/yield at right. Horizontal row boundaries repeat at the measured period. There is no header in these tight crops. The batch is one apparent UI scale; no scale-variation test was possible. No row clipping was identified by the measured repeated structure, though content recognition is unavailable.

The prototype detects row count only. It has not validated field crop bounds, OCR reading zones, or image-template matching. The row period is measurable; the actual field contents are not machine-read by this prototype.

## Ellipsis Canonicalization

The prototype strips only terminal `...` / `…` and surrounding trailing whitespace, then performs a field-specific `startswith` search. Exact values return `EXACT`; one prefix candidate returns `UNIQUE_PREFIX`; multiple candidates return `AMBIGUOUS`; zero candidates return `UNKNOWN`. The latter two have no value and remain HOLD. No Levenshtein or nearest-candidate choice is used.

The item vocabulary is SPEC-004's `masterData` tiers plus its special items. Island vocabulary is the existing trade catalog's island list. Automated regressions passed:

- `금주화가 담긴 낡은 ...` → `금주화가 담긴 낡은 상자`: `UNIQUE_PREFIX`.
- `까마귀 상단 소유의 ...` → `까마귀 상단 소유의 선박`: `UNIQUE_PREFIX`.
- Synthetic prefix matching two candidates: `AMBIGUOUS`, no confirmed value.
- Nonmatching prefix: `UNKNOWN`, no confirmed value.

The island canonicalization result conflicts with the literal island value in oracle row 74. This mismatch is recorded rather than normalizing or changing the oracle.

## Recognition Pipeline

The evaluated prototype is offline and deterministic: screenshot pixels → vertical row-period detection → row slots → HOLD. It does not use expected JSON as recognizer input. No Tesseract executable, `pytesseract`, EasyOCR, PaddleOCR, RapidOCR, OpenCV, ONNX Runtime, WinRT OCR binding, Torch, or Transformers package was available in the inspected environment. Therefore:

- OCR-only: not executable; no Korean OCR engine.
- Icon-only: not executable as recognition; references include icons for 70 items, not a complete 118-item tier catalog plus specials, and there is no validated screenshot-to-icon identity matcher.
- OCR + closed vocabulary: the canonicalizer is testable and safe, but it has no OCR text to consume.
- Row detection + field OCR/template: row detection works; field OCR/template stage is unavailable and field crop accuracy is unmeasured.
- Icon + OCR hybrid: cannot be evaluated without OCR and a validated icon matcher.

Runtime used for pixel geometry was the existing bundled Python 3.12.14 with Pillow 12.3.0 and NumPy 2.3.5. No dependency was added or downloaded, and no screenshot was sent over the network.

## Prototype

- `tools/barter_scan/barter_scan.py`: deterministic offline row-period probe, JSON-shaped confirmed/held result, and field-scoped unique-prefix resolver.
- `tools/barter_scan/test_barter_scan.py`: six tests for both required prefixes, ambiguous and unknown prefixes, sample row detection, and ten-run determinism.
- Run with bundled Python 3.12: `& "C:\Users\kwang\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" tools/barter_scan/barter_scan.py`.
- Run the prototype regressions: `& "C:\Users\kwang\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m unittest discover -s tools/barter_scan -p "test_*.py" -v`.

## Recognition Accuracy

The recognizer does not treat geometry alone as proof of row field values. It returns no confirmed rows and marks all detected slots HOLD because Korean OCR is unavailable.

| Metric | Result |
|---|---:|
| Ground-truth rows | 80 |
| Confirmed | 0 |
| Correct confirmed | 0 |
| Wrong confirmed | 0 |
| Held | 80 |
| Missed (not emitted as confirmed) | 80 |
| Duplicate rows confirmed/dropped | 0 / 0 |

`wrong confirmed = 0` is a consequence of abstaining on every row, not evidence of recognition accuracy. Exact recognition comparison is 0/80 rows. The oracle has 80 unique identity tuples, so there is no expected-JSON identity duplication; actual overlap between screenshots is not provable from this single batch without recognized fields or scroll metadata.

## Import Equivalence

Contract B was exercised independently from recognition:

- Expected JSON → existing importer: 78 accepted, 2 unmatched/rejected, 0 duplicate, 0 conflict.
- Prototype confirmed JSON → existing importer: 0 accepted, 0 rejected (the prototype confirmed array is empty).
- Accepted current trade lists: not equivalent (78 expected-imported rows versus 0 prototype-imported rows).

This is a failed equivalence check caused by unavailable field recognition, not a change to or failure in SPEC-004. Expected JSON rows were not removed from recognition scoring because the importer would reject them.

## Determinism

The prototype was executed ten times over the same screenshot set. Canonical JSON SHA-256 was identical in all ten runs:

`c7d18fed68c369e8bd1f0826fb64308720c97265a36b507e0ac6a34135175664`

Canonical serialization sorts object keys and omits timestamps, paths outside the image names, and elapsed time. Test result: 10/10 identical; six prototype unit tests passed.

## Failure Modes

- The runtime has Pillow and NumPy but no available local Korean OCR engine; all 80 rows therefore remain HOLD.
- OCR-only, digit recognition, item/island field recognition, and actual icon matching accuracy are unmeasured.
- Only one image scale and one paired batch were supplied. Batch row totals match the oracle, but individual screenshot-to-row correspondence and any scroll overlap cannot be proven from metadata.
- Oracle row 74 retains an island ellipsis where the required resolver yields the canonical full island. The oracle should be reviewed by the owner before it is used as an exact canonical-string oracle; it was left untouched in this task.
- Direct import reveals two expected outputs absent from the current item catalog. Those rows are rejected by the existing parser and are separate from screenshot recognition.

## Dependency / Packaging Impact

No production package, `local_app`, launcher, PyInstaller specification, HTML, parser, scheduler, completion code, or warehouse scanner was changed. Pillow and NumPy were already available in the bundled Python used for this prototype. No OCR dependency was installed and no production dependency contract was changed.

## Recommendation

**GPT_FALLBACK_RECOMMENDED** for the current environment, with human review retained. This is an environment-limited feasibility result: the geometry and safe prefix canonicalizer are viable, but no screenshot field was recognized and import equivalence did not pass. It does not establish that a local OCR design is inherently inaccurate. Keep production integration out of scope until a supported offline Korean OCR engine is available and tested against this oracle, the oracle's truncated island is reconciled, and the complete sample set reaches exact field-level recognition/import comparison. No GPT/Gemini API was called in this work.

## Phase 2 — Offline Korean OCR Evaluation

Phase 1 above is retained as the historical result: no Korean OCR engine had been evaluated then. Phase 2 uses a disposable OCR test venv under the user's temporary directory. No OCR package or model was added to the production app or `local_app/pyproject.toml`.

### OCR candidates and environment

- **Primary evaluated candidate:** RapidOCR ONNX Runtime 1.4.4, Korean PP-OCRv4 recognition model, CPU inference on Python 3.12.14. `rapidocr` 3.9.2 was also present in the experiment environment; the prototype calls `rapidocr_onnxruntime`.
- **Model/data:** `korean_PP-OCRv4_rec_mobile.onnx`, 24,067,780 bytes, SHA-256 `ab151ba9065eccd98f884cf4d927db091be86137276392072edd4f9d43ad7426`; Korean dictionary 14,480 bytes, SHA-256 `aa1fdc8ae8f7cd40a0ec4edb472eb0421e11427e6ccfee9915440742c18b0a20`. The downloaded Korean recognition model is usable offline; detector/classifier models are package-provided.
- **Second runnable candidate:** Windows `Windows.Media.Ocr` via `winrt-Windows.Media.Ocr` 3.2.1, using the OS Korean recognizer. OCR ran across all 16 screenshots in 2.803 seconds total (0.1752 seconds mean/image; image decoding excluded). On a five-row sample, remaining-count text was read in all five; some island/input/output text was correct, while small icon quantity fields were unreliable. This does not establish exact 80-row field accuracy. A Korean OS recognizer must be installed.
- Tesseract was not installed. Its Windows installation path requires a third-party Windows build, so it was not introduced into the machine. Two OCR approaches were runnable.
- The isolated env versions include Pillow 12.3.0, NumPy 2.5.3, ONNX Runtime 1.30.0 and OpenCV 5.0.0.93. Measured installed directories were about 44 MiB for ONNX Runtime and 112 MiB for OpenCV. NumPy and Pillow are already declared app dependencies. A future RapidOCR package addition is estimated at roughly 196 MiB including the Korean model, before packaging compression. This package cost was not added to production.
- The WinRT bridge modules occupied about 3.8 MiB in the experiment venv, excluding Windows OCR components/language data already managed by the OS. They are not interchangeable with a self-contained, vendored OCR model.
- References: [RapidOCR ONNX Runtime](https://pypi.org/project/rapidocr-onnxruntime/), [RapidAI model configuration](https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/default_models.yaml), [Microsoft OCR language availability](https://learn.microsoft.com/ko-kr/uwp/api/windows.media.ocr.ocrengine.availablerecognizerlanguages?view=winrt-26100).

### Recognition pipeline and measurements

The prototype runs Korean OCR on screenshot pixels, assigns boxes to the six fields using row-relative UI regions, and uses separately enlarged crops for the input and yield quantities. Item/island strings are validated against existing closed vocabularies. Item ellipsis resolves only on a unique prefix. For the contracted island, exported `island` remains `까마귀 상단 소유의 ...`; the internal candidate may be `까마귀 상단 소유의 선박`. High-confidence text outside the current item vocabulary is recorded as `UNVERIFIED_TEXT`; it is not automatically confirmed. Recognition never reads the expected JSON.

The 16 ordered screenshots produced 80/80 row slots. After field-lane/crop corrections, the completed evaluation was:

| Field | Exact against oracle |
|---|---:|
| island | 70/80 (87.5%) |
| fromItem | 36/80 (45.0%) |
| reqAmount | 8/80 (10.0%) |
| toItem | 67/80 (83.8%) |
| count | 80/80 (100%) |
| yield | 10/80 (12.5%) |

The full RapidOCR pass including model initialization, full-image detection, and 160 number crops took about 142 seconds on this PC (about 8.9 seconds/image). OCR package downloads and the 10-run determinism suite are excluded from that per-batch figure. Windows OCR is much faster at text-line recognition, but the evaluated sample did not establish sufficiently reliable quantity extraction; it was not selected as the recognizer.

All six fields must have a safe, non-held status for a row to enter `confirmed`. The evaluated batch had ground truth 80, confirmed 0, exact-correct 0, wrong-confirmed 0, held 80, missed 0, exact rows 0/80. `wrong-confirmed = 0` is vacuous because no row was confirmed. Small icon-overlay quantities are the primary limitation; uncertain digits are held rather than filled with defaults. This misses the 76/80 target and is not a successful complete-row recognizer.

The CLI can evaluate new screenshot folders without code edits:

```powershell
& "<Python executable in the isolated OCR venv>" tools/barter_scan/barter_scan.py `
  --images "<new screenshot folder>" `
  --model-dir "<directory containing rapidocr_korean.yaml and the Korean model>" `
  --output result.json --report report.json
```

`result.json` contains only complete, safely resolved six-field rows. `report.json` includes all detected candidate rows, per-field HOLD statuses, raw OCR, and expected/actual mismatches when `--expected` is supplied. This separation prevents a partial row's null `reqAmount` or `count` from reaching importer defaults. The oracle is evaluation-only and never passed into recognition.

### Expected importer audit

The two previously reported rejected oracle rows were checked against both the original HTML importer and SPEC-004 `processParsedTrades`. Both reject both rows for unmatched `toItem`; this is not a new SPEC-004 regression and is not an OCR exclusion:

| Zero-based oracle index | Island | fromItem | reqAmount | toItem | count | yield | Original HTML | SPEC-004 |
|---:|---|---|---:|---|---:|---:|---|---|
| 67 | 에버딘 섬 | 찢어진 해적 보물지도 | 1 | 심해의 기억이 담긴 아교 | 3 | 4 | unmatched `toItem` | unmatched `toItem` |
| 68 | 네트넘 섬 | 해적 금주화 | 1 | 섬나무 증착합판 | 4 | 100 | unmatched `toItem` | unmatched `toItem` |

Both rows remain in the oracle and recognition scoring. Expected JSON through SPEC-004 yields 78 accepted, 2 rejected. The recognizer has no fully confirmed rows, so recognizer/importer equivalence is not achieved; partial rows with `null` fields are not counted as equivalent imports.

A one-time diagnostic of all 80 partial candidate rows showed 7 accepted and 73 rejected when passed directly to the pure SPEC-004 importer; the 7 are not confirmed OCR rows. This exposed that the existing importer can apply its normal missing-number defaults to partial objects. Accordingly the holdout CLI exports only `confirmed` rows (currently an empty array); per-row candidates remain in the report. No parser change was made.

### Overlap, limits, and verdict

The 80 expected identity tuples are distinct and the detector emits 80 slots in filename/vertical order. The screenshots have no per-row IDs or scroll offsets, so actual overlap between neighboring captures cannot be proven. No rows were dropped or merged. The mismatch artifact records image, row, field, expected value, actual value, OCR raw text, and matching status.

The prototype and experiment did not change `BDO_물교_v1.0.html`, `local_app/frontend/js/domain/trade-import.js`, SPEC-005 scheduler/completion, `tools/warehouse_patch/warehouse_patch.py`, or SPEC-006 launcher/package. `local_app/pyproject.toml` already declares NumPy/Pillow and was not changed. No OCR API or external screenshot upload was used.

**Phase 2 verdict: GPT_FALLBACK_RECOMMENDED.** Two local OCR approaches ran, but RapidOCR confirms 0/80 complete rows because input/yield quantities remain unreliable. The zero false-confirmed count reflects abstention, not demonstrated row accuracy. Keep production integration out of scope. The holdout CLI is prepared for fresh screenshots; its result must not be described as production readiness.

### Determinism

The complete 16-image OCR and field-extraction pipeline was run ten times. Canonical result SHA-256 was identical in all ten runs:

`4ec642a12580d3106c0ab1721bb5bd2721887562d4460e27e58f314c88354f52`

### Holdout command

The isolated venv and model are currently available at `C:\Users\kwang\AppData\Local\Temp\bdo_spec100_phase2_ocr_1abd7416bb244de38aae05db77a1c6ed`. Without changing code, run:

```powershell
& "C:\Users\kwang\AppData\Local\Temp\bdo_spec100_phase2_ocr_1abd7416bb244de38aae05db77a1c6ed\Scripts\python.exe" `
  tools/barter_scan/barter_scan.py `
  --images "<new screenshot folder>" `
  --model-dir "C:\Users\kwang\AppData\Local\Temp\bdo_spec100_phase2_ocr_1abd7416bb244de38aae05db77a1c6ed" `
  --output result.json --report report.json
```

The temp environment can be removed by normal OS cleanup; if so, recreate that isolated venv and restore the verified model files before running the holdout. The repository intentionally does not vendor the OCR model or its roughly 196 MiB dependency footprint.

## Phase 3 Hybrid Evaluation

### Phase 2 mismatch audit

The 209 stored mismatches were classified from their saved field status, raw OCR output, vocabulary coverage, and crop detections. Empty crops, OCR text outside the expected field, exact text outside the closed catalog, spacing-only differences, and character-read errors were separated. This is an audit of the Phase 2 artifact; the labels below are diagnostic categories, not a new OCR run.

| Field | Mismatch categories | Total |
|---|---|---:|
| `fromItem` | OCR character/read error 14; wrong-region/cross-field contamination 19; exact OCR outside closed catalog 10; empty crop/OCR 1; spacing-only, ellipsis, tier-prefix 0 | 44 |
| `reqAmount` | no OCR digits/empty crop 26; wrong-region/non-digit text 27; mixed digits and marks 11; wrong or held numeric OCR 8 | 72 |
| `toItem` | OCR character/read error 11; wrong-region/cross-field contamination 1; exact OCR outside closed catalog 1; empty crop, ellipsis, Crow Coin mismatch, tier-prefix 0 | 13 |
| `yield` | no OCR digits/empty crop 28; wrong-region/non-digit text 27; wrong or held numeric OCR 12; mixed digits and marks 3 | 70 |
| `island` | OCR character/read error 9; empty crop/OCR 1; ellipsis 0 | 10 |
| **Total** |  | **209** |

`count` had no Phase 2 mismatch. The dominant actionable-looking issue is small icon-overlay quantities; this Phase 3 evaluation did not find a safe template path that materially improves those fields.

### Hybrid strategy and evidence boundaries

The recognizer combines stored Phase 2 OCR field evidence with new deterministic pixel comparisons on all 80 row-relative icon/quantity crops. The expected JSON is loaded only after recognition for scoring. Row geometry remains the existing autocorrelation detector, with all 16 images and 80/80 row slots retained. The image crop coordinates are lane-relative and row-relative; no particular screenshot row is encoded.

Tier 1–5 icons are loaded from the existing 70 `reference/icons/*.webp` assets and `reference/barter_items.json`. The matcher compares RGB mean absolute error over the icon center, excluding the frame and lower overlay strip, and records top-1, top-2, both scores, and their gap. Frozen confirmation gates are score ≤18.0 and gap ≥6.0. Against the oracle, unthresholded top-1 names were exact on 29/80 input crops and 22/80 output crops; the conservative gate admitted 1 input crop and 0 output crops. OCR/icon disagreement is held. No Crow Coin icon is present among the 70 references. Eleven rows have high-confidence OCR text `까마귀주화`, but a template built and scored from those same OCR-labeled rows would self-validate; no visual signature is counted as independently validated. Crow Coin therefore remains dependent on safe OCR text evidence until tested on holdout screenshots.

The existing warehouse `QuantityReader` and `quantity_templates.npz` were applied read-only to 40×44 row-relative quantity crops. The direct reader emitted candidates for 20/80 `reqAmount` crops (18 exact, 2 wrong) and 12/80 `yield` crops (12 exact, 0 wrong). The crop is larger vertically and its glyph placement/overlay context differs from the warehouse slots. Template-only values are therefore not accepted. A Phase 3 quantity is confirmed only when the reader candidate equals an exact OCR number at OCR confidence ≥0.88; otherwise a previously exact Phase 2 OCR value remains explicitly `OCR_FALLBACK` and an uncertain value remains unknown. The agreement path confirmed no additional numeric fields in this batch. No separate barter digit-template set was created: this set does not provide enough independent labeled glyph coverage to create and validate one without deriving labels from the expected rows.

Island and count continue to use the existing Phase 2 OCR/canonicalization statuses. A high-confidence `UNVERIFIED_TEXT` `fromItem` can be retained as a land good outside the 70-item icon master. Any unresolved required field keeps the full row on HOLD. No numeric default is introduced. The 70-icon set does not cover all land inputs or special output icons.

### Phase 3 evaluation

The saved Phase 2 OCR values are preserved as the text evidence; the icon and quantity pixels were processed from the original 16 screenshots. Scoring uses the unchanged expected JSON after composition.

| Field | Phase 2 exact | Phase 3 exact | Change |
|---|---:|---:|---:|
| `island` | 70/80 | 70/80 | 0 |
| `fromItem` | 36/80 | 36/80 | 0 |
| `reqAmount` | 8/80 | 8/80 | 0 |
| `toItem` | 67/80 | 67/80 | 0 |
| `count` | 80/80 | 80/80 | 0 |
| `yield` | 10/80 | 10/80 | 0 |

| Row metric | Phase 3 result |
|---|---:|
| Ground-truth / detected rows | 80 / 80 |
| Confirmed rows | 0 |
| Exact correct confirmed | 0 |
| Wrong confirmed | 0 |
| Held rows | 80 |
| Exact rows regardless of HOLD | 0/80 |
| Expected JSON through SPEC-004 importer | 78 accepted, 2 rejected as previously documented |
| Phase 3 confirmed rows available to import | 0 |
| Import equivalence | Not achieved: no recognized rows; expected-import baseline remains 78 accepted / 2 rejected. The Phase 3 output was not separately passed through the importer. |

Zero wrong-confirmed is vacuous because no row is confirmed. The two expected importer rejections remain in recognition scoring and were not filtered. The full per-row evidence, top-2 icon candidates, quantity candidates, statuses, evaluation, and deterministic hashes are in `phase3-evaluation.json`.

### Tests, determinism, and dependencies

`python -m unittest tools.barter_scan.test_barter_scan tools.barter_scan.test_phase3 -v` passed 12 tests. Added checks cover exact-template matching, ambiguous icon HOLD, agreement-required digits, and no default on unreadable quantity. The existing tests retain row detection and ellipsis behavior.

The Phase 3 pixel matcher and evidence composition were run ten times over the 80 saved Phase 2 OCR rows and 16 screenshots; canonical output SHA-256 was identical 10/10. The Phase 2 full OCR pipeline separately reports identical canonical results in 10/10 runs (`4ec642a12580d3106c0ab1721bb5bd2721887562d4460e27e58f314c88354f52`). The Phase 3 hash list is in `phase3-evaluation.json`.

No production dependency was added. `local_app/pyproject.toml` already declares `numpy>=1.24,<3` and `Pillow>=10`; RapidOCR/ONNX remains in the isolated experiment environment and its prior estimated packaged impact remains roughly 196 MiB. The expected JSON, icon references, warehouse reader, templates, HTML, production frontend, and application configuration were not changed.

### Frozen holdout parameters and code hashes

- Icon input/output crop boxes: `(278,19,322,63)` and `(653,19,697,63)`, with the vertical origin from each detected 75 px row period.
- Icon comparison: RGB mean absolute error over `[y=3:38, x=3:41]` after 44×44 normalization; maximum score `18.0`; minimum top-1/top-2 gap `6.0`.
- Quantity crops: `(282,15,322,59)` for `reqAmount`; `(657,15,697,59)` for `yield`; template source is unchanged `quantity_templates.npz`, SHA-256 `2c247ba93a49c65fff739e5bc92d836bd752bf7e7afe3fe45941bf7b6b977a302`.
- Quantity confirmation: exact agreement with Phase 2 OCR and OCR confidence ≥`0.88`; warehouse presence/digit-gap thresholds remain unchanged at `0.03`.
- OCR normalization, closed-vocabulary matching, and `0.88` text confidence remain as recorded in Phase 2. No OCR model or dictionary was changed.
- Prototype SHA-256 for all four Python files is recorded as `prototypeSha256` in `phase3-evaluation.json`. Recompute hashes before using any holdout.

Run a new same-scale holdout folder without editing parameters:

```powershell
& "C:\Users\kwang\AppData\Local\Temp\bdo_spec100_phase2_ocr_1abd7416bb244de38aae05db77a1c6ed\Scripts\python.exe" `
  -m tools.barter_scan.phase3_evaluate `
  --images "<new screenshot folder>" `
  --model-dir "C:\Users\kwang\AppData\Local\Temp\bdo_spec100_phase2_ocr_1abd7416bb244de38aae05db77a1c6ed" `
  --output "<holdout report.json>" --determinism-runs 10
```

### Protection and verdict

The starting Git changes and unrelated untracked files were preserved. Protected content hashes match the recorded pre-Phase-3 values: root HTML `7133ae0140d84dc284a53b7caeedaf5479270161038ca36df4e094983aaf7b76`; warehouse scanner `aa72ed5763c76a030ab4c8ffbc00fb23bf8ed4c391f9d1de8659395d76579fe8`; `reference/barter_items.json` `e6e9786b1a8f671650dca9feb33b6137029620f5e17ccb2dcdf0957722028d9c`; reference manifest `4131f16abdff13889e98702e7a9c00325671349fddaf7ac282e70b7e88aa2ae4`. `local_app/pyproject.toml`, production frontend/importer, SPEC-005 scheduler/completion, and SPEC-006 package/launcher were not changed.

**Phase 3 verdict: GPT_FALLBACK_RECOMMENDED.** The deterministic icon matcher and warehouse digit templates did not improve any Phase 2 field score; the digit-template candidate set also contained two wrong input values. All rows remain held, and the zero wrong-confirmed count is not proof of row accuracy. The local hybrid route does not meet the 40/80 feasibility floor and has not earned production integration. This does not authorize or start `local_app` integration.
