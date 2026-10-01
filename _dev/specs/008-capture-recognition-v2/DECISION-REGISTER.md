# 현재 architectural decisions

제품 의미는 [CURRENT-PRODUCT-CONTRACT.md](CURRENT-PRODUCT-CONTRACT.md)가 정본이다.

| ID | 유지할 결정 |
|---|---|
| DR-001 | 모든 COMPLETE 행/6필드 REVIEW-FIRST. 안전 후보도 숨기지 않는다. |
| DR-002 | 후보 생성과 자동수락 분리. unknown/unmatched/stableId 없음은 행 삭제 근거가 아니다. |
| DR-003 | V2 correction interface가 후보·risk·provenance를 소유한다. V1 수동/JSON 호환은 별도 회귀로 보존한다. |
| DR-004 | Master stableId는 curated mapping만 발급한다. canonical/display/alias/관찰 truth를 구분하며 near-name 자동 병합 금지. |
| DR-005 | 숫자는 source 또는 명시 human edit에서 온다. null과 실제 0 구분, req1/yield 추측 금지. tier0→1 open-world 보존. |
| DR-006 | unchanged/edited/unknown은 명시 검수 완료 후 기록. immutable sidecar 관찰, idempotency, export/hash, C2 crop 및 버전 평가 유지. |
| DR-007 | source count와 logical count 분리. 인접 suffix/prefix overlap, 출처 union, 충돌 대안 보존. reviewed DTO 후 DB-first staged session. |
| DR-008 | 기술 PASS, descriptive metric, owner usability, release와 future automation 승인은 별개다. |
| DR-009 | fromItem 추가 geometry 변경은 실제 review burden 근거와 별도 지시 전 보류. |
| DR-010 | 현재 trade 경로 우선. 수동 JSON/file/paste fallback 유지, Warehouse 확장과 무관한 작업을 섞지 않는다. |
| DR-011 | live는 사용자의 실제 환경. CDP DPR은 Windows 배율 증거가 아니며 130%를 강제하지 않는다. |

reconciliation object가 있으면 sourceRows/mapping으로 capture COMPLETE 수를 검증하고, completion은 logical projection rows에 대응한다. null path는 기존 observation과 호환된다. DB schema, hash algorithm, 기존 stored observation을 재작성하지 않는다.
