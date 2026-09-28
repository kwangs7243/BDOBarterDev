# Capture Design

## CaptureInput v1

multipart의 단일 `image` PNG와 `metadata` JSON string을 받는다. 파일 입력은 원본 PNG를 유지하고 clipboard/stream은 lossless PNG로 encoding한다. PNG는 encoding 손실을 방지할 뿐 capture source가 원본 화면 픽셀을 rescale하지 않았음을 보장하지 않는다. 앱 자체 JPEG 변환이나 자동 축소는 하지 않는다. 수신 측에서 실제 format과 pixels를 다시 검증한다.

```json
{
  "version": 1,
  "captureId": "uuid",
  "batchId": "uuid or null",
  "taskType": "warehouse or trade",
  "sourceType": "file or clipboard or browser-stream",
  "capturedAt": "UTC ISO-8601",
  "frame": {"width": 1920, "height": 1080},
  "fidelity": {"sourceWidth": null, "sourceHeight": null, "rescaled": null, "evidence": "unknown"},
  "profileId": "uuid or null",
  "profileVersion": 1,
  "context": {"baseRevision": 12, "sessionId": null, "sessionRevision": null},
  "observed": {"browserDpr": 1.25, "windowsDpi": null, "gameResolution": null, "gameUiScale": null}
}
```

수치는 schema 예시일 뿐 측정된 게임 설정이 아니다. Windows DPI/game resolution/UI scale은 브라우저에서 알 수 없으면 null이다. browserDpr를 Windows/game DPI라고 부르지 않는다. frame은 실제 bitmap/video dimensions와 같아야 한다. fidelity는 sourceWidth/sourceHeight(null 또는 양의 정수), rescaled(null/boolean), evidence("track-settings"|"file-metadata"|"user-observed"|"unknown")의 exact shape다. source dimensions를 browser가 입증하지 못하면 null로 보존한다. frame/track settings/사용자 관측과 rescale 여부를 report에 함께 남기고 unknown을 native fidelity로 단정하지 않는다. observed 값은 confidence authority가 아니다. IDs ≤128 chars; metadata ≤64KiB; timestamps 수신 시각도 별도 보관. task/source enum 외 값, NaN/Infinity/bool-as-int, frame mismatch, 20MiB/32MP 초과는 거부한다.

## Interfaces and lifecycle

`captureFromFile(file,context)`, `captureFromPaste(event,context)`, `connectScreen()`, `captureFrame(context)`, `disconnectScreen(reason)` → Promise<CaptureInput> (connect/disconnect는 stream 상태). stream은 브라우저 안에만 있고 backend에는 캡처한 frame 한 장만 전송한다.

상태: IDLE → CONNECTING → CONNECTED → CAPTURING → CONNECTED; ended/error → DISCONNECTED. 인식 상태는 별도로 QUEUED → VALIDATING → CAPTURE_INVALID 또는 RECOGNIZING → SHADOW/REVIEW/REJECT/READY → APPLYING → APPLIED/CONFLICT/FAILED. 화면 연결만으로 main DB를 쓰지 않는다.

`getDisplayMedia({video:{displaySurface:"window"},audio:false})`는 사용자의 연결 버튼 handler에서 직접 실행한다. `displaySurface`는 hint다. 권한 denied는 normal UI 오류로 남기고 재시도는 사용자가 버튼으로 한다. stream 끝남/숨겨진 app 종료/pagehide에 tracks.stop과 object URL cleanup. modal을 닫는 것만으로 stream을 종료하지 않는다. 화면 연결 상태와 끊기 버튼은 main UI에 계속 표시한다. 음성은 요청하지 않는다. 선택 source의 label/title은 일반 로그·profile에 저장하지 않는다.

frame은 videoWidth/videoHeight로 canvas를 구성한다. stream 자동 녹화/주기 캡처/게임 자동 scroll은 없다. requestVideoFrameCallback이 있으면 직전 frame metadata로 freshness를 확인하고, 없으면 loadeddata/playing·dimension 변화·연속frame pixel hash를 표시한다. freshness를 입증하지 못한 frame은 자동 적용을 허용하지 않는다. 최소화/black/정지 frame, resizing 중 frame, cursor/hover가 target을 가린 frame은 quality reason을 남겨 다시 캡처하도록 한다. black 판정은 profile 내 panel 검출과 함께 하고 전체 화면 평균밝기만으로 검은 게임 UI를 오인하지 않는다.

## Paste routing

