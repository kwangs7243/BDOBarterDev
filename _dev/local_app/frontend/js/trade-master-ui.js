import { adaptLegacyCatalog } from "./domain/trade-master-registry.js";
import {
  createMasterBundleV2,
  adaptRegistrySnapshotV1ToMasterBundleV2,
  applyTradeMasterReferenceManifestToBundleV2,
  validateMasterBundleV2,
} from "./domain/trade-master-bundle.js";
import { computeCatalogProvenanceV2 } from "./domain/trade-catalog-provenance.js";

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

async function loadLegacySeed() {
  const response = await fetch("/assets/data/trade-catalog.json", {
    credentials: "same-origin",
    cache: "no-cache",
  });
  if (!response.ok) throw new Error(`catalog fetch failed (${response.status})`);
  const bytes = await response.arrayBuffer();
  const catalogProvenance = computeCatalogProvenanceV2(bytes);
  const sourceSha256 = catalogProvenance.sha256;
  const registry = adaptLegacyCatalog(catalogProvenance.catalog, {
    sourceRevision: `catalog-provenance-v2:${sourceSha256}`,
    sourceSha256,
    curatedMappings: null,
  });
  const base = adaptRegistrySnapshotV1ToMasterBundleV2(registry, {
    createdAt: new Date().toISOString(),
    catalogProvenance: { schemaVersion: catalogProvenance.schemaVersion,
      hashBasis: catalogProvenance.hashBasis, sha256: sourceSha256 },
  });
  const manifestResponse = await fetch("/assets/data/trade-master-reference-manifest-v2.json", {
    credentials: "same-origin", cache: "no-cache",
  });
  if (!manifestResponse.ok) throw new Error(`reference manifest fetch failed (${manifestResponse.status})`);
  const manifest = await manifestResponse.json();
  return applyTradeMasterReferenceManifestToBundleV2(base, manifest, {
    createdAt: new Date().toISOString(), catalogBytes: bytes,
  });
}

async function loadProductionPreview() {
  try {
    const response = await fetch("/api/master/active", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`Master 저장소 응답 ${response.status}`);
    const active = await response.json();
    if (active.ok !== true) throw new Error("Master 저장소 상태를 확인할 수 없습니다.");
    if (active.bundle) return { bundle: active.bundle, activeRegistryVersion: active.activeRegistryVersion,
      storeRevision: active.storeRevision, persistenceAvailable: true };
    return { bundle: await loadLegacySeed(), activeRegistryVersion: null, storeRevision: active.storeRevision,
      persistenceAvailable: true };
  } catch (error) {
    const bundle = await loadLegacySeed();
    return { bundle, activeRegistryVersion: null, storeRevision: null, persistenceAvailable: false,
      storageError: error?.message ?? "Master 저장소 연결 실패" };
  }
}

