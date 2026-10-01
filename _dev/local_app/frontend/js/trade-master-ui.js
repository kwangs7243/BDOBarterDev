import { adaptLegacyCatalog } from "./domain/trade-master-registry.js";
import {
  adaptRegistrySnapshotV1ToMasterBundleV2,
  validateMasterBundleV2,
} from "./domain/trade-master-bundle.js";

const STATUSES = Object.freeze([
  ["LEGACY_UNVERIFIED", "미검증 legacy"],
  ["VERIFIED_CURATED", "owner 검증 완료 목표"],
  ["DISPUTED", "이견 있음"],
  ["DEPRECATED", "사용 중단 목표"],
]);
const LIFECYCLE = new Set(STATUSES.map(([value]) => value));
const SPECIAL_CATEGORY = "LEGACY_SPECIAL_ITEM";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function loadProductionPreview() {
  const response = await fetch("/assets/data/trade-catalog.json", {
    credentials: "same-origin",
    cache: "no-cache",
  });
  if (!response.ok) throw new Error(`catalog fetch failed (${response.status})`);
  const bytes = await response.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const sourceSha256 = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const sourceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const catalog = JSON.parse(sourceText);
  const registry = adaptLegacyCatalog(catalog, {
    sourceRevision: "current-trade-catalog",
    sourceSha256,
    curatedMappings: null,
  });
  return adaptRegistrySnapshotV1ToMasterBundleV2(registry, {
    createdAt: new Date().toISOString(),
  });
}

function itemKind(legacyKind) {
  return legacyKind === "ISLAND" ? "ISLAND" : "ITEM";
}

function sourceRecords(bundle) {
  const byStableId = new Map(bundle.entities.map((entity) => [entity.stableId, entity]));
  const records = [];
  for (const entity of bundle.entities) {
    if (entity.legacyNames.length) {
      for (const record of entity.legacyNames) records.push({ record, entity });
    } else {
      records.push({ record: null, entity });
    }
  }
  for (const record of bundle.unresolvedLegacyNames) records.push({ record, entity: null });
  return records.map(({ record, entity }) => {
    const legacyKind = record?.legacyKind ?? (entity?.kind === "ISLAND" ? "ISLAND" : "MASTER_ITEM");
    const rawName = record?.rawName ?? entity?.canonicalName ?? entity?.stableId ?? "이름 미지정 entity";
    const key = entity ? `entity:${entity.stableId}` : `legacy:${record.legacyNameKey}`;
    return {
      key,
      record,
      entity: entity ? byStableId.get(entity.stableId) : null,
      stableId: entity?.stableId ?? null,
      rawName,
      legacyKind,
      kind: itemKind(legacyKind),
      tier: record?.tier ?? entity?.tier ?? null,
      category: entity?.category ?? (legacyKind === "SPECIAL_ITEM" ? SPECIAL_CATEGORY : null),
      occurrences: record?.occurrences ?? [],
      authorityStatus: record?.authorityStatus ?? entity?.status ?? "LEGACY_UNVERIFIED",
      legacyNameKey: record?.legacyNameKey ?? null,
    };
  });
}

function initialDraft(item) {
  const entity = item.entity;
  return {
    canonicalName: entity?.canonicalName ?? item.rawName,
    displayName: entity?.displayNames?.[0]?.text ?? "",
    aliases: (entity?.aliases ?? []).map((alias) => alias.text),
    tier: item.kind === "ITEM" ? String(item.tier ?? "") : "",
    category: item.category ?? "",
    targetStatus: entity?.status ?? "LEGACY_UNVERIFIED",
    ownerNote: entity?.provenance?.note ?? "",
    ownerConfirmed: false,
  };
}