창고/물교 task는 버튼 또는 명시적 활성 입력 영역에서 선택한다. focus가 textarea/input/contenteditable/다른 dialog면 기본 text paste를 보존한다. image MIME가 있고 recognition capture surface가 활성화됐을 때만 preventDefault한다. `clipboardData.items`/getAsFile를 사용하고 navigator.clipboard.read 권한을 별도로 요구하지 않는다. MIME만 신뢰하지 않고 bitmap decode 후 검증한다. PNG는 그대로 유지, 다른 clipboard image는 orientation-aware decode 후 lossless PNG로 encoding하며 reencoded=true 기록. animated image는 거부한다.

한 paste의 여러 image는 각각 ID를 부여하여 serial queue에 넣는다. trade는 batch append, warehouse는 한 image씩 별도 snapshot이다. 최대 batch 100 frames, 일괄 total bytes를 메모리에 유지하지 않고 processing 후 원본 Blob/objectURL을 해제한다. 결과/crop만 exception 동안 보존한다. 초과이면 기존 batch를 유지하고 입력을 거부한다. clipboard 내용이 없는 경우 파일 선택 fallback을 안내한다.

## CaptureProfile v1

sidecar에 `{version,id,profileVersion,taskType,sourceType,referenceFrame:{width,height},region:{x,y,w,h},anchorSetId,anchorSetHash,anchorOffsets,canonicalGeometry,observed:{windowsDpi,gameResolution,gameUiScale},verifiedStratumIds}`를 저장한다. region 4값은 [0,1], w/h>0, x+w/y+h≤1이며 **frame pixel** 기준이다. 임의 화면 주소/window handle/권한 token은 저장하지 않는다. profileVersion은 수정마다 증가한다.

profile 생성은 사용자가 영역을 한 번 표시하고 fixture에서 검증된 anchor set이 대응할 때만 ready다. anchor는 panel 경계/grid/row separator 및 독립적인 구조 evidence를 사용한다. warehouse icon 내용은 layout anchor로 쓰지 않는다. title/장식 anchor asset을 사용할 경우 별도 curated PNG/NPZ와 source hash가 필요하다. 현재 anchor asset이 없으므로 생성/검증 전 auto OFF.

처리: normalized region seed → anchor 검색 → 독립 geometry 검증 → scale/translation 결정 → image-space crop → canonical crop. transform은 axis-aligned scale+translation만 허용하고 perspective/비등방 stretch는 reject한다. anchor가 여러 개거나 anchor/row/grid 일관성이 깨지면 PROFILE_MISMATCH다. normalized region만 재사용해서 HIGH를 만드는 fallback은 없다.

warehouse canonical은 현 V1 outer slot45/period51/inner43 좌표와 같은 정규화 기준을 갖되 raw crop도 유지한다. 재표본화 kernel/threshold와 허용 scale 범위는 grouped calibration 후 policy에 고정한다. 새로운 profile/해상도/UI scale은 새 stratum이다. 독립 구조 검사가 성공한 정상 화면은 승인 전 REVIEW이며 구조/scale 검증 자체 실패는 CAPTURE_INVALID다. frontend CSS zoom은 video preview 좌표 변환에만 작용하며 bitmap scale을 바꾸지 않는다. object-fit letterbox 영역을 제외한 displayed-content rect를 기준으로 region을 계산한다.

## API

`POST /api/recognition/warehouse`와 `/trade`: CaptureInput multipart → `{ok:true,recognitionId,report}`. 엔진이 profile를 찾아서 version/hash를 재확인한다. frontend 점수/anchor box를 server authority로 받지 않는다.

`GET /api/recognition/config`: flags/profiles/approvedPolicySummary. `PUT /api/recognition/config`: `{version:1,expectedConfigRevision,flags,profiles}`; sidecar configRevision CAS, 충돌409. flags만 켜도 검증되지 않은 정책은 high auto authority를 얻지 못한다. profile update는 해당 policy 승인 scope에서 벗어나므로 auto가 비활성화된다.

오류는 `{ok:false,error:{code,message,retryable}}`; input415/413/422, profile/layout422, busy503, config409. raw screen/파일 경로를 message/log에 붙이지 않는다. backend recognition 작업은 app.py의 shutdown active drain에 포함시켜 성공 응답 전 종료되지 않게 한다.

## Capture validity contract