async function postJson(path, payload) {
  let response;
  try {
    response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch (error) {
    throw Object.assign(new Error("저장 요청 응답을 받지 못했습니다. 같은 요청으로 다시 시도할 수 있습니다."), { cause: error, networkAmbiguous: path.endsWith("/publish") });
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    const code = body?.error?.code ?? "master_request_failed";
    const messages = {
      master_revision_conflict: "Master가 변경되었습니다. 다시 불러와 검수해 주세요.",
      master_mutation_conflict: "같은 저장 요청 ID에 다른 내용이 연결되어 저장을 중단했습니다.",
      master_store_unavailable: "Master 저장소를 사용할 수 없습니다.",
      approval_required: "명시적인 owner 확인이 필요합니다.",
      proposal_mismatch: "저장 후보와 검토한 proposal이 일치하지 않습니다.",
    };
    throw Object.assign(new Error(messages[code] ?? `Master 저장 요청 실패 (${response.status})`), {
      status: response.status, code, retryable: response.status >= 500,
    });
  }
  return body;
}

async function saveProductionMaster(candidate, expectedRegistryVersion, pending) {
  if (pending.receipt) {
    const activeResponse = await fetch("/api/master/active", { credentials: "same-origin", cache: "no-store" });
    if (!activeResponse.ok) throw Object.assign(new Error("저장 응답을 받았지만 최종 확인에 실패했습니다."), { readbackOnly: true });
    const active = await activeResponse.json();
    if (active.activeRegistryVersion !== pending.receipt.registryVersion
        || active.bundle?.contentHash !== pending.receipt.contentHash) {
      throw Object.assign(new Error("저장 응답을 받았지만 최종 확인에 실패했습니다."), { readbackOnly: true });
    }
    return { bundle: active.bundle, activeRegistryVersion: active.activeRegistryVersion,
      storeRevision: active.storeRevision, receipt: pending.receipt };
  }
  if (!pending.proposal) {
    const proposed = await postJson("/api/master/proposal", {
      version: 1, expectedRegistryVersion, bundle: candidate,
    });
    const proposal = proposed.proposal;
    if (!proposal || proposal.expectedRegistryVersion !== expectedRegistryVersion
        || proposal.registryVersion !== candidate.registryVersion || proposal.contentHash !== candidate.contentHash
        || typeof proposal.proposalHash !== "string") {
      throw new Error("서버 proposal receipt가 저장 후보와 일치하지 않습니다.");
    }
    pending.proposal = proposal;
  }
  if (!pending.mutationId) pending.mutationId = globalThis.crypto.randomUUID();
  const published = await postJson("/api/master/publish", {
    version: 1, mutationId: pending.mutationId, expectedRegistryVersion, ownerApproved: true,
    proposalHash: pending.proposal.proposalHash, bundle: candidate,
  });
  const receipt = { ...published };
  delete receipt.ok;
  if (receipt.registryVersion !== candidate.registryVersion || receipt.contentHash !== candidate.contentHash
      || receipt.mutationId !== pending.mutationId) {
    throw new Error("publish receipt가 저장 후보와 일치하지 않습니다.");
  }
  pending.receipt = receipt;
  return saveProductionMaster(candidate, expectedRegistryVersion, pending);
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
    const key = entity ? `entity:${entity.stableId}:${record?.legacyNameKey ?? "unlinked"}` : `legacy:${record.legacyNameKey}`;
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
    resolutionMode: item.entity ? "" : "NEW_ENTITY",
    linkStableId: "",
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
    saved: bundle.entities.length,
  };
  for (const [key, value] of Object.entries(values)) {
    const target = root.querySelector(`[data-master-summary="${key}"]`);
    if (target) target.textContent = String(value);
  }
}

function provenanceWithNote(previous, note) {
  const provenance = clone(previous ?? {});
  if (note) provenance.note = note;
  else delete provenance.note;
  return provenance;
}

function nameEntry(text, status, provenance = {}) {
  return { text, status, provenance: clone(provenance) };
}

function updateEntityFromDraft(entity, item, draft, baseline) {
  if (draft.canonicalName !== baseline.canonicalName) entity.canonicalName = draft.canonicalName;
  if (draft.displayName !== baseline.displayName) {
    const previous = entity.displayNames[0] ?? null;
    const rest = entity.displayNames.slice(previous ? 1 : 0);
    entity.displayNames = draft.displayName
      ? [nameEntry(draft.displayName, draft.targetStatus, previous?.provenance ?? {}), ...rest]
      : rest;
  }
  if (JSON.stringify(draft.aliases) !== JSON.stringify(baseline.aliases)) {
    const previousByText = new Map(entity.aliases.map((entry) => [entry.text, entry]));
    entity.aliases = draft.aliases.map((text) => {
      const previous = previousByText.get(text);
      return nameEntry(text, previous?.status ?? draft.targetStatus, previous?.provenance ?? {});
    });
  }
  if (draft.tier !== baseline.tier) entity.tier = item.kind === "ITEM" && draft.tier ? Number(draft.tier) : null;
  if (draft.category !== baseline.category) entity.category = item.legacyKind === "SPECIAL_ITEM"
    ? SPECIAL_CATEGORY : item.kind === "ITEM" && draft.category ? draft.category : null;
  if (draft.targetStatus !== baseline.targetStatus) entity.status = draft.targetStatus;
  if (draft.ownerNote !== baseline.ownerNote) entity.provenance = provenanceWithNote(entity.provenance, draft.ownerNote);
}