function sameDraft(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function occurrenceSummary(item) {
  if (!item.record) return "기존 entity · source legacy 연결 없음";
  const tierText = item.legacyKind === "MASTER_ITEM" ? `원본 tier ${item.tier}`
    : item.legacyKind === "SPECIAL_ITEM" ? "특수 품목 · 원본 분류 유지"
      : "섬 · tier 비적용";
  return `${tierText} · 출처 ${item.occurrences.length}곳`;
}

function labelField(label, control, { hint = "", wide = false } = {}) {
  const wrapper = element("label", `trade-master-field${wide ? " trade-master-field-wide" : ""}`);
  wrapper.append(element("span", "", label));
  wrapper.append(control);
  if (hint) wrapper.append(element("small", "", hint));
  return wrapper;
}

function setSummary(root, bundle, items) {
  const occurrenceCount = [...bundle.entities.flatMap((entity) => entity.legacyNames), ...bundle.unresolvedLegacyNames]
    .reduce((sum, record) => sum + record.occurrences.length, 0);
  const namesCount = bundle.entities.reduce((sum, entity) => sum + entity.legacyNames.length, 0)
    + bundle.unresolvedLegacyNames.length;
  const values = {
    occurrences: occurrenceCount,
    names: namesCount,
    verified: bundle.entities.filter((entity) => entity.status === "VERIFIED_CURATED").length,
    unresolved: bundle.unresolvedLegacyNames.length,
    saved: 0,
  };
  for (const [key, value] of Object.entries(values)) {
    const target = root.querySelector(`[data-master-summary="${key}"]`);
    if (target) target.textContent = String(value);
  }
}

function verifiedDraftProblem(item, draft) {
  if (draft.targetStatus !== "VERIFIED_CURATED") return "";
  if (!draft.canonicalName.trim()) return "검증 목표에는 Canonical 이름이 필요합니다.";
  if (item.kind === "ITEM") {
    const tier = Number(draft.tier);
    if (!Number.isInteger(tier) || tier < 1 || tier > 7) return "품목 검증 목표에는 tier 1~7 확인이 필요합니다.";
    if (item.legacyKind === "SPECIAL_ITEM" && draft.category !== SPECIAL_CATEGORY) return "특수 품목 원본 분류를 유지해야 합니다.";
  }
  if (!draft.ownerConfirmed) return "owner 확인 체크가 필요합니다.";
  return "";
}

export function initTradeMasterUI({
  loadMasterPreview = loadProductionPreview,
  saveMaster = null,
  dialog = document.querySelector("#trade-master-dialog"),
  openButton = document.querySelector("#open-trade-master"),
} = {}) {
  if (!dialog) throw new TypeError("trade master dialog is required");
  const list = dialog.querySelector("[data-master-list]");
  const editor = dialog.querySelector("[data-master-editor]");
  const search = dialog.querySelector("[data-master-search]");
  const errorBox = dialog.querySelector("[data-master-error]");
  const unsavedLabel = dialog.querySelector("[data-master-unsaved]");
  const saveButton = dialog.querySelector("[data-master-save]");
  const state = { bundle: null, items: [], drafts: new Map(), selectedKey: null, filter: "ALL", loadPromise: null };

  if (saveButton) {
    saveButton.disabled = true;
    saveButton.title = "저장 기능은 다음 단계에서 활성화됩니다.";
  }

  function getDraft(item) {
    if (!state.drafts.has(item.key)) {
      const baseline = initialDraft(item);
      state.drafts.set(item.key, { baseline, value: clone(baseline), status: "UNTOUCHED" });
    }
    return state.drafts.get(item.key);
  }

  function updateUnsaved() {
    const changed = [...state.drafts.values()].filter((draft) => draft.status !== "UNTOUCHED").length;
    unsavedLabel.textContent = changed
      ? `저장되지 않은 초안 ${changed}개 · 창을 닫았다 다시 열면 유지되지만 새로고침하면 사라집니다.`
      : "저장되지 않은 초안은 없습니다. 창을 닫았다 다시 열면 유지되지만 새로고침하면 사라집니다.";
  }

  function updateList() {
    if (!list) return;
    const query = search?.value.toLocaleLowerCase() ?? "";
    const filtered = state.items.filter((item) => {
      if (state.filter !== "ALL" && item.kind !== state.filter) return false;
      if (!query) return true;
      const draft = getDraft(item).value;
      const haystack = [item.rawName, draft.canonicalName, draft.displayName, ...draft.aliases].join("\n").toLocaleLowerCase();
      return haystack.includes(query);
    });
    list.replaceChildren();
    for (const item of filtered) {
      const entry = getDraft(item);
      const button = element("button", "trade-master-list-item");
      button.type = "button";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(state.selectedKey === item.key));
      button.dataset.masterKey = item.key;
      button.append(element("span", "trade-master-list-name", item.rawName));
      button.append(element("span", "trade-master-list-kind", item.kind === "ITEM" ? "품목" : "섬"));
      button.append(element("span", "trade-master-list-meta", occurrenceSummary(item)));
      const statusText = entry.status === "DRAFT_REVIEWED_PENDING_SAVE" ? "저장 전 검토됨"
        : entry.status === "DRAFT_EDITED" ? "수정 중" : "미검토";
      const stateLabel = element("span", "trade-master-list-state", statusText);
      stateLabel.dataset.state = entry.status;
      button.append(stateLabel);
      button.addEventListener("click", () => {
        state.selectedKey = item.key;
        updateList();
        renderEditor(item);
      });
      list.append(button);
    }
    const count = dialog.querySelector("[data-master-list-count]");
    if (count) count.textContent = `${filtered.length}개 표시 · 전체 ${state.items.length}개`;
  }

  function renderEditor(item) {
    if (!editor) return;
    const draftRecord = getDraft(item);
    const draft = draftRecord.value;
    editor.replaceChildren();
    const heading = element("div", "trade-master-editor-title");
    heading.append(element("h3", "", item.rawName));
    heading.append(element("span", "trade-master-kind-badge", item.kind === "ITEM" ? "품목" : "섬"));
    editor.append(heading);

    const fields = element("div", "trade-master-editor-grid");
    fields.append(labelField("원본 legacy 이름", element("output", "trade-master-readonly", item.rawName)));
    const stableIdOutput = element("output", "trade-master-readonly", item.stableId ?? "미발급");
    stableIdOutput.setAttribute("aria-label", "stableId");
    fields.append(labelField("stableId", stableIdOutput, {
      hint: "stableId는 owner 승인 저장 단계에서만 발급됩니다.",
    }));
    fields.append(labelField("legacy kind", element("output", "trade-master-readonly", item.legacyKind)));
    const tierSource = item.legacyKind === "MASTER_ITEM" ? `원본 tier ${item.tier}` : "원본 tier 비적용";
    fields.append(labelField("원본 tier / category", element("output", "trade-master-readonly", `${tierSource} · ${item.category ?? "일반"}`)));

    const canonical = element("input");
    canonical.type = "text";
    canonical.value = draft.canonicalName;
    canonical.setAttribute("aria-label", "Canonical 이름 초안");
    fields.append(labelField("Canonical 이름 초안", canonical, { hint: "원본 이름과 분리한 저장 전 편집값입니다.", wide: true }));

    const displayName = element("input");
    displayName.type = "text";
    displayName.value = draft.displayName;
    displayName.setAttribute("aria-label", "게임 표시명 초안");
    fields.append(labelField("게임 표시명 초안", displayName, { hint: "입력해도 검증된 표시명 authority가 생기지 않습니다.", wide: true }));

    const tierSelect = element("select");
    tierSelect.setAttribute("aria-label", "tier 초안");
    const tierBlank = element("option", "", "원본과 별도로 선택");
    tierBlank.value = "";
    tierSelect.append(tierBlank);
    for (let tier = 1; tier <= 7; tier += 1) {
      const option = element("option", "", `Tier ${tier}`);
      option.value = String(tier);
      tierSelect.append(option);
    }
    tierSelect.value = draft.tier;
    tierSelect.disabled = item.kind !== "ITEM";
    fields.append(labelField("Tier 초안", tierSelect, {
      hint: item.kind === "ITEM" ? "원본 tier와 별도의 저장 전 초안입니다." : "섬에는 item tier를 적용하지 않습니다.",
    }));

    let categoryControl;
    if (item.kind === "ITEM" && item.legacyKind !== "SPECIAL_ITEM") {
      categoryControl = element("input");
      categoryControl.type = "text";
      categoryControl.value = draft.category;
      categoryControl.placeholder = "분류 초안 입력";
      categoryControl.setAttribute("aria-label", "category 초안");
    } else {
      categoryControl = element("select");
      categoryControl.setAttribute("aria-label", "category 초안");
      for (const [value, label] of [["", "미지정"], [SPECIAL_CATEGORY, SPECIAL_CATEGORY]]) {
        const option = element("option", "", label);
        option.value = value;
        categoryControl.append(option);
      }
      categoryControl.value = draft.category;
      categoryControl.disabled = item.kind !== "ITEM";
    }
    fields.append(labelField("Category 초안", categoryControl, {
      hint: item.legacyKind === "SPECIAL_ITEM" ? "M1에서 정의한 특수 품목 token만 선택할 수 있습니다." : item.kind === "ITEM" ? "자유 입력 초안입니다. category 표준 어휘는 이번 단계에서 정의하지 않습니다." : "섬에는 item category를 적용하지 않습니다.",
    }));

    const statusSelect = element("select");
    statusSelect.setAttribute("aria-label", "목표 lifecycle 초안");
    for (const [value, label] of STATUSES) {
      const option = element("option", "", label);
      option.value = value;
      statusSelect.append(option);
    }
    statusSelect.value = LIFECYCLE.has(draft.targetStatus) ? draft.targetStatus : "LEGACY_UNVERIFIED";
    fields.append(labelField("목표 lifecycle 초안", statusSelect, { hint: "현재 active Master 상태는 변경하지 않습니다." }));

    const note = element("textarea");
    note.value = draft.ownerNote;
    note.setAttribute("aria-label", "owner 메모 초안");
    fields.append(labelField("owner 메모 초안", note, { hint: "현재 브라우저 메모리에만 보관됩니다." }));

    const aliasWrap = element("div", "trade-master-field trade-master-field-wide");
    aliasWrap.append(element("span", "", "별칭 초안"));
    const aliasTools = element("div", "trade-master-alias-tools");
    const aliasInput = element("input");
    aliasInput.type = "text";
    aliasInput.setAttribute("aria-label", "추가할 별칭 초안");
    const aliasAdd = element("button", "", "별칭 추가");
    aliasAdd.type = "button";
    aliasTools.append(aliasInput, aliasAdd);
    aliasWrap.append(aliasTools);
    const aliasList = element("div", "trade-master-alias-list");
    aliasWrap.append(aliasList);
    fields.append(aliasWrap);

    const ownerConfirm = element("input");
    ownerConfirm.type = "checkbox";
    ownerConfirm.checked = draft.ownerConfirmed;
    ownerConfirm.setAttribute("aria-label", "owner 확인");
    const ownerConfirmWrap = element("label", "trade-master-owner-confirm");
    ownerConfirmWrap.append(ownerConfirm, element("span", "", "VERIFIED_CURATED 목표를 선택할 경우 필요한 owner 확인입니다. 체크해도 저장·승인되지는 않습니다."));
    fields.append(ownerConfirmWrap);
    editor.append(fields);

    const reviewAction = element("div", "trade-master-review-action");
    const reviewButton = element("button", "", draftRecord.status === "DRAFT_REVIEWED_PENDING_SAVE" ? "초안 확인 취소" : "이 초안을 확인했습니다");
    reviewButton.type = "button";
    const reviewState = element("span", "trade-master-review-state", draftRecord.status === "DRAFT_REVIEWED_PENDING_SAVE" ? "저장 전 검토됨" : draftRecord.status === "DRAFT_EDITED" ? "수정 중" : "미검토");
    reviewState.dataset.state = draftRecord.status;
    const validation = element("span", "trade-master-validation");
    reviewAction.append(reviewButton, reviewState, validation);
    editor.append(reviewAction);

    const details = element("details", "trade-master-source-details");
    details.append(element("summary", "", "원본 출처와 진단 정보"));
    const dl = element("dl", "trade-master-source-grid");
    const sourcePairs = [
      ["legacyNameKey", item.legacyNameKey ?? "기존 entity"],
      ["legacy kind", item.legacyKind],
      ["source scopes", item.occurrences.map((entry) => entry.scope).join(", ") || "없음"],
      ["source locators", item.occurrences.map((entry) => entry.locator).join(" · ") || "없음"],
      ["source revision", state.bundle?.sourceRevisions?.map((entry) => `${entry.sourceType}: ${entry.revision}`).join(" · ") ?? "없음"],
      ["source SHA-256", state.bundle?.sourceRevisions?.map((entry) => entry.sha256).join(" · ") ?? "없음"],
      ["occurrences", item.occurrences.length],
    ];
    for (const [label, value] of sourcePairs) {
      dl.append(element("dt", "", label), element("dd", "", value));
    }
    details.append(dl);
    editor.append(details);

    function renderAliases() {
      aliasList.replaceChildren();
      draft.aliases.forEach((alias, index) => {
        const chip = element("span", "trade-master-alias-chip");
        chip.append(element("span", "", alias));
        const remove = element("button", "", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", `별칭 ${alias} 삭제`);
        remove.addEventListener("click", () => {
          updateDraft("aliases", draft.aliases.filter((_entry, aliasIndex) => aliasIndex !== index));
          renderAliases();
        });
        chip.append(remove);
        aliasList.append(chip);
      });
    }

    function updateDraft(key, value) {
      draftRecord.value[key] = value;
      draftRecord.status = sameDraft(draftRecord.value, draftRecord.baseline) ? "UNTOUCHED" : "DRAFT_EDITED";
      validation.textContent = verifiedDraftProblem(item, draftRecord.value);
      reviewButton.disabled = draftRecord.value.targetStatus === "VERIFIED_CURATED" && Boolean(validation.textContent);
      reviewState.textContent = draftRecord.status === "DRAFT_EDITED" ? "수정 중" : "미검토";
      reviewState.dataset.state = draftRecord.status;
      reviewButton.textContent = "이 초안을 확인했습니다";
      updateUnsaved();
      updateList();
    }

    const bindInput = (node, key, convert = (value) => value) => node.addEventListener("input", () => updateDraft(key, convert(node.value)));
    bindInput(canonical, "canonicalName");
    bindInput(displayName, "displayName");
    bindInput(tierSelect, "tier");
    bindInput(categoryControl, "category");
    bindInput(statusSelect, "targetStatus");
    bindInput(note, "ownerNote");
    ownerConfirm.addEventListener("change", () => updateDraft("ownerConfirmed", ownerConfirm.checked));
    const addAlias = () => {
      const value = aliasInput.value;
      if (!value.trim() || draft.aliases.includes(value)) return;
      updateDraft("aliases", [...draft.aliases, value]);
      aliasInput.value = "";
      renderAliases();
    };
    aliasAdd.addEventListener("click", addAlias);
    aliasInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); addAlias(); }
    });
    reviewButton.addEventListener("click", () => {
      if (draftRecord.status === "DRAFT_REVIEWED_PENDING_SAVE") {
        draftRecord.status = sameDraft(draftRecord.value, draftRecord.baseline) ? "UNTOUCHED" : "DRAFT_EDITED";
      } else {
        const problem = verifiedDraftProblem(item, draftRecord.value);
        if (problem) { validation.textContent = problem; return; }
        draftRecord.status = "DRAFT_REVIEWED_PENDING_SAVE";
      }
      reviewButton.textContent = draftRecord.status === "DRAFT_REVIEWED_PENDING_SAVE" ? "초안 확인 취소" : "이 초안을 확인했습니다";
      reviewState.textContent = draftRecord.status === "DRAFT_REVIEWED_PENDING_SAVE" ? "저장 전 검토됨"
        : draftRecord.status === "DRAFT_EDITED" ? "수정 중" : "미검토";
      reviewState.dataset.state = draftRecord.status;
      validation.textContent = "";
      updateUnsaved();
      updateList();
    });
    renderAliases();
    validation.textContent = verifiedDraftProblem(item, draft);
    reviewButton.disabled = draft.targetStatus === "VERIFIED_CURATED" && Boolean(validation.textContent);
  }

  function showLoadError(error) {
    if (!errorBox) return;
    errorBox.replaceChildren(element("span", "", `마스터 미리보기를 불러오지 못했습니다: ${error?.message ?? "알 수 없는 오류"} `));
    const retry = element("button", "", "다시 불러오기");
    retry.type = "button";
    retry.addEventListener("click", () => { state.loadPromise = null; void load(); });
    errorBox.append(retry);
    errorBox.hidden = false;
    editor?.replaceChildren(element("div", "trade-master-empty", "자료를 불러오지 못했습니다. 위 안내에서 다시 시도할 수 있습니다."));
  }

  async function load() {
    if (state.bundle) return state.bundle;
    if (!state.loadPromise) {
      state.loadPromise = Promise.resolve().then(loadMasterPreview).then((bundle) => {
        const validation = validateMasterBundleV2(bundle);
        if (!validation.ok) throw new Error(`Master bundle 검증 실패: ${validation.errors.join("; ")}`);
        state.bundle = bundle;
        state.items = sourceRecords(bundle);
        setSummary(dialog, bundle, state.items);
        updateUnsaved();
        if (errorBox) { errorBox.hidden = true; errorBox.replaceChildren(); }
        updateList();
        if (!state.selectedKey && state.items.length) {
          state.selectedKey = state.items[0].key;
          updateList();
          renderEditor(state.items[0]);
        }
        return bundle;
      }).catch((error) => {
        state.loadPromise = null;
        showLoadError(error);
        throw error;
      });
    }
    return state.loadPromise;
  }

  function open() {
    if (!dialog.open) dialog.showModal();
    if (state.bundle) search?.focus();
    else void load().then(() => search?.focus()).catch(() => {});
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  openButton?.addEventListener("click", open);
  dialog.querySelectorAll("[data-master-close]").forEach((button) => button.addEventListener("click", close));
  search?.addEventListener("input", updateList);
  dialog.querySelectorAll("[data-master-filter]").forEach((button) => button.addEventListener("click", () => {
    state.filter = button.dataset.masterFilter;
    dialog.querySelectorAll("[data-master-filter]").forEach((candidate) => candidate.setAttribute("aria-pressed", String(candidate === button)));
    updateList();
  }));

  return Object.freeze({ open, close });
}
