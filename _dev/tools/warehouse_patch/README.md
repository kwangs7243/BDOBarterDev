# Warehouse patch prototype

실제 창고 스크린샷을 로컬에서만 처리해 `master_inventory_patch` JSON을 만드는 독립 프로토타입입니다. 기존 `BDO_물교_v1.0.html`, 브라우저 저장소, 스케줄러에는 접근하거나 쓰지 않습니다.

## 실행

프로젝트 루트에서 번들 Python으로 실행합니다.

```powershell
& "C:\Users\kwang\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" `
  tools\warehouse_patch\warehouse_patch.py warehouse_screenshot.png `
  --output warehouse_patch.json `
  --report warehouse_patch_report.json
```

- `warehouse_patch.json`: 확정된 1~4단 품목과 수량만 포함하는 PATCH
- `warehouse_patch_report.json`: 빈 칸과 제외된 칸까지 포함한 슬롯별 판정 근거
- 슬롯 그리드가 확정되지 않으면 종료 코드 2와 `SLOT_GRID_DETECTION_FAILED`를 반환합니다.
- `ICON_MATCH_UNKNOWN`, `QUANTITY_UNKNOWN`, `TIER5_IGNORE`, `EMPTY`, `DUPLICATE_ITEM_DETECTED`는 PATCH에 포함하지 않습니다.

## 수량 템플릿 재생성

기본 템플릿은 이 프로젝트의 별도 보정용 실제 화면과 주석에서 한 번 생성한 로컬 자료입니다. 런타임에 네트워크나 외부 OCR API를 사용하지 않습니다.

```powershell
& "C:\Users\kwang\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" `
  tools\warehouse_patch\build_quantity_templates.py `
  fixtures\warehouse_patch\calibration.png `
  fixtures\warehouse_patch\calibration_manifest.json `
  --output tools\warehouse_patch\quantity_templates.npz
```

현재 아이콘 점수 `0.35`, 후보차 `0.045`와 수량 판정값은 이번 화면군을 위한 프로토타입 값이며 최종값으로 확정하지 않습니다.