function buildCandidate(base, reviewed, { createId = () => globalThis.crypto.randomUUID(), createdAt = new Date().toISOString() } = {}) {
  const entities = clone(base.entities);
  const mappings = clone(base.compatibilityMappings);
  const unresolved = clone(base.unresolvedLegacyNames);
  for (const { item, draft, baseline } of reviewed) {
    if (item.entity) {
      const entity = entities.find((entry) => entry.stableId === item.entity.stableId);
      if (!entity) throw new Error("선택한 저장 entity가 현재 Master에서 사라졌습니다.");
      updateEntityFromDraft(entity, item, draft, baseline);
      continue;
    }
    const recordIndex = unresolved.findIndex((entry) => entry.legacyNameKey === item.record?.legacyNameKey);
    if (recordIndex < 0) throw new Error("검토할 unresolved legacy source를 찾을 수 없습니다.");
    const sourceRecord = unresolved[recordIndex];
    const { reason: _reason, ...legacyRecord } = sourceRecord;
    if (draft.resolutionMode === "LINK_EXISTING") {
      const target = entities.find((entry) => entry.stableId === draft.linkStableId);
      if (!target || target.kind !== item.kind) throw new Error("같은 종류의 연결 대상 entity를 선택해 주세요.");
      if (item.legacyKind === "MASTER_ITEM" && target.tier !== item.tier) throw new Error("원본 tier와 같은 entity만 연결할 수 있습니다.");
      if (item.legacyKind === "SPECIAL_ITEM" && target.category !== SPECIAL_CATEGORY) throw new Error("특수 품목 category가 호환되는 entity만 연결할 수 있습니다.");
      const baseline = getBaselineForDraft(item);
      updateEntityFromDraft(target, item, draft, baseline);
      const addedRecord = { ...legacyRecord, authorityStatus: target.status === "VERIFIED_CURATED" ? "VERIFIED_CURATED" : "LEGACY_UNVERIFIED" };
      target.legacyNames.push(addedRecord);
      unresolved.splice(recordIndex, 1);
      const mapping = mappings.find((entry) => entry.stableId === target.stableId);
      if (mapping) {
        mapping.legacyNameKeys = [...new Set([...mapping.legacyNameKeys, addedRecord.legacyNameKey])].sort();
        mapping.sourceLocators = [...new Set([...mapping.sourceLocators, ...addedRecord.occurrences.map((entry) => entry.locator)])].sort();
      } else {
        mappings.push({ stableId: target.stableId, legacyNameKeys: [addedRecord.legacyNameKey],
          sourceLocators: addedRecord.occurrences.map((entry) => entry.locator).sort() });
      }
      continue;
    }
    if (draft.resolutionMode !== "NEW_ENTITY") throw new Error("새 entity 또는 기존 entity 연결 방식을 명시해 주세요.");
    const stableId = createId();
    const status = draft.targetStatus;
    const namesStatus = status === "VERIFIED_CURATED" && draft.ownerConfirmed ? "VERIFIED_CURATED" : "LEGACY_UNVERIFIED";
    const entity = {
      stableId, kind: item.kind, canonicalName: draft.canonicalName,
      displayNames: draft.displayName ? [nameEntry(draft.displayName, namesStatus, { source: "owner-curation" })] : [],
      aliases: draft.aliases.map((text) => nameEntry(text, namesStatus, { source: "owner-curation" })),
      legacyNames: [{ ...legacyRecord, authorityStatus: status }],
      tier: item.kind === "ITEM" ? (draft.tier ? Number(draft.tier) : null) : null,
      category: item.kind === "ITEM" ? (item.legacyKind === "SPECIAL_ITEM" ? SPECIAL_CATEGORY : draft.category || null) : null,
      status, provenance: draft.ownerNote ? { note: draft.ownerNote } : {}, replacedBy: null,
    };
    entities.push(entity);
    mappings.push({ stableId, legacyNameKeys: [legacyRecord.legacyNameKey],
      sourceLocators: legacyRecord.occurrences.map((entry) => entry.locator).sort() });
    unresolved.splice(recordIndex, 1);
  }
  return createMasterBundleV2({ createdAt, entities, compatibilityMappings: mappings,
    unresolvedLegacyNames: unresolved, sourceRevisions: clone(base.sourceRevisions), provenance: clone(base.provenance) });
}

