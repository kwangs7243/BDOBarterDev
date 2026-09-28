# SPEC-100 Phase 5 Validation Report

Verdict: **PHASE5_FAILED**

Internal data was previously inspected and is not blind. Expected labels were read by the evaluator only.
The recognizer received screenshot rows, frozen pixel prototypes, and numeric OCR crops; labels were never passed to it.

## Numeric gates

- reqAmount: {'pass': False, 'metrics': {'rows': 32, 'candidates': 2, 'confirmed': 0, 'correct': 0, 'wrong': 0, 'coverage': 0.0}, 'non1Confirmed': 0, 'non1Rows': 4}
- normal yield: {'pass': False, 'metrics': {'rows': 26, 'candidates': 2, 'confirmed': 0, 'correct': 0, 'wrong': 0, 'coverage': 0.0}}
- coin yield: {'pass': False, 'metrics': {'rows': 6, 'candidates': 6, 'confirmed': 0, 'correct': 0, 'wrong': 0, 'coverage': 0.0}}
- complete rows: {'pass': False, 'confirmed': 0, 'correct': 0, 'wrong': 0}

## Training OOF

Per mode: {"coin-yield": {"candidates": 0, "confirmed": 0, "correct": 0, "coverage": 0.0, "rows": 5, "wrong": 0}, "normal-yield": {"candidates": 0, "confirmed": 0, "correct": 0, "coverage": 0.0, "rows": 36, "wrong": 0}, "reqAmount": {"candidates": 9, "confirmed": 3, "correct": 3, "coverage": 0.0625, "rows": 48, "wrong": 0}}

## Internal validation

Per mode: {"coin-yield": {"candidates": 6, "confirmed": 0, "correct": 0, "coverage": 0.0, "rows": 6, "wrong": 0}, "normal-yield": {"candidates": 2, "confirmed": 0, "correct": 0, "coverage": 0.0, "rows": 26, "wrong": 0}, "reqAmount": {"candidates": 2, "confirmed": 0, "correct": 0, "coverage": 0.0, "rows": 32, "wrong": 0}}

## Determinism

{"identical": true, "runs": 3, "runsDetail": [{"seconds": 14.53, "sha256": "8b89544c5247d9bc9d375e43617d4dca670c1816e6067027255d95e3953e4305"}, {"seconds": 15.111, "sha256": "8b89544c5247d9bc9d375e43617d4dca670c1816e6067027255d95e3953e4305"}, {"seconds": 15.106, "sha256": "8b89544c5247d9bc9d375e43617d4dca670c1816e6067027255d95e3953e4305"}]}

## Freeze

Hashes: {"applicationCatalogSha256": "8183b03e6aa0ee354142cf9720b401494bec365e528632f3c0c84ec11b46b4b3", "catalogSha256": "e6e9786b1a8f671650dca9feb33b6137029620f5e17ccb2dcdf0957722028d9c", "code": {"phase4_icons.py": "658672308dfd06ba08ee89e0e41f7ee3175803cea9faf8954338d02a32e862ad", "phase4_layout.py": "11f3356532c23399369d1d9080488f680208e8d5b0d43a6b21961567fa837507", "phase4_pipeline.py": "4d904560768237e4d87f385606390e517c77e3a00c335611cee538ff7e93cc5c", "phase4_text.py": "ac0cdf2fc3a6eede5782acfdf69cca91b56909630d10fa8849d03addb5aa1016", "phase5_evaluate.py": "c77f1f8ee80c42f46feb768dd58a94a72ce2c5d13afb64637fe59ac966f08611", "phase5_numeric.py": "9c3e049931dcab33af1d4587edb5c799dbaae92859e636be2259806f5ad1cefe", "phase5_numeric_geometry.py": "6c22f661f3ca6876e17f0194908594b7aa467c8a8c5264034fe8c1817ff3bc69"}, "codeBundleSha256": "7dc77e2cc4626a6b01b137e993045a8048542e8c96a26c9c42a7162014e159c4", "numericModelSha256": "ace94be7e2b815f92ae508771cf0b224a6036a45f070ab15d9f3263edfd81103", "parametersSha256": "7d3288d5223efebcb0496307dd281b2b9850043487aec705ac11becb7419a4bc", "rapidOcrBundleSha256": "98374e27ec3d65a71c169341e7a60cbf7e0116904ac9b68313944ee69f714644", "rapidOcrModel": {"korean_PP-OCRv4_rec_mobile.onnx": "ab151ba9065eccd98f884cf4d927db091be86137276392072edd4f9d43ad7426", "korean_dict.txt": "aa1fdc8ae8f7cd40a0ec4edb472eb0421e11427e6ccfee9915440742c18b0a20", "rapidocr_korean.yaml": "443ca2adf45239c6ca77caca029f417ed3fae6690760af3fde3561701b36e7f6"}, "splitManifestSha256": "1d3d2ed3ebd4860aacc9cb81db20a2b6d2c6da47b42b500c3d3e399dfa2e5434"}

## External holdout

**PENDING** (not run).

## Numeric geometry

- `reqAmount`: row-relative screenshot box `(x=286..329, y=40..68)` (43 × 28 px).
- `yield`: row-relative screenshot box `(x=666..710, y=40..68)` (44 × 28 px).
- The deterministic whole-token mask keeps neutral bright strokes (grayscale ≥155, channel spread ≤105), applies a 3 × 3 median filter, then measures a fixed 44 × 28 feature. Training contact sheets were used to confirm complete tokens before calibration.

## Training OOF cutoff result

| Mode | Rows with independent mode evidence | OCR and pixel candidates | Zero-error OOF confirmations | Cutoff |
|---|---:|---:|---:|---|
| reqAmount | 48 | 9 | 3 | Selected: OCR confidence ≥0.493176, pixel distance ≤0.026786, gap ≥0.012987, quality ≥0.1 |
| normal-yield | 36 | 0 | 0 | `NO_ZERO_ERROR_CUTOFF` |
| coin-yield | 5 | 0 | 0 | `NO_ZERO_ERROR_CUTOFF` |

## Phase 4 comparison and final decision

Phase 4 internal validation had 8 correct confirmed numeric values (reqAmount 4, yield 4) and one additional wrong yield confirmation. Phase 5 had 0 correct confirmed numeric values, 0 wrong confirmations, and 0 complete rows. Phase 5 therefore did not improve numeric coverage, and all four internal success gates failed. Verdict: **PHASE5_FAILED**.

The failure matches the stop rule: normal-yield and coin-yield have no nonempty zero-error grouped OOF cutoff. No further threshold or representation tuning was done against validation. External holdout remains **PENDING** and was not run; production integration was not started.

No package dependency was added. The recognition model and temporary Python environment remained outside the repository.
