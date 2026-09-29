# SPEC-008 Trade V1 Preservation Contract

## Purpose and evidence

This document freezes the existing Trade behavior that local recognition must feed. The legacy reference is `_dev/BDO_물교_v1.0.html`; the current domain authority is `_dev/local_app/frontend/js/domain/trade-import.js`. The V1 behavior is characterized in `_dev/local_app/tests/trade_import_regression.mjs` and the focused contract suite `_dev/local_app/tests/trade_domain_contract.mjs`.

T010P1 records behavior; it does not change the Trade normalizer, matching thresholds, parser rules, capture implementation, OCR, scheduler, or persistence schema. The only UI wording correction in this task changes the T010B2 pilot caption for `count` to “남은 교환 횟수”.

## Frozen pipeline

```text
CaptureBatch
  → LocalRecognition
  → TradeRecognitionDraft[] (raw six-field candidates with provenance)
  → TradeDomainNormalization (existing JavaScript authority)
  → accepted / ambiguous / unmatched / held / duplicate / conflict
  → review
  → session.scannedTrades
  → scheduler
```

`TradeRecognitionDraft` is not a canonical Trade row. Recognition may report raw text, numeric candidates, confidence, crop/capture identity, and reasons. It must not apply final catalog correction or claim that its values are canonical. The existing domain normalizer remains responsible for canonical rows and importer outcomes.

## Six-field recognition contract

The original prompt in the V1 reference required one JSON array for the supplied screenshots, with this row shape:

| Key | Meaning |
| --- | --- |
| `island` | Trade location / island name |
| `fromItem` | Item on the left side of the exchange arrow |
| `reqAmount` | Quantity of `fromItem` required for one exchange |
| `toItem` | Item on the right side of the exchange arrow |
| `count` | Remaining exchange count shown as “남은 교환 횟수: X회” |
| `yield` | Quantity of `toItem` received per exchange |

`count` remains the DTO compatibility key; its semantic name is `remainingExchangeCount`. It never means inventory stock or warehouse quantity. UI wording should say “남은 교환 횟수” or “교환 횟수”.

The prompt's observable behaviors are: interpret multiple screenshots together; read island, left input item and its required amount, right output item, remaining exchange count, and output yield; suppress duplicate rows caused by overlapping screenshots; return one JSON array. It did not define a separate Trade session per capture.

## V2 replacement boundary

The V1 component being replaced is Gemini remote multimodal recognition. Its V2 replacement is local batch recognition. Capture UX, the six-field meaning, domain normalization, review behavior, session creation, and scheduler input are preserved wherever practical. Gemini API-key entry/storage, sending screenshots to the Google Generative Language API, external image upload, and remote OCR fallback are removed for security. No provider request is permitted without a separate explicit opt-in design.

Current V2 has generic file/clipboard capture drafts, a local screen-stream session, a Trade image queue with previews and per-image removal, JSON paste/import, excluded-row review, and the existing Trade domain normalizer. It does not yet restore the V1 movable/resizable Trade ROI or connect that queue to a production local multi-capture recognizer. T010A/T010B artifacts are local experiments; T010B2 is a separate calibration-review tool, not a production capture pipeline. Closing the T010B2 screen does not establish a production recognition workflow. T010B2's saved user labels and generated results are local evidence and remain untouched; its present status is `SUPERSEDED_PENDING_REDESIGN`.

## Preservation matrix