function getBaselineForDraft(item) {
  const entity = item.entity;
  return {
    canonicalName: entity?.canonicalName ?? item.rawName,
    displayName: entity?.displayNames?.[0]?.text ?? "",
    aliases: (entity?.aliases ?? []).map((alias) => alias.text),
    tier: item.kind === "ITEM" ? String(item.tier ?? "") : "",
    category: item.category ?? "",
    targetStatus: entity?.status ?? "LEGACY_UNVERIFIED",
    ownerNote: entity?.provenance?.note ?? "",
  };
}

function verifiedDraftProblem(item, draft) {
  if (!item.entity && draft.resolutionMode === "LINK_EXISTING" && !draft.linkStableId) {
    return "기존 entity 연결 대상을 직접 선택해야 합니다.";
  }
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
  loadMasterPreview = undefined,
  saveMaster = undefined,
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
  const productionLoader = loadMasterPreview ?? loadProductionPreview;
  const productionSaver = saveMaster === undefined ? saveProductionMaster : saveMaster;
  const state = { bundle: null, items: [], drafts: new Map(), selectedKey: null, filter: "ALL", loadPromise: null,
    activeRegistryVersion: null, storeRevision: null, persistenceAvailable: false, storageError: "", saveInProgress: false,
    pendingSave: null, saveBlocked: false };
  const safety = dialog.querySelector(".trade-master-safety");
  if (safety) {
    safety.querySelector("strong")?.replaceChildren(document.createTextNode("현재 Master 검수 · 저장은 다음 인식부터 반영"));
    safety.querySelector("span")?.replaceChildren(document.createTextNode("저장된 immutable Master만 이 화면에 적용됩니다. 현재 인식 결과와 회차에는 반영되지 않습니다."));
  }
  const storageNote = dialog.querySelector(".trade-master-storage-note");
  if (storageNote) storageNote.textContent = "Master 저장소 연결 상태를 확인하는 중입니다.";
  const header = dialog.querySelector(".trade-master-header");
  const activeLabel = element("p", "trade-master-active", "저장된 Master 상태 확인 전");
  activeLabel.dataset.masterActive = "";
  header?.append(activeLabel);
  const footer = dialog.querySelector(".trade-master-footer");
  const exportButton = element("button", "", "현재 Master 내보내기");
  exportButton.type = "button";
  exportButton.dataset.masterExport = "";
  exportButton.disabled = true;
  footer?.prepend(exportButton);
  const saveStatus = element("p", "trade-master-save-status", "");
  saveStatus.dataset.masterSaveStatus = "";
  footer?.append(saveStatus);
  if (saveButton) saveButton.disabled = true;

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

  function updateSaveState() {
    if (!saveButton) return;
    const changed = [...state.drafts.values()].filter((draft) => draft.status !== "UNTOUCHED");
    const allReviewed = changed.length > 0 && changed.every((draft) => draft.status === "DRAFT_REVIEWED_PENDING_SAVE");
    const pendingRetry = Boolean(state.pendingSave && !state.saveBlocked);
    saveButton.disabled = state.saveInProgress || !state.persistenceAvailable || typeof productionSaver !== "function"
      || (!pendingRetry && (!allReviewed || state.saveBlocked));
    saveButton.textContent = state.pendingSave?.receipt ? "저장 상태 다시 확인"
      : state.pendingSave ? "같은 저장 요청 다시 시도" : "검수한 마스터 저장";
    saveButton.title = !state.persistenceAvailable ? "Master 저장소를 사용할 수 없습니다."
      : !allReviewed && !pendingRetry ? "수정한 초안을 먼저 확인해 주세요." : "확인된 초안만 immutable Master로 저장합니다.";
    if (!state.persistenceAvailable) saveStatus.textContent = state.storageError
      ? `Master 저장소를 사용할 수 없습니다: ${state.storageError}` : "Master 저장소를 사용할 수 없습니다.";
    else if (changed.some((draft) => draft.status === "DRAFT_EDITED")) saveStatus.textContent = "수정한 초안을 먼저 확인해 주세요.";
    exportButton.disabled = !state.persistenceAvailable || !state.activeRegistryVersion;
    activeLabel.textContent = state.activeRegistryVersion
      ? `현재 저장된 Master · revision ${state.storeRevision} · ${state.activeRegistryVersion} · entity ${state.bundle?.entities.length ?? 0}개 · 미해결 ${state.bundle?.unresolvedLegacyNames.length ?? 0}개`
      : state.persistenceAvailable ? `아직 저장된 curated Master가 없습니다 · revision ${state.storeRevision ?? 0} · legacy 미리보기 사용 중`
        : "저장된 Master를 확인할 수 없습니다 · legacy 미리보기는 읽을 수 있지만 저장은 비활성입니다.";
    if (storageNote) storageNote.textContent = state.persistenceAvailable
      ? "저장 시 owner 확인한 초안만 새 immutable Master version으로 기록됩니다. 인식과 현재 회차에는 적용되지 않습니다."
      : "Master 저장소를 사용할 수 없습니다. legacy 미리보기만 표시하며 저장은 비활성입니다.";
    dialog.querySelector('[data-master-summary="saved"]')?.parentElement?.querySelector("span")
      ?.replaceChildren(document.createTextNode("저장된 entity"));
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

    let resolutionMode;
    let linkTarget;
    if (!item.entity) {
      resolutionMode = element("select");
      resolutionMode.setAttribute("aria-label", "저장 연결 방식 초안");
      for (const [value, label] of [["NEW_ENTITY", "새 항목으로 저장"], ["LINK_EXISTING", "기존 항목에 연결"]]) {
        const option = element("option", "", label); option.value = value; resolutionMode.append(option);
      }
      resolutionMode.value = draft.resolutionMode;
      fields.append(labelField("저장할 identity 방식", resolutionMode, { hint: "문자열 유사도로 자동 연결하지 않습니다." }));
      linkTarget = element("select");
      linkTarget.setAttribute("aria-label", "연결할 기존 entity 초안");
      const blank = element("option", "", "연결할 기존 entity를 직접 선택"); blank.value = ""; linkTarget.append(blank);
      const compatible = state.bundle.entities.filter((entity) => {
        if (entity.kind !== item.kind) return false;
        if (item.legacyKind === "MASTER_ITEM") return entity.tier === item.tier;
        if (item.legacyKind === "SPECIAL_ITEM") return entity.category === SPECIAL_CATEGORY;
        return true;
      });
      for (const entity of compatible) {
        const option = element("option", "", `${entity.canonicalName ?? "이름 미지정"} · ${entity.tier ? `Tier ${entity.tier} · ` : ""}${entity.stableId}`);
        option.value = entity.stableId; linkTarget.append(option);
      }
      linkTarget.value = draft.linkStableId;
      linkTarget.hidden = draft.resolutionMode !== "LINK_EXISTING";
      fields.append(labelField("기존 entity 선택", linkTarget, { hint: compatible.length ? "종류·tier/category 호환 대상만 표시합니다." : "호환되는 기존 entity가 없습니다." }));
    }

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
      if (state.pendingSave) return;
      draftRecord.value[key] = value;
      draftRecord.status = sameDraft(draftRecord.value, draftRecord.baseline) ? "UNTOUCHED" : "DRAFT_EDITED";
      validation.textContent = verifiedDraftProblem(item, draftRecord.value);
      reviewButton.disabled = Boolean(validation.textContent);
      reviewState.textContent = draftRecord.status === "DRAFT_EDITED" ? "수정 중" : "미검토";
      reviewState.dataset.state = draftRecord.status;
      reviewButton.textContent = "이 초안을 확인했습니다";
      updateUnsaved();
      updateList();
      updateSaveState();
    }

    const bindInput = (node, key, convert = (value) => value) => node.addEventListener("input", () => updateDraft(key, convert(node.value)));
    bindInput(canonical, "canonicalName");
    bindInput(displayName, "displayName");
    bindInput(tierSelect, "tier");
    bindInput(categoryControl, "category");
    bindInput(statusSelect, "targetStatus");
    bindInput(note, "ownerNote");
    resolutionMode?.addEventListener("change", () => {
      updateDraft("resolutionMode", resolutionMode.value);
      linkTarget.hidden = resolutionMode.value !== "LINK_EXISTING";
    });
    linkTarget?.addEventListener("change", () => updateDraft("linkStableId", linkTarget.value));
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
      updateSaveState();
    });
    renderAliases();
    validation.textContent = verifiedDraftProblem(item, draft);
    reviewButton.disabled = Boolean(validation.textContent);
    if (state.pendingSave || state.saveBlocked) {
      editor.querySelectorAll("input, select, textarea, button").forEach((control) => { control.disabled = true; });
    }
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
      state.loadPromise = Promise.resolve().then(productionLoader).then((loaded) => {
        const stateResult = loaded && typeof loaded === "object" && Object.hasOwn(loaded, "bundle")
          ? loaded : { bundle: loaded, persistenceAvailable: typeof productionSaver === "function" };
        const bundle = stateResult.bundle;
        const validation = validateMasterBundleV2(bundle);
        if (!validation.ok) throw new Error(`Master bundle 검증 실패: ${validation.errors.join("; ")}`);
        state.bundle = bundle;
        state.persistenceAvailable = stateResult.persistenceAvailable === true;
        state.storageError = stateResult.storageError ?? "";
        state.activeRegistryVersion = stateResult.activeRegistryVersion ?? null;
        state.storeRevision = stateResult.storeRevision ?? null;
        state.items = sourceRecords(bundle);
        setSummary(dialog, bundle, state.items);
        updateSaveState();
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

  async function saveReviewedDrafts() {
    if (state.saveInProgress || !state.persistenceAvailable || typeof productionSaver !== "function") return;
    let pending = state.pendingSave;
    if (!pending) {
      const changed = [...state.drafts.entries()].filter(([, draft]) => draft.status !== "UNTOUCHED");
      if (!changed.length || changed.some(([, draft]) => draft.status !== "DRAFT_REVIEWED_PENDING_SAVE")) {
        saveStatus.textContent = "수정한 초안을 먼저 확인해 주세요.";
        updateSaveState();
        return;
      }
      const reviewed = changed.map(([key, draft]) => {
        const item = state.items.find((entry) => entry.key === key);
        if (!item) throw new Error("검토 대상 Master 항목을 찾을 수 없습니다.");
        if (!item.entity && draft.value.resolutionMode === "LINK_EXISTING" && !draft.value.linkStableId) {
          throw new Error("기존 entity 연결을 선택한 경우 연결 대상을 지정해야 합니다.");
        }
        const problem = verifiedDraftProblem(item, draft.value);
        if (problem) throw new Error(problem);
        return { item, draft: clone(draft.value), baseline: clone(draft.baseline) };
      });
      try {
        const candidate = buildCandidate(state.bundle, reviewed);
        const result = validateMasterBundleV2(candidate);
        if (!result.ok) throw new Error(`저장 후보 검증 실패: ${result.errors.join("; ")}`);
        pending = { candidate, expectedRegistryVersion: state.activeRegistryVersion, reviewedKeys: reviewed.map(({ item }) => item.legacyNameKey ?? item.stableId) };
        state.pendingSave = pending;
      } catch (error) {
        saveStatus.textContent = error?.message ?? "저장 후보를 만들 수 없습니다.";
        return;
      }
    }
    state.saveInProgress = true;
    saveStatus.textContent = pending.receipt ? "저장 상태를 다시 확인하고 있습니다." : "검토 초안을 저장하고 확인하는 중입니다.";
    updateSaveState();
    try {
      const result = await productionSaver(pending.candidate, pending.expectedRegistryVersion, pending);
      const { bundle, activeRegistryVersion, storeRevision, receipt } = result ?? {};
      const validation = validateMasterBundleV2(bundle);
      if (!validation.ok || activeRegistryVersion !== receipt?.registryVersion || bundle.contentHash !== receipt?.contentHash) {
        throw Object.assign(new Error("저장 응답을 받았지만 최종 확인에 실패했습니다."), { readbackOnly: true });
      }
      const oldItem = state.items.find((entry) => entry.key === state.selectedKey);
      const resolvedEntity = oldItem?.legacyNameKey
        ? bundle.entities.find((entity) => entity.legacyNames.some((record) => record.legacyNameKey === oldItem.legacyNameKey))
        : null;
      state.bundle = bundle;
      state.activeRegistryVersion = activeRegistryVersion;
      state.storeRevision = storeRevision;
      state.items = sourceRecords(bundle);
      state.selectedKey = resolvedEntity
        ? state.items.find((item) => item.stableId === resolvedEntity.stableId && item.legacyNameKey === oldItem.legacyNameKey)?.key
        : state.selectedKey;
      if (!state.items.some((item) => item.key === state.selectedKey)) state.selectedKey = state.items[0]?.key ?? null;
      state.drafts.clear();
      state.pendingSave = null;
      state.saveBlocked = false;
      setSummary(dialog, bundle, state.items);
      updateUnsaved();
      updateList();
      const selected = state.items.find((item) => item.key === state.selectedKey);
      if (selected) renderEditor(selected);
      saveStatus.textContent = `저장 완료 · revision ${storeRevision} · ${activeRegistryVersion}`;
      updateSaveState();
    } catch (error) {
      const stale = error?.code === "master_revision_conflict" || error?.code === "master_mutation_conflict";
      state.saveBlocked = stale;
      if (error?.networkAmbiguous || error?.readbackOnly || error?.retryable) {
        saveStatus.textContent = error?.readbackOnly
          ? "저장 응답을 받았지만 최종 확인에 실패했습니다. 버튼을 눌러 저장 상태만 다시 확인하세요."
          : "저장 응답이 불확실합니다. 같은 저장 요청으로 다시 시도하세요.";
      } else {
        if (!state.pendingSave?.receipt && !state.pendingSave?.mutationId) state.pendingSave = null;
        saveStatus.textContent = error?.message ?? "Master 저장에 실패했습니다.";
      }
      const selected = state.items.find((item) => item.key === state.selectedKey);
      if (selected) renderEditor(selected);
      updateSaveState();
    } finally {
      state.saveInProgress = false;
      updateSaveState();
    }
  }

  openButton?.addEventListener("click", open);
  dialog.querySelectorAll("[data-master-close]").forEach((button) => button.addEventListener("click", close));
  search?.addEventListener("input", updateList);
  saveButton?.addEventListener("click", () => { void saveReviewedDrafts(); });
  exportButton.addEventListener("click", () => {
    if (!state.activeRegistryVersion || exportButton.disabled) return;
    const anchor = element("a");
    anchor.href = `/api/master/bundles/${encodeURIComponent(state.activeRegistryVersion)}/export`;
    anchor.download = `master-${state.activeRegistryVersion.replaceAll(":", "-")}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  });
  dialog.querySelectorAll("[data-master-filter]").forEach((button) => button.addEventListener("click", () => {
    state.filter = button.dataset.masterFilter;
    dialog.querySelectorAll("[data-master-filter]").forEach((candidate) => candidate.setAttribute("aria-pressed", String(candidate === button)));
    updateList();
  }));

  return Object.freeze({ open, close });
}
