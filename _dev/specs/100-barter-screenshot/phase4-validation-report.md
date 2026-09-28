# SPEC-100 Phase 4 Validation Report

Verdict: **PHASE4_FAILED**

Recognition correctness and existing importer accept/reject are reported separately.
Current 16-image data was previously inspected; internal validation is not blind.
Expected 80-row importer baseline: accepted 78, rejected 2.

## training

Rows 48; confirmed 0; exact 0; wrong confirmed 0; coverage 0.000; held 48 (1.000).

| Field | Precision | Coverage | Confirmed | Correct | Wrong confirmed |
|---|---:|---:|---:|---:|---:|
| island | 1.000 | 0.854 | 41 | 41 | 0 |
| fromItem | 0.917 | 0.500 | 24 | 22 | 2 |
| reqAmount | 1.000 | 0.083 | 4 | 4 | 0 |
| toItem | 0.976 | 0.875 | 42 | 41 | 1 |
| count | 1.000 | 1.000 | 48 | 48 | 0 |
| yield | 1.000 | 0.125 | 6 | 6 | 0 |

Importer among recognition-confirmed: accepted 0, rejected 0, exact recognition but rejected 0.

| Tier side | Confirmed labels | Correct | Precision |
|---|---:|---:|---:|
| from | 18 | 18 | 1.000 |
| to | 38 | 38 | 1.000 |

| Icon side | Reference covered | Top1 correct | Accepted | Accepted precision | Wrong accepted |
|---|---:|---:|---:|---:|---:|
| fromIcon | 41 | 35 | 16 | 1.000 | 0 |
| toIcon | 41 | 30 | 21 | 1.000 | 0 |

## internal_validation

Rows 32; confirmed 0; exact 0; wrong confirmed 0; coverage 0.000; held 32 (1.000).

| Field | Precision | Coverage | Confirmed | Correct | Wrong confirmed |
|---|---:|---:|---:|---:|---:|
| island | 1.000 | 0.875 | 28 | 28 | 0 |
| fromItem | 1.000 | 0.719 | 23 | 23 | 0 |
| reqAmount | 1.000 | 0.125 | 4 | 4 | 0 |
| toItem | 0.967 | 0.938 | 30 | 29 | 1 |
| count | 1.000 | 1.000 | 32 | 32 | 0 |
| yield | 0.800 | 0.156 | 5 | 4 | 1 |

Importer among recognition-confirmed: accepted 0, rejected 0, exact recognition but rejected 0.

| Tier side | Confirmed labels | Correct | Precision |
|---|---:|---:|---:|
| from | 22 | 22 | 1.000 |
| to | 19 | 19 | 1.000 |

| Icon side | Reference covered | Top1 correct | Accepted | Accepted precision | Wrong accepted |
|---|---:|---:|---:|---:|---:|
| fromIcon | 28 | 27 | 17 | 1.000 | 0 |
| toIcon | 20 | 19 | 12 | 1.000 | 0 |

## Training calibration

Digit prototypes: [0, 1, 2, 3, 5, 6, 7, 8, 9]; OOF rows 96; accepted 0; wrong 0; thresholds {'maxDistance': 0.0, 'minGap': 1.0}.
Icon training rows 48; tier examples {'1': 12, '2': 13, '3': 12, '4': 17, '5': 12}; coin OOF examples 43; accepted 0; wrong 0.

Validation determinism: 2 runs; identical=True; hashes=['80ced3682e75f9c85d2b3dd3c1add19c57300581aa3ef7dab415a9092af466cf', '80ced3682e75f9c85d2b3dd3c1add19c57300581aa3ef7dab415a9092af466cf'].

## Freeze

Code bundle SHA-256: `357e547b3848feccdc1758e460aab2307b47dd33db09472b13efc2a099c59c61`
Split manifest SHA-256: `1d3d2ed3ebd4860aacc9cb81db20a2b6d2c6da47b42b500c3d3e399dfa2e5434`
Digit template SHA-256: `fa97bf88c21844e5f1df5c36f672ac806834e012d4f0ac4f718c04b99d5eaf67`
Icon parameter SHA-256: `c03919364f4e023eacee3fd24259821a9ceafd4ff49bff8d990d64b1cf8f53a4`

## External holdout

**PENDING**. Run once with the frozen code/templates/config shown in `phase4-evaluation.json`.
