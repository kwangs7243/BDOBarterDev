import { state } from "./state.js";
import { PreviewRegistry } from "./capture.js";
import { saveTradeCorrections } from "./trade-recognition-client.js";
import { applyLiveTradeRules, prepareLiveTradeRows } from "./domain/trade-import.js";
import { whenPersistenceIdle } from "./persistence.js";
import { applyLiveTradeRows } from "./trade-ui.js";

export function createTradeLiveListUI({ elements, queue: tradeQueue, getCatalog, getPending, setPending, onResult }) {
  const { liveListSection, tradeRecognitionStatus, tradeRecognitionRegion, tradeRecognitionResultRegion, recognitionDiagnostics } = elements;
  const reviewPreviews = new PreviewRegistry();
  let disposed = false;
  const resultTable = (section, title, headers, rows) => {
    const heading = document.createElement("h3"); heading.textContent = title;
    const wrap = document.createElement("div"); wrap.className = "trade-recognition-table-wrap";
    const table = document.createElement("table"); table.className = "trade-recognition-table";
    const head = table.createTHead().insertRow();
    headers.forEach((label) => { const cell = document.createElement("th"); cell.textContent = label; head.append(cell); });
    const body = table.createTBody();
    rows.forEach((values) => {
      const row = body.insertRow();
      values.forEach((value) => { const cell = row.insertCell(); cell.textContent = value === null || value === undefined ? "미확인" : String(value); });
    });
    wrap.append(table); section.replaceChildren(heading, wrap);
  };
  const fieldLabels = ["섬", "교환 아이템", "필요 수량", "결과 아이템", "교환 횟수", "결과 수량"];
  const renderLiveList = (result) => {
    if (disposed) return;
    const tradeCatalog = getCatalog();
    reviewPreviews.clear();
    const visibleRows = prepareLiveTradeRows(result, tradeCatalog);
    for (const row of result.rows) {
      row.reviewFields ??= [];
      for (const [name, field] of Object.entries(row.fields)) {
        if (!Object.hasOwn(field, "automaticCorrected")) field.automaticCorrected = field.corrected;
        if (field.reviewRequired && !row.reviewFields.includes(name)) row.reviewFields.push(name);
      }
    }
    onResult(result);
    liveListSection.hidden = false;
    resultTable(liveListSection, `물교 목록 · ${visibleRows.length}행 · 중복 ${result.rows.length - visibleRows.length}행 통합`, ["섬", "요구 아이템", "요구 수량", "결과 아이템", "남은 교환 횟수", "결과 수량"], visibleRows.map(({row}) =>
      ["island", "fromItem", "reqAmount", "toItem", "count", "yield"].map((name) => {
        const field = row.fields[name];
        const numeric = ["reqAmount", "count", "yield"].includes(name);
        const value = field.corrected ?? (numeric ? "?" : field.rawOCR || "?");
        return `${value}${field.reviewRequired ? `\n확인 필요${field.allowedValues ? ` (${field.allowedValues.join("·")})` : ""}` : ""}`;
      })));
    const renderedRows = liveListSection.querySelector(".trade-recognition-table tbody").rows;
    const tableRows = new Map(visibleRows.map(({index}, position) => [index, renderedRows[position]]));
    visibleRows.forEach(({row, index}) => {
      for (const [name, column, label] of [["reqAmount", 2, "요구 수량"], ["yield", 5, "결과 수량"], ["count", 4, "교환 횟수"]]) {
      if (row.fields[name].valueSource === "TRADE_RULE") continue;
      const edit = document.createElement("button"); edit.type = "button";
      edit.className = "trade-recognition-edit"; edit.textContent = "수량 수정";
      edit.dataset.action = name === "reqAmount" ? "review-live-requirement" : "review-live-number"; edit.dataset.row = String(index);
      edit.setAttribute("aria-label", `${index + 1}행 ${label} 수정`);
      edit.addEventListener("click", () => {
        if (getPending()) return;
        row.fields[name].reviewRequired = true;
        row.fields[name].valueSource = "USER_EDIT";
        renderLiveList(result);
        liveListSection.querySelector(`input[data-row="${index}"][data-field="${name}"]`)?.focus();
      });
      tableRows.get(index).cells[column].append(document.createElement("br"), edit);
      }
      const include = document.createElement("input"); include.type = "checkbox"; include.checked = !row.excluded;
      include.disabled = getPending(); include.dataset.action = "include-live-list-row";
      include.setAttribute("aria-label", `${index + 1}행 목록 포함`);
      include.addEventListener("change", () => { row.excluded = !include.checked; renderLiveList(result); });
      tableRows.get(index).cells[0].prepend(include);
    });
    const details = document.createElement("details");
    const summary = document.createElement("summary"); summary.textContent = "인식 원문 보기";
    const raw = document.createElement("section");
    resultTable(raw, "인식 원문", fieldLabels, result.rows.map((row) =>
      ["island", "fromItem", "reqAmount", "toItem", "count", "yield"].map((name) => row.fields[name].rawOCR || "?")));
    details.append(summary, raw); liveListSection.append(details);
    const reviewRows = visibleRows.filter(({ row }) => row.reviewFields.some((name) => row.fields[name].reviewRequired));
    const applyNew = document.createElement("button"); applyNew.type = "button";
    applyNew.dataset.action = "apply-live-new"; applyNew.textContent = "최종 물교 리스트로 새 회차 시작";
    const applyAppend = document.createElement("button"); applyAppend.type = "button";
    applyAppend.dataset.action = "apply-live-append"; applyAppend.textContent = "현재 회차에 추가";
    const updateApplyState = () => {
      const included = visibleRows.map(({row}) => row).filter((row) => !row.excluded);
      applyNew.disabled = applyAppend.disabled = getPending() || !included.length || included.some((row) => Object.values(row.fields).some((field) => field.reviewRequired));
      const blocked = visibleRows.flatMap(({row, index}) => row.excluded ? [] : Object.entries(row.fields).filter(([,field]) => field.reviewRequired).map(([name]) => `${index + 1}행 ${fieldLabels[["island","fromItem","reqAmount","toItem","count","yield"].indexOf(name)]}`));
      blocker.textContent = blocked.length ? `확인할 값 ${blocked.length}곳 · 아래 강조한 부분만 확인하세요. 고정 수량은 자동 적용했습니다.` : included.length ? `최종 리스트 ${included.length}행 준비 완료 · 중복 ${result.rows.length - visibleRows.length}행 통합` : "포함할 행을 선택하세요.";
    };
    const blocker = document.createElement("p"); blocker.setAttribute("role", "status"); blocker.dataset.role = "live-list-blockers";
    updateApplyState();
    if (reviewRows.length) {
      const review = document.createElement("section"); review.dataset.role = "live-list-review";
      const title = document.createElement("h3"); title.textContent = `확인 목록 · ${reviewRows.length}행`;
      const guidance = document.createElement("p"); guidance.textContent = "각 행을 리스트에 넣을지 직접 선택하세요. 포함할 행의 확인 필요한 값만 수정하면 됩니다.";
      const counts = document.createElement("p"); counts.className = "trade-review-counts"; counts.setAttribute("role", "status");
      const form = document.createElement("form"); form.noValidate = true;
      const inputs = [];
      const updateSelection = () => {
        const excluded = result.rows.filter((row) => row.excluded).length;
        const unresolved = visibleRows.filter(({row}) => !row.excluded).reduce((total, {row}) => total + Object.values(row.fields).filter((field) => field.reviewRequired).length, 0);
        counts.textContent = `최종 리스트 포함 ${visibleRows.length - excluded}행 · 제외 ${excluded}행 · 중복 ${result.rows.length - visibleRows.length}행 통합 · 확인할 값 ${unresolved}곳`;
        tradeRecognitionStatus.textContent = counts.textContent;
        updateApplyState();
      };
      reviewRows.forEach(({ row, index }) => {
        const card = document.createElement("section"); card.className = "trade-review-row"; card.dataset.row = String(index);
        const header = document.createElement("div"); header.className = "trade-review-row-header";
        const heading = document.createElement("strong"); heading.textContent = `${index + 1}행 · ${row.fields.island.corrected ?? row.fields.island.rawOCR}`;
        const rowStatus = document.createElement("span"); rowStatus.className = "trade-review-row-status";
        const choice = document.createElement("label"); choice.className = "trade-review-choice";
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = !row.excluded;
        checkbox.disabled = getPending();
        checkbox.dataset.action = "include-live-row"; checkbox.dataset.row = String(index);
        checkbox.setAttribute("aria-label", `${index + 1}행 최종 리스트에 포함`);
        const choiceText = document.createElement("span"); choice.append(checkbox, choiceText); header.append(heading, rowStatus, choice);
        const overview = document.createElement("p"); overview.className = "trade-review-overview";
        overview.textContent = `${row.fields.fromItem.corrected ?? row.fields.fromItem.rawOCR} → ${row.fields.toItem.corrected ?? row.fields.toItem.rawOCR} · 요구 ${row.fields.reqAmount.corrected ?? "?"} / 결과 ${row.fields.yield.corrected ?? "?"} · 남은 ${row.fields.count.corrected ?? "?"}회`;
        const fields = document.createElement("div"); fields.className = "trade-review-fields";
        const unresolved = row.reviewFields.filter((name) => row.fields[name].reviewRequired && row.fields[name].valueSource !== "TRADE_RULE");
        const capture = tradeQueue.items.find((item) => item.metadata.captureId === row.captureId);
        const preview = document.createElement("div"); preview.className = "trade-review-source";
        if (capture && row.rowBox) {
          const box = row.rowBox;
          preview.style.aspectRatio = `${box.width} / ${box.height}`;
          const image = document.createElement("img"); image.alt = `${index + 1}행 원본 화면 · 강조된 값만 확인`;
          image.src = reviewPreviews.create(capture.blob);
          image.style.width = `${capture.metadata.frame.width / box.width * 100}%`;
          image.style.left = `${-box.x / box.width * 100}%`;
          image.style.top = `${-box.y / box.height * 100}%`;
          preview.append(image);
          for (const name of unresolved) {
            const fieldBox = row.fields[name].box;
            if (!fieldBox) continue;
            const mark = document.createElement("span"); mark.className = "trade-review-source-mark";
            mark.style.cssText = `left:${(fieldBox.x-box.x)/box.width*100}%;top:${(fieldBox.y-box.y)/box.height*100}%;width:${fieldBox.width/box.width*100}%;height:${fieldBox.height/box.height*100}%`;
            preview.append(mark);
          }
        }
        card.append(header, overview, preview, fields); form.append(card);
        const rowInputs = unresolved.map((name) => {
          const entry = { row, index, name, field: row.fields[name] };
          const label = document.createElement("label"); label.dataset.field = name;
          const caption = document.createElement("span"); caption.textContent = fieldLabels[["island", "fromItem", "reqAmount", "toItem", "count", "yield"].indexOf(entry.name)];
          const input = document.createElement("input"); input.required = true;
          input.dataset.row = String(entry.index); input.dataset.field = entry.name;
          input.setAttribute("aria-label", `${index + 1}행 · ${caption.textContent}`);
          const numeric = ["reqAmount", "count", "yield"].includes(entry.name);
          input.type = numeric ? "number" : "text";
          if (numeric) { input.step = "1"; input.min = entry.name === "count" ? "0" : "1"; }
          input.value = entry.field.reviewDraft ?? entry.field.corrected ?? (numeric ? "" : entry.field.rawOCR);
          input.addEventListener("input", () => { entry.field.reviewDraft = input.value; entry.field.reviewRequired = true; updateSelection(); });
          const source = document.createElement("small"); source.textContent = entry.field.reviewReason || (numeric ? entry.field.allowedValues ? "2개 또는 3개인지 원본 숫자를 확인하세요." : "숫자를 확정하지 못했습니다. 강조된 원본과 비교하세요." : "품목·섬 이름을 확정하지 못했습니다. 강조된 원본과 비교하세요.");
          label.append(caption, input, source); fields.append(label);
          return { ...entry, input, numeric };
        });
        inputs.push(...rowInputs);
        const updateRow = () => {
          card.classList.toggle("trade-review-excluded", Boolean(row.excluded));
          const tableRow = tableRows.get(index);
          tableRow.classList.toggle("trade-review-excluded", Boolean(row.excluded));
          choiceText.textContent = row.excluded ? "리스트에서 제외" : "리스트에 포함";
          rowStatus.textContent = row.excluded ? "제외 선택" : row.reviewFields.some((name) => row.fields[name].reviewRequired) ? "값 확인 필요" : "확인 완료";
          const projected = structuredClone(row);
          for (const name of ["fromItem", "toItem"]) if (projected.fields[name].reviewDraft !== undefined) projected.fields[name].corrected = projected.fields[name].reviewDraft;
          applyLiveTradeRules(projected, tradeCatalog);
          rowInputs.forEach(({ name, input }) => {
            const fixed = projected.fields[name].valueSource === "TRADE_RULE";
            input.closest("label").hidden = fixed;
            input.disabled = Boolean(row.excluded) || getPending() || fixed;
          });
          updateSelection();
        };
        checkbox.addEventListener("change", () => { row.excluded = !checkbox.checked; updateRow(); });
        fields.addEventListener("input", updateRow);
        updateRow();
      });
      const confirm = document.createElement("button"); confirm.type = "submit"; confirm.className = "primary"; confirm.disabled = getPending(); confirm.textContent = "포함한 행의 수정 내용 확인"; form.append(confirm);
      const error = document.createElement("p"); error.setAttribute("role", "status");
      let feedbackId = null;
      let feedbackValues = null;
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const values = inputs.map((entry) => entry.numeric ? Number(entry.input.value) : entry.input.value.trim());
        const candidate = structuredClone(result);
        inputs.forEach((entry, i) => {
          if (entry.row.excluded) return;
          Object.assign(candidate.rows[entry.index].fields[entry.name], {corrected: values[i], reviewRequired: false, valueSource: "USER_REVIEW"});
          delete candidate.rows[entry.index].fields[entry.name].reviewDraft;
          delete candidate.rows[entry.index].fields[entry.name].importReview;
          delete candidate.rows[entry.index].fields[entry.name].reviewReason;
        });
        candidate.rows.forEach((row) => applyLiveTradeRules(row, tradeCatalog));
        const invalid = inputs.findIndex((entry, i) => !entry.row.excluded && candidate.rows[entry.index].fields[entry.name].valueSource !== "TRADE_RULE" && (entry.input.value.trim() === "" || (entry.numeric
          ? !Number.isSafeInteger(values[i]) || values[i] < (entry.name === "count" ? 0 : 1)
            || candidate.rows[entry.index].fields[entry.name].allowedValues && !candidate.rows[entry.index].fields[entry.name].allowedValues.includes(values[i])
          : !values[i])));
        if (invalid !== -1 && candidate.rows[inputs[invalid].index].fields[inputs[invalid].name].valueSource !== "TRADE_RULE") { const entry = inputs[invalid]; error.textContent = `${entry.index + 1}행 · ${entry.input.getAttribute("aria-label")} 값 '${entry.input.value}'을 확인하세요.${entry.field.allowedValues ? ` 허용 수량: ${entry.field.allowedValues.join(" 또는 ")}` : ""}`; entry.input.focus(); return; }
        if (confirm.disabled) return;
        const corrections = inputs.flatMap((entry, i) => entry.row.excluded || candidate.rows[entry.index].fields[entry.name].valueSource === "TRADE_RULE" || entry.field.corrected === values[i]
          || entry.field.automaticCorrected === values[i] ? [] : [{
          captureId: entry.row.captureId, ordinal: entry.row.ordinal, rowBox: entry.row.rowBox,
          field: entry.name, box: entry.field.box, rawOCR: entry.field.rawOCR,
          confidence: entry.field.confidence ?? null, automaticCorrected: entry.field.automaticCorrected,
          finalValue: values[i],
        }]);
        {
          prepareLiveTradeRows(candidate, tradeCatalog);
          const key = JSON.stringify(candidate);
          if (key !== feedbackValues) { feedbackId = crypto.randomUUID(); feedbackValues = key; }
          confirm.disabled = true;
          for (const control of form.elements) control.disabled = true;
          setPending(true);
          try { await saveTradeCorrections(tradeQueue.items, candidate, corrections, feedbackId, "reviewed"); }
          catch (failure) { error.textContent = failure.message; return; }
          finally {
            for (const control of form.elements) control.disabled = false;
            inputs.forEach(({ row, input }) => { input.disabled = Boolean(row.excluded); });
            setPending(false);
          }
        }
        result.rows = candidate.rows;
        renderLiveList(result);
      });
      review.append(title, guidance, counts, form, error); liveListSection.prepend(review);
    }
    const apply = async (mode, button) => {
      const includedRows = prepareLiveTradeRows(result, tradeCatalog).map(({row}) => row).filter((row) => !row.excluded);
      if (mode === "new" && state.session.scannedTrades !== null && !window.confirm("현재 회차를 이 최종 물교 목록으로 바꿀까요?")) return;
      button.disabled = true;
      try {
        await saveTradeCorrections(tradeQueue.items, result, [], crypto.randomUUID(), "reviewed");
        const rows = includedRows.map((row) => Object.fromEntries(Object.entries(row.fields).map(([key, field]) => [key, field.corrected])));
        const applied = await applyLiveTradeRows(rows, mode);
        await whenPersistenceIdle();
        tradeRecognitionStatus.textContent = `최종 물교 ${applied.trades.length}행을 현재 회차에 적용했습니다. 물교 목록에서 스케줄을 생성할 수 있습니다.`;
      } catch (error) {
        for (const outcome of error.outcomes ?? []) {
          const row = includedRows[outcome.index];
          for (const field of outcome.field ? [outcome.field] : ["island", "fromItem", "toItem"]) {
            if (row?.fields[field]) Object.assign(row.fields[field], {reviewRequired: true, importReview: mode === "append" ? "APPEND" : true});
          }
        }
        if (error.outcomes?.length) renderLiveList(result);
        tradeRecognitionStatus.textContent = error.outcomes?.length
          ? `리스트 생성 보류: ${error.outcomes.map((outcome) => `${result.rows.indexOf(includedRows[outcome.index]) + 1}행 ${fieldLabels[["island","fromItem","reqAmount","toItem","count","yield"].indexOf(outcome.field)] ?? "기존 목록 충돌"}: ${outcome.candidates?.length ? `후보 ${outcome.candidates.join(" / ")}` : outcome.field ? `마스터에서 품목을 찾지 못함 (${includedRows[outcome.index].fields[outcome.field].corrected})` : "같은 섬·결과 품목의 요구 품목이 다름"}`).join(" · ")}`
          : error.message;
      }
      finally { updateApplyState(); }
    };
    applyNew.addEventListener("click", () => void apply("new", applyNew));
    applyAppend.addEventListener("click", () => void apply("append", applyAppend));
    const actions = document.createElement("div"); actions.className = "trade-live-actions";
    actions.append(applyNew, applyAppend, blocker);
    liveListSection.prepend(actions);
    if (reviewRows.length) {
      const ready = document.createElement("details"); ready.className = "trade-ready-list";
      const caption = document.createElement("summary"); caption.textContent = `전체 목록 ${visibleRows.length}행 보기 · 고정 수량 자동 적용`;
      ready.append(caption, liveListSection.querySelector(":scope > h3"), liveListSection.querySelector(".trade-recognition-table-wrap"));
      liveListSection.append(ready);
    }
    tradeRecognitionResultRegion.hidden = false;
    tradeRecognitionRegion.style.flex = "0 0 auto";
    recognitionDiagnostics.hidden = true;
    liveListSection.scrollIntoView({ block: "nearest" });
    tradeRecognitionResultRegion.scrollTop = 0;
  };
  const clear = () => {
    reviewPreviews.clear();
    liveListSection.replaceChildren();
    liveListSection.hidden = true;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clear();
    liveListSection.remove();
  };
  return { render: renderLiveList, clear, dispose };
}
