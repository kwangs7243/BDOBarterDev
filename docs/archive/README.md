# 과거 설계·실험 기록

이 폴더는 이전 작업의 설계와 고정 baseline 계약을 보존합니다. 현재 구현 위치·배포 승인·작업 권한의 기준이 아닙니다. 현재 안내는 [제품 계약](../CURRENT-PRODUCT-CONTRACT.md), [인식 구조](../RECOGNITION.md), [검증 방법](../TESTING.md)입니다.

`specs/trade-template-v1/`은 2026-10-16 당시 오프라인 실험 설계입니다. 이후 검증된 전체 필드 정답 조회는 제품에 적용됐고 현재 bank는 881개입니다. 당시 문서의 ‘미승인/미구현’ 표현을 현재 제품 상태로 읽지 않습니다.

연결된 실험 도구는 저장소 루트의 `tools/experiments/trade_template_v1/`, 단위 검사는 `local_app/tests/experiments/trade_template_v1/`에 있습니다. 현재 실행 가능한 도구는 `python -m tools.experiments.trade_template_v1.cli --help`로 확인합니다. 기본 spec 경로는 이 archive의 하위 폴더입니다.

manifest와 도구의 `baseline-source/_dev/...`는 외부에 동결해 둔 과거 사본 안의 경로입니다. 원본 해시·출처·스냅샷 내용을 보존하기 위해 해당 경로는 유지합니다. 원시 DB·전체 캡처·개인 실험 출력은 저장소에 포함하지 않습니다.