normalize_capture는 먼저 validity={status:"VALID"|"CAPTURE_INVALID",reasonCodes,evidence}를 반환한다. 정상 target UI/완전한 panel-grid/선택 영역/anchor 일관성/축별 scale/숫자 영역 경계를 server가 검사한다. WRONG_TASK_UI, PANEL_CLIPPED, GRID_NOT_FOUND, WRONG_REGION, SEVERE_PROFILE_MISMATCH, DIGIT_REGION_CLIPPED, STRUCTURE_MISMATCH, NONUNIFORM_TRANSFORM이면 capture-level CAPTURE_INVALID(HTTP422, warehouse slots=[],patchProposal=null, automationEligible=false; trade rows=[])이며 한 번만 정상 창고 재캡처를 안내한다. Tier5 존재는 invalid reason이 아니다.

decoded CaptureInput은 유효하지만 target/layout이 invalid인 경우에도 sidecar run/validity crop evidence를 기록하고 `{ok:false,recognitionId,error:{code:"CAPTURE_INVALID",reasonCodes,message,retryable:true},report}`를 반환한다. report.validity.status=CAPTURE_INVALID, report.automationDecision=REJECT이며 task-specific slots/rows는 빈 배열이다. frontend는 이 응답을 일반 slot review로 펼치지 않는다. malformed envelope/size/MIME/decode 실패는 run 생성 전 기존 error shape로413/415/422 반환, recognitionId/report를 가짜로 생성하지 않는다. budget/store 실패로 run을 보존하지 못하면503/evidence_store_unavailable이며 성공 recognitionId를 반환하지 않는다.

구조가 유효한데 item/quantity reader 값이 불명확하거나 새 stratum의 정확도만 미검증이면 해당 슬롯 REVIEW다. warehouse 숫자 영역 clipping은 잘못된 재고 값을 만들 위험이므로 capture invalid로 승격한다. trade 목록 경계의 일부 잘린 row는 정상 스크롤 입력의 PARTIAL_ROW HOLD로 보존하며 정상 전체 panel까지 invalid로 만들지 않는다. 다른 UI/전체 panel clipping은 trade도 invalid다.

frame rescale가 검증된 profile/policy 범위 밖이면 HIGH 금지(FRAME_RESCALE_UNVERIFIED); transform 산출 자체가 불가능할 만큼 심각하면 CAPTURE_INVALID다. 검사 cutoff는 curated validity fixture와 calibration artifact로 고정하며 임의 숫자를 추가하지 않는다. 원본 frame/selected crop/letterbox/anchor/raw·canonical boxes/scale/kernel/profile payload와 hash를 Early Evidence Store에 기록한다.

## Security contract — T002에서 기존 guard 보강

새 인증 서버를 만들지 않고 app.py restrict_to_local_origin과 shutdown drain을 재사용한다. 생산 loopback 127.0.0.1:18765/expected Host allowlist를 유지한다. 아래 V2 state-changing 경로 및 기존 /api/working-session*의 PUT/POST/DELETE는 Origin이 **요청 Host의 http origin과 exact match**해야 한다. missing/null/foreign Origin은403; Sec-Fetch-Site가 있으면 same-origin만 허용(없어도 exact Origin 필수). 시험 모드의 완화된 host 규칙을 생산 설정에 복사하지 않는다. localhost와127.0.0.1을 서로 다른 Origin으로 취급한다.

적용 범위: POST recognition warehouse/trade/feedback/apply, PUT recognition/config, PUT/DELETE working-session, POST working-session/completion. CORS allow headers를 기본적으로 내보내지 않고 foreign OPTIONS도 저장 권한을 주지 않는다. GET은 main mutation 금지. JSON endpoint는 application/json(+charset)만, capture는 multipart/form-data의 단일 image+metadata만 허용; text/plain/form-urlencoded/위조 PNG/animated/NaN/추가 parts/중복image 거부. 서버 request20MiB+64KiB/image20MiB/32MP/metadata64KiB 한도를 재검사한다. body·bitmap limit 실패는 sidecar/main write 전에413/415/422로 종료한다. raw path/window title/image/secret은 로그에 남기지 않는다.

기존 working-session 계약 body와 response는 유지하되 client Origin 조건을 보강한다. security negatives는 testing=False의 production guard와 명시 Host/Origin으로 검사하며 테스트 allowlist 완화로 통과시키지 않는다. backend 시험 client는 유효 Origin을 명시하고 누락/foreign/Host spoof/cross-site metadata/Content-Type negatives를 별도 assertion으로 검증한다. launcher shutdown은 이 보강의 대상이 아니며 기존 종료 방식을 유지한다. T002 완료에는 실제 브라우저 정상 save와 외부 페이지 mutation 차단 검증이 필요하고 unit PASS와 live PASS를 분리한다. 근거: [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