| Capability / invariant | V1 behavior | Current V2 behavior | Decision | Future task |
| --- | --- | --- | --- | --- |
| Screen sharing | `getDisplayMedia` supplies a game/window video stream | T004 screen session captures one explicit frame at a time | PRESERVE | Trade capture UX restoration |
| Movable/resizable ROI | ROI can move and resize north, south, east, west, and four corners; CSS coordinates map to video pixels | No Trade ROI; frame capture queues the full frame | PRESERVE | Trade capture UX restoration, after this contract freeze |
| Multi-capture batch | Scroll and append captures; submit the set together | Trade queue accepts multiple file, paste, or stream captures, but no production local recognition batch is connected | REPLACE_LOCAL | Local batch recognition integration |
| Capture preview | Thumbnail preview for accumulated captures | Per-image draft preview is shown in the Trade queue | PRESERVE | Trade capture UX restoration |
| Individual capture delete | Remove one capture before recognition | Per-image queue removal exists | PRESERVE | None unless later usability review finds a gap |
| Batch clear | Closing/successfully completing the V1 capture flow clears accumulated snippets | No explicit clear-all action; dialog close preserves drafts, page teardown clears them | IMPROVE | Trade capture UX restoration |
| Retry without recapture | Failed recognition preserves snippets for immediate/model-switch retry | No production local recognizer to retry; queued drafts remain while the app is open | PRESERVE | Local batch recognition integration and failure-state design |
| Gemini remote inference | Multiple compressed screenshots are sent to Gemini in one request | Not used by the V2 capture/recognition UI | REMOVE_FOR_SECURITY | None; local-only recognition is the default |
| Six-field recognition contract | One object per row with the six keys and meanings above | T010A/T010B candidates use six fields; `count` is shown as remaining exchanges in the T010B2 review tool | PRESERVE | All local reader integration |
| Multi-image merge | Gemini prompt asks for one merged JSON array from all supplied images | Offline candidate experiments inspect a frozen capture set; production queue merge is absent | REPLACE_LOCAL | Local batch recognition integration |
| Overlap / duplicate handling | Prompt asks the model to suppress overlaps; domain importer also skips duplicate canonical rows | Domain importer skips duplicate island/toItem/fromItem tuples; capture-to-row continuity and source provenance are not integrated | IMPROVE | Batch row identity/provenance design |
| `toItem` master correction | Strip bracket decorations and `x N`, exact whitespace-normalized match first, then bounded Levenshtein/similarity; correct only a unique qualified candidate | Existing JS domain normalizer applies this rule against tiers 1–7 plus special items | PRESERVE | Reuse the existing normalizer |
| Tier-constrained `fromItem` correction | Canonicalize `toItem` first; use the preceding tier for tier 2–7 outputs; material/coin paths use current special handling | Existing JS domain normalizer applies these tier-specific sets | PRESERVE | Reuse the existing normalizer |
| 0→1 land material | Preserve a non-empty raw land-material name instead of forcing a master-item match | Existing JS domain normalizer preserves it after removing display decoration | PRESERVE | Reuse the existing normalizer |
| Island correction | General Trade uses `islands`; tier 6 and 7 use their dedicated lists and current best-match behavior | Existing JS domain normalizer uses those same catalog fields | PRESERVE | Reuse the existing normalizer |
| `reqAmount` | `parseInt(String(value).replace(/[^0-9]/g, "")) || 1` | Same legacy parser in the domain normalizer | PRESERVE | Any product rule change requires a separate domain decision |
| `count` | `parseInt(String(value).replace(/[^0-9]/g, "")) || 0`; denotes remaining exchange count | Same parser and DTO key; T010B2 caption is “남은 교환 횟수” | PRESERVE | Domain range policy is a separate decision |
| `yield` validation | Only positive integer yield is accepted; otherwise row is held | Existing JS domain normalizer enforces `Number.isInteger(yield) && yield > 0` | PRESERVE | No ratio derivation is approved |
| Duplicate handling | Skip a row matching a non-deleted row by canonical island, output, and input item | Existing JS domain normalizer skips duplicate canonical tuples | PRESERVE | Add source-capture provenance in the batch task if needed |
| Conflict handling | Same island/output with a different input item is rejected as conflict; existing row remains | Existing JS domain normalizer returns conflict and retains prior rows | PRESERVE | Keep conflict in review; never overwrite automatically |
| JSON paste/import | Global paste accepts a JSON row array | Explicit JSON import path parses, normalizes, and reviews excluded rows | PRESERVE | None |
| Excluded-row review | Invalid/unmatched results are warned/held; no current V1 repair dialog | V2 offers a review dialog; selections are revalidated before insertion | IMPROVE | Preserve revalidation and default-exclude behavior |
| Session creation | Accepted rows update the current `scannedTrades` list | V2 import creates/replaces or appends through the current session workflow | PRESERVE | Local recognition adapter integration |
| Scheduler input | Scheduler consumes `scannedTrades` | Existing scheduler consumes `state.session.scannedTrades` | PRESERVE | No recognizer-specific scheduler logic |
| Gemini API key storage | User key is stored as `geminiApiKey` in localStorage | No Gemini-key UI or storage in the V2 recognition UI | REMOVE_FOR_SECURITY | None |
| External image upload | Screenshots are embedded in a request to Google Generative Language API | V2 capture drafts and T010B2 review use local processing | REMOVE_FOR_SECURITY | None |

## Domain normalization authority and current rules

`local_app/frontend/js/domain/trade-import.js` is the sole current authority for final Trade normalization. Recognition code must not reproduce its fuzzy correction in Python or independently promote canonical values.

| Input | Frozen current behavior |
| --- | --- |
| `toItem` | Remove bracketed display decoration and `x N`; prefer whitespace-normalized exact match; otherwise accept only one candidate within `min(3, max(1, ceil(targetLength × 0.25)))` edits and similarity ≥ 0.75; multiple candidates are ambiguous; no candidate is unmatched. |
| `fromItem` | Resolve canonical `toItem` first. Tier 2→tier 1; tier 3→tier 2; tier 6→tier 5; tier 7→tier 6. Tier-1 output preserves a non-empty raw land material. Material and coin paths keep their current all-item candidate behavior. |
| Island | General path uses `islands`; tier 6/7 use `t6Islands`/`t7Islands` with the current forced best-match behavior. This records current behavior; it does not endorse a new recognition threshold. |
| `reqAmount` | Strip non-digits, parse integer, fall back to 1. This Task records legacy behavior only. Historical evidence observes variable tier-1 input amounts and typically 1 for general barter, but does not turn that observation into a new derivation rule. |
| `count` | Strip non-digits, parse integer, fall back to 0. Its meaning is `remainingExchangeCount`, not stock. No 0–10 range is imposed here. |
| `yield` | Positive integer required; otherwise held. There is no production-approved item ratio master and no yield derivation. |
| Duplicate/conflict | Duplicate is the same normalized island/output/input tuple for a non-deleted row. Same island/output and a different input is conflict; it is not overwritten. |

No test or implementation in this Task changes those behaviors. The characterization suite exercises the existing JavaScript functions against the current catalog and separate synthetic ambiguity cases.

## Security and T010B2 disposition

The V2 recognition boundary remains local-only. No Gemini API, key storage, remote fallback, screenshot upload, OCR/model/preprocessing change, inventory/scheduler-derived inference, or Python duplicate of domain correction is introduced.

T010B2 is marked `SUPERSEDED_PENDING_REDESIGN` for planning. Existing `recognition-local/human-validation/t010b2/labels.jsonl` and generated result files are user-local evidence: this Task neither reads their contents for tests nor edits, deletes, regenerates, or commits them. T010B3 crop redesign and further human validation remain outside this Task.
