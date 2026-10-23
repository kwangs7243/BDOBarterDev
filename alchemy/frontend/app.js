import { api } from "./api.js";
const $ = (s, root = document) => root.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmt = (v) =>
  v == null
    ? "미확인"
    : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const qty = (v) => {
  if (!/^\d+$/.test(String(v)) || Number(v) > 1e9)
    throw Error("수량은 0~10억 사이 정수로 입력하세요.");
  return Number(v);
};
const labels = {
  unknown: "재고 확인 필요",
  supplied: "확보",
  ready: "제작 가능",
  short: "재료 부족",
  unverified: "검증 필요",
  in_progress: "제작 중",
};
const badge = (s) =>
  `<span class="badge ${esc(s)}">${esc(labels[s] ?? s)}</span>`;
const link = (id, g) =>
  "/alchemy/recipes/" +
  encodeURIComponent(id) +
  (g ? "?goal=" + encodeURIComponent(g) : "");
const date = (v) =>
  v ? new Date(v).toLocaleString("ko-KR") : "확인 이력 없음";
const names = new Map(),
  icons = new Map(),
  cache = new Map(),
  dirty = new Set();
let state,
  catalog,
  plans = [],
  goal = null,
  detail = null,
  jobDetail = null,
  rows = [],
  offset = 0,
  query = "",
  preferencesLoaded = false,
  job,
  backup,
  fullCatalog,
  pending = null,
  busy = false;
const page = location.pathname.includes("/recipes/")
  ? "detail"
  : (["inventory", "history", "settings"].find((p) =>
      location.pathname.endsWith("/" + p),
    ) ?? "dashboard");
const name = (id) => names.get(id) ?? id;
function remember(items) {
  for (const i of Array.isArray(items) ? items : Object.values(items)) {
    names.set(i.item_id, i.name);
    if (/^icons\/[A-Za-z0-9_-]{1,100}\.(?:png|webp)$/.test(i.icon ?? ""))
      icons.set(i.item_id, i.icon);
  }
}
const icon = (id, large = false) =>
  icons.has(id)
    ? `<img class="item-icon${large ? " large" : ""}" src="/alchemy/assets/${esc(icons.get(id))}" width="${large ? 44 : 28}" height="${large ? 44 : 28}" alt="" loading="lazy" decoding="async">`
    : "";
function status(text, kind = "info") {
  $("#status").textContent = text;
  $("#status").dataset.kind = kind;
}
const report = (error) => status(error.message, "error");
function hasDraft() {
  for (const f of dirty) if (!f.isConnected) dirty.delete(f);
  return dirty.size > 0;
}
function leave() {
  return (
    !hasDraft() || confirm("저장하지 않은 입력이 있습니다. 변경을 버릴까요?")
  );
}
function guard() {
  if (hasDraft()) {
    status(
      "입력 중인 내용을 먼저 저장하거나 새로 불러오기로 취소하세요.",
      "error",
    );
    return false;
  }
  return true;
}
async function recipe(id) {
  if (cache.has(id)) return cache.get(id);
  const result = await api("/recipes/" + encodeURIComponent(id));
  remember(result.items);
  cache.set(id, result);
  if (cache.size > 32) cache.delete(cache.keys().next().value);
  return result;
}
async function load() {
  $("#content").setAttribute("aria-busy", "true");
  [state, catalog] = await Promise.all([api("/state"), api("/catalog")]);
  remember(catalog.products);
  if (!preferencesLoaded) {
    query = state.settings.inventory_filter ?? "";
    preferencesLoaded = true;
  }
  if (["dashboard", "detail"].includes(page))
    plans = (await api("/plans")).plans;
  $("#page-title").textContent = {
    dashboard: "제작 대시보드",
    detail: "제작 대상 상세",
    inventory: "공통 재고",
    history: "제작·재고 기록",
    settings: "데이터·백업",
  }[page];
  $(`nav [data-nav=${page === "detail" ? "dashboard" : page}]`)?.setAttribute(
    "aria-current",
    "page",
  );
  $("#data-version").textContent =
    `RECIPE ${catalog.version} · 저장 버전 ${state.revision}`;
  if (page === "dashboard") dashboard();
  if (page === "detail") await renderDetail();
  if (page === "inventory") await inventory();
  if (page === "history") await history();
  if (page === "settings") settings();
  $("#content").setAttribute("aria-busy", "false");
  status("저장 상태를 확인했습니다. 미확인 재고는 0개와 구분합니다.");
}
async function save(action, fields, form) {
  if (busy) return;
  for (const f of dirty)
    if (f.isConnected && f !== form)
      throw Error(
        "다른 입력 내용이 남아 있습니다. 먼저 저장하거나 취소하세요.",
      );
  const signature = JSON.stringify({ action, fields });
  if (pending && pending.signature !== signature)
    throw Error("이전 저장 결과를 먼저 재확인하세요.");
  pending ??= {
    signature,
    action,
    body: {
      ...fields,
      mutationId: crypto.randomUUID(),
      baseRevision: state.revision,
    },
  };
  busy = true;
  document
    .querySelectorAll("button[type=submit]")
    .forEach((b) => (b.disabled = true));
  status("트랜잭션을 저장하는 중입니다.");
  try {
    const result = await api("/mutations/" + action, pending.body);
    pending = null;
    $("#retry-area").hidden = true;
    if (form) dirty.delete(form);
    cache.clear();
    fullCatalog = null;
    $("#work-dialog").close();
    await load();
    status("저장을 확인했습니다. 제작 계획을 다시 계산했습니다.", "success");
    if (result.previous_backup_id) {
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = " · 복원 전 백업 내려받기";
      a.onclick = (event) => {
        event.preventDefault();
        download(
          "/backup?id=" + encodeURIComponent(result.previous_backup_id),
          "BDO-alchemy-before-restore.json",
        ).catch(report);
      };
      $("#status").append(a);
    }
    return result;
  } catch (error) {
    if (error.uncertain) {
      $("#retry-area").hidden = false;
      status(
        "저장 응답을 받지 못했습니다. 같은 트랜잭션으로 결과를 재확인하세요.",
        "error",
      );
    } else {
      pending = null;
      $("#retry-area").hidden = true;
      if (error.status === 409) state = await api("/state");
      report(error);
    }
    throw error;
  } finally {
    busy = false;
    document
      .querySelectorAll("button[type=submit]")
      .forEach((b) => (b.disabled = false));
  }
}
function goalForm(id) {
  return `<form id="goal-form" data-protect><div class="form-row"><label class="wide">제작 대상<select name="item_id">${id ? `<option value="${esc(id)}">${esc(name(id))}</option>` : catalog.products.map((i) => `<option value="${i.item_id}">${esc(i.name)}</option>`).join("")}</select></label><label>목표 수량<input type="number" min="1" max="1000000000" name="quantity" value="${goal?.quantity ?? 100}" required></label><label>목표 기준<select name="mode"><option value="held">최종 보유량</option><option value="additional" ${goal?.mode === "additional" ? "selected" : ""}>현재 보유량에 추가 제작</option></select></label><label>우선순위 · 작은 수 먼저<input type="number" min="0" name="priority" value="${goal?.priority ?? state.goals.length}" required></label><button type="submit" class="primary">${goal ? "목표 저장" : "목표 등록"}</button></div><p class="hint">계획은 실제 재고를 변경하지 않습니다. 활성 목표는 우선순위대로 공통 재고를 예약합니다.</p></form>`;
}
function jobs() {
  return `<section class="panel"><div class="panel-heading"><h2>진행 중인 제작 ${state.jobs.length}</h2><span class="hint">재료 차감 완료 · 산출물 미반영</span></div>${state.jobs.length ? state.jobs.map((j) => `<div class="job"><div><strong>${icon(j.recipe.output_item_id)}${esc(name(j.recipe.output_item_id))}</strong><p>${fmt(j.calls)}회 · ${esc(j.recipe.method)} · ${date(j.created_at)}</p></div><div class="job-actions"><button type="button" data-finish="${j.job_id}">결과 입력</button><button type="button" class="small danger" data-cancel="${j.job_id}">미실행 취소</button></div></div>`).join("") : '<div class="empty">진행 중인 제작이 없습니다. 재료를 확인한 뒤 제작을 시작하세요.</div>'}</section>`;
}
function productCards(items) {
  return items
    .map(
      (i) =>
        `<a class="product-card" href="${link(i.item_id)}">${icon(i.item_id, true)}<div><small>${esc(i.category)}</small><strong>${esc(i.name)}</strong></div></a>`,
    )
    .join("");
}
function dashboard() {
  goal = null;
  $("#content").innerHTML =
    `<div class="intro"><div><span class="eyebrow">YOUR NEXT CREATION</span><h2>다음 제작을 준비하세요.</h2><p class="muted">보유한 재료부터 확인하고, 실제 제작 결과를 기록하세요.</p></div></div><div class="stats">${[
      ["활성 제작 목표", state.goals.filter((g) => g.active).length],
      ["제작 진행 중", state.jobs.length],
      [
        "수량을 확인한 품목",
        Object.values(state.inventory).filter((v) => v !== null).length,
      ],
      ["지원 제작식", catalog.recipe_count],
    ]
      .map(
        ([s, n]) =>
          `<div class="stat"><span>${s}</span><strong>${n}</strong></div>`,
      )
      .join(
        "",
      )}</div><section class="panel"><h2>새 제작 목표</h2>${goalForm()}</section><div class="layout-two"><section class="panel"><div class="panel-heading"><h2>나의 제작 목표</h2><span class="hint">예약은 실제 차감이 아닙니다.</span></div><div class="goals">${
      state.goals.length
        ? state.goals
            .toSorted((a, b) => a.priority - b.priority)
            .map((g) => {
              const p = plans.find((p) => p.goal_id === g.goal_id);
              return `<article class="goal-card"><div class="goal-top"><a href="${link(g.item_id, g.goal_id)}">${icon(g.item_id)}${esc(name(g.item_id))}</a><div class="actions"><span class="badge">우선 ${g.priority}</span><button class="small" type="button" data-active="${g.goal_id}">${g.active ? "계획 보류" : "계획 활성"}</button><button class="small danger" type="button" data-delete="${g.goal_id}">삭제</button></div></div><div class="goal-meta"><span>${g.mode === "additional" ? "추가 제작" : "최종 보유"} ${fmt(g.quantity)}개</span><span>배정된 최종품 ${fmt(p?.progress)}개</span><span>${p?.progress_percent == null ? "현재고 확인 필요" : fmt(p.progress_percent) + "% 확보"}</span></div><div class="progress-track"><span style="width:${Math.min(100, p?.progress_percent ?? 0)}%"></span></div></article>`;
            })
            .join("")
        : '<div class="empty">아직 제작 목표가 없습니다. 위에서 목표를 등록하세요.</div>'
    }</div></section>${jobs()}</div><section class="panel"><div class="panel-heading"><h2>제작품 카탈로그</h2><input type="search" id="catalog-search" placeholder="제작품 찾기" aria-label="제작품 찾기"></div><div class="product-grid" id="products">${productCards(catalog.products)}</div></section>`;
}
function materialTable(materials) {
  return materials.length
    ? `<div class="table-wrap"><table><thead><tr><th>재료</th><th class="num">필요</th><th class="num">재고</th><th class="num">예약</th><th class="num">부족</th><th>상태</th></tr></thead><tbody>${materials.map((r) => `<tr><td class="item-name"><a href="${link(r.item_id, goal?.goal_id)}">${icon(r.item_id)}${esc(r.name)}</a></td><td class="num">${fmt(r.need)}</td><td class="num">${fmt(r.stock)}</td><td class="num">${fmt(r.allocated)}</td><td class="num">${fmt(r.missing)}</td><td>${badge(r.status)}</td></tr>`).join("")}</tbody></table></div>`
    : '<div class="empty">표시할 재료가 없습니다.</div>';
}
function recipeCards() {
  return detail.recipes
    .map(
      (r) =>
        `<details class="recipe-option"><summary><strong>${esc(r.method)} · ${fmt(r.output_quantity)}개 기준</strong>${badge(r.verification === "verified" ? "supplied" : "unverified")}<span class="source-tag">${r.source_kind === "official" ? "공식 패치 대조" : r.source_kind === "user_checked" ? "사용자 확인" : "보조 DB 대조"} · ${esc(r.verified_at ?? "미확인")}</span></summary><ul>${r.inputs.map((i) => `<li>${icon(i.item_id)}${esc(name(i.item_id))} ${fmt(i.quantity)}개${i.alternatives?.length ? " · 검증된 대체 가능" : ""}</li>`).join("")}</ul><p class="hint">${r.yield_type === "fixed" ? "고정 산출" : "가변·추가 산출: 보장 산출로 계획, 실제 입력량만 재고 반영"} · 요구 단계 ${esc(r.required_skill ?? "미확인")}</p><p class="sources">${r.source_urls.map((url, i) => `<a href="${esc(/^https?:\/\//.test(url) ? url : "#")}" target="_blank" rel="noopener noreferrer">검증 출처 ${i + 1} ↗</a>`).join("")}</p><div class="actions">${goal ? `<button type="button" data-select-recipe="${r.recipe_id}">이 경로로 계획</button>` : ""}<button type="button" data-start="${r.output_item_id}" data-recipe="${r.recipe_id}" ${r.verification !== "verified" || detail.errors.some((v) => v.recipe_id === r.recipe_id) ? "disabled" : ""}>제작 시작 미리보기</button></div></details>`,
    )
    .join("");
}
async function renderDetail() {
  const id = decodeURIComponent(location.pathname.split("/recipes/")[1]);
  detail = await recipe(id);
  goal =
    state.goals.find(
      (g) => g.goal_id === new URLSearchParams(location.search).get("goal"),
    ) ??
    state.goals.find((g) => g.item_id === id) ??
    null;
  const nested = goal && goal.item_id !== id;
  const p = goal ? plans.find((p) => p.goal_id === goal.goal_id) : null;
  remember(p?.rows ?? []);
  $("#page-title").textContent = name(id);
  $("#content").innerHTML =
    `<div class="intro"><div><span class="eyebrow">RECIPE & PRODUCTION</span><h2>${icon(id, true)}${esc(name(id))}</h2><p class="muted">현재 재고 ${fmt(state.inventory[id])}개 · ${esc(detail.item.acquisition)}</p></div><a href="/alchemy/">목표 목록으로</a></div><section class="panel"><h2>${goal ? "제작 목표" : "이 품목의 목표 만들기"}</h2>${nested ? `<p class="hint">이 단계는 <a href="${link(goal.item_id, goal.goal_id)}">${esc(name(goal.item_id))} 목표</a>에 속합니다. 아래에서 선택한 경로와 수율을 해당 목표에 저장합니다.</p>` : goalForm(id)}${goal ? `<div class="filter-row"><label><input id="assume-zero" type="checkbox" ${goal.assume_unknown_zero ? "checked" : ""}> 미확인을 0으로 가정하여 계획만 계산</label><span class="hint">확정 재고로 저장하거나 차감하지 않습니다.</span></div>` : ""}</section><div class="layout-two"><section class="panel"><div class="panel-heading"><h2>단계별 제작 계획</h2><span class="hint">공유 재료는 전체 합산 수량입니다.</span></div>${p ? `<div class="plan-summary"><div><strong>${fmt(p.progress_percent)}${p.progress_percent == null ? "" : "%"}</strong><span>배정된 실제 최종품 달성률</span></div><div><strong>${fmt(p.progress)} / ${fmt(p.target)}</strong><span>중간재·예상 산출 제외</span></div><div><strong>${Object.keys(p.reservations).length}</strong><span>공통 재고 예약 품목</span></div></div>${p.errors.map((s) => `<p class="error-note">${esc(s)}</p>`).join("")}<div class="filter-row"><select id="plan-filter" aria-label="제작 단계 표시"><option value="all">전체 단계</option><option value="short">부족·미확인만</option><option value="ready">제작 가능한 단계</option><option value="base">최하위 재료만</option></select><input id="plan-search" type="search" placeholder="단계 이름 찾기" aria-label="단계 이름 찾기"></div><div id="plan-tree"></div>` : '<div class="empty">목표를 등록하면 보유 중간재를 반영한 계획을 보여줍니다.</div>'}</section><div><section class="panel"><h2>제작 경로 비교</h2><p class="hint">10개·100개식은 촉매제와 예외 수량이 다른 별도 제작식입니다.</p>${detail.recipes.length ? recipeCards() : `<p class="callout">외부 수급 품목 · ${esc(detail.item.acquisition)}</p>`}${
      goal && detail.recipes.some((r) => r.yield_type !== "fixed")
        ? `<form id="yield-form" data-protect><div class="form-row"><label class="wide">예상 수율 대상<select name="recipe_id">${detail.recipes
            .filter((r) => r.yield_type !== "fixed")
            .map(
              (r) =>
                `<option value="${r.recipe_id}">${esc(r.method)} · 최소 ${r.output_quantity}개</option>`,
            )
            .join(
              "",
            )}</select></label><label>1회 기대 산출<input type="number" name="expected" step="0.01" min="1" placeholder="빈칸: 보장량"></label><button type="submit">계획 수율 저장</button></div><p class="hint">기대 수율은 실제 산출이나 재고로 저장되지 않습니다.</p></form>`
        : ""
    }</section>${jobs()}</div></div>${p ? `<section class="panel"><div class="panel-heading"><h2>통합 부족 재료</h2><button type="button" id="copy-shortages">부족 목록 복사</button></div><p class="hint">미확인 중간재 아래의 요구량은 확인 전 확정하지 않습니다.</p>${materialTable(p.rows.filter((r) => !r.recipe_id && (r.missing !== 0 || r.unknown)))}</section>` : ""}`;
  if (p) {
    $("#plan-filter").value = ["all", "short", "ready", "base"].includes(
      state.settings.tree_filter,
    )
      ? state.settings.tree_filter
      : "all";
    tree(p);
  }
}
function tree(p) {
  const filter = $("#plan-filter").value,
    q = $("#plan-search").value;
  const filtered = p.rows.filter(
    (r) =>
      r.name.includes(q) &&
      (filter === "all" ||
        (filter === "short" && (r.missing !== 0 || r.unknown)) ||
        (filter === "ready" && r.ready) ||
        (filter === "base" && !r.recipe_id)),
  );
  if (filter !== "all" || q) {
    $("#plan-tree").innerHTML =
      materialTable(filtered) +
      filtered
        .filter((r) => r.calls)
        .map(
          (r) =>
            `<div class="tree-actions"><span>${esc(r.name)} · ${fmt(r.calls)}회 / 예상 ${fmt(r.planned_output)}개</span><button class="small" type="button" data-start="${r.item_id}" data-recipe="${r.recipe_id}" data-calls="${r.calls}">제작 미리보기</button></div>`,
        )
        .join("");
    return;
  }
  const byId = new Map(p.rows.map((r) => [r.item_id, r]));
  const node = (r) =>
    `<details class="tree-node" data-tree="${r.item_id}"><summary><strong>${icon(r.item_id)}${esc(r.name)}</strong>${badge(r.status)}<span class="counts">필요 ${fmt(r.need)} · 보유 ${fmt(r.stock)} · 부족 ${fmt(r.missing)}${r.calls ? " · " + fmt(r.calls) + "회" : ""}</span></summary><div class="branch-slot"></div></details>`;
  $("#plan-tree").innerHTML = p.rows[0]
    ? node(p.rows[0])
    : '<div class="empty">보류한 목표입니다.</div>';
  $("#plan-tree").addEventListener(
    "toggle",
    (event) => {
      const d = event.target;
      if (!d.open || !d.matches("[data-tree]") || d.dataset.rendered) return;
      d.dataset.rendered = "1";
      const r = byId.get(d.dataset.tree);
      $(".branch-slot", d).innerHTML =
        `<div class="tree-actions"><a href="${link(r.item_id, goal?.goal_id)}">제작식·수급 보기 ↗</a>${r.recipe_id ? `<button type="button" class="small" data-start="${r.item_id}" data-recipe="${r.recipe_id}" data-calls="${r.calls ?? 1}">제작 미리보기</button>` : ""}</div>${r.calls ? `<p class="hint">계획 산출 ${fmt(r.planned_output)}개 · 초과 ${fmt(r.surplus)}개${r.estimate ? " · 기대 수율 기준" : ""}</p>` : ""}${r.inputs.map((v) => (byId.has(v.item_id) ? node(byId.get(v.item_id)) : "")).join("")}`;
    },
    { capture: true },
  );
  const first = $("[data-tree]");
  if (first) first.open = true;
}

async function inventory() {
  const data = await api(
    `/items?q=${encodeURIComponent(query)}&offset=${offset}&limit=50`,
  );
  rows = data.items;
  remember(rows);
  $("#content").innerHTML =
    `<div class="intro"><div><span class="eyebrow">ONE SHARED INVENTORY</span><h2>모든 제작이 함께 쓰는 재고</h2><p class="muted">빈칸은 미확인, 0은 확인한 0개입니다. 계획 필요량은 여기에 저장되지 않습니다.</p></div></div><section class="panel"><form id="inventory-search"><div class="form-row"><label class="wide">아이템 검색<input type="search" name="q" value="${esc(query)}" placeholder="예: 맑은 액체 시약"></label><button type="submit">검색</button></div></form><form id="inventory-form" data-protect><div class="table-wrap"><table><thead><tr><th>품목</th><th>실제 재고</th><th>확인 시각</th><th>수급·사용</th></tr></thead><tbody>${rows.map((i) => `<tr><td class="item-name"><a href="${link(i.item_id)}">${icon(i.item_id)}${esc(i.name)}</a><div class="hint">${esc(i.acquisition)}</div></td><td><input type="number" min="0" max="1000000000" value="${i.quantity ?? ""}" data-stock="${i.item_id}" aria-label="${esc(i.name)} 실제 재고" placeholder="미확인"></td><td class="hint">${date(i.checked_at)}</td><td><button class="small" type="button" data-adjust="${i.item_id}">수급·사용</button></td></tr>`).join("")}</tbody></table></div><div class="table-actions"><button class="primary" type="submit">변경한 재고 저장</button><span class="hint">${data.total ? offset + 1 : 0}–${Math.min(offset + 50, data.total)} / ${data.total}종</span><div class="actions"><button type="button" data-page="-1" ${offset === 0 ? "disabled" : ""}>이전</button><button type="button" data-page="1" ${offset + 50 >= data.total ? "disabled" : ""}>다음</button></div></div></form></section><section class="panel"><h2>여러 품목 일괄 등록</h2><form id="bulk-form" data-protect><label for="bulk-text" class="hint">한 줄에 품목명과 수량을 탭 또는 = 로 구분하세요. 중복·모호한 품목은 적용하지 않습니다.</label><textarea id="bulk-text" name="text" placeholder="맑은 액체 시약 = 500&#10;순수한 가루 시약 = 200" required></textarea><button type="submit">일괄 입력 미리보기</button></form></section>`;
}
async function history() {
  const [data, all] = await Promise.all([
    api("/history?offset=" + offset),
    api("/items?limit=200"),
  ]);
  remember(all.items);
  const actionNames = {
    inventory: "재고 변경",
    goal: "목표 변경",
    start: "제작 시작",
    finish: "제작 완료",
    cancel: "제작 취소",
    correct: "결과 정정",
    restore: "백업 복원",
    settings: "설정 변경",
    catalog: "레시피 변경",
  };
  $("#content").innerHTML =
    `<div class="intro"><div><span class="eyebrow">PRODUCTION LEDGER</span><h2>모든 변화의 기록</h2><p class="muted">재고 증감과 제작 작업을 트랜잭션 단위로 기록합니다.</p></div></div><section class="panel"><h2>제작·재고 원장</h2>${
      data.events.length
        ? data.events
            .map((v) => {
              const j = v.result.job;
              return `<details class="history-event"><summary><span class="badge">${actionNames[v.action] ?? esc(v.action)}</span><span>${j ? esc(name(j.recipe.output_item_id)) + " · " + fmt(j.executed_calls ?? j.calls) + "회" : v.result.goal ? esc(name(v.result.goal.item_id)) : v.result.changed_items ? fmt(v.result.changed_items.length) + "개 품목" : ""}</span><time>${date(v.at)}</time></summary><p class="hint">거래 ID ${esc(v.transaction_id)}</p>${
                j
                  ? `<p class="hint">시작 시 입력: ${j.inputs_per_call.map((i) => esc(name(i.item_id)) + " × " + fmt(i.quantity * j.calls)).join(" / ")}</p><p class="hint">실제 산출: ${
                      Object.entries(j.outputs)
                        .map(([id, q]) => esc(name(id)) + " " + fmt(q))
                        .join(" / ") || "미등록"
                    }</p>${j.status === "completed" ? `<button type="button" class="small" data-correct="${j.job_id}">결과 정정 기록</button>` : ""}`
                  : ""
              }<p class="hint">${esc(v.result.reason ?? "")}</p><details><summary class="hint">거래 상세</summary><pre>${esc(JSON.stringify(v, null, 2))}</pre></details></details>`;
            })
            .join("")
        : '<div class="empty">아직 제작·재고 기록이 없습니다.</div>'
    }<div class="table-actions"><span class="hint">총 ${data.total}건</span><div class="actions"><button type="button" data-page="-1" ${offset === 0 ? "disabled" : ""}>이전</button><button type="button" data-page="1" ${offset + 50 >= data.total ? "disabled" : ""}>다음</button></div></div></section>`;
}
function settings() {
  $("#content").innerHTML =
    `<div class="intro"><div><span class="eyebrow">DATA & RECOVERY</span><h2>기록을 안전하게 보관하세요.</h2><p class="muted">연금 재고·목표·진행 작업·원장을 함께 내보냅니다. 물교 데이터는 포함하지 않습니다.</p></div></div><div class="settings-grid"><section class="panel"><h2>연금 데이터 백업</h2><p class="hint">스키마 ${state.schema_version} · SQLite. 복원 전 현재 연금 상태는 별도 자동 백업됩니다.</p><button class="primary" type="button" id="export-backup">전체 데이터 내보내기</button><hr><label for="backup-file" class="hint">가져올 연금 백업 JSON</label><input type="file" id="backup-file" accept="application/json,.json"><div id="backup-preview"></div></section><section class="panel"><h2>레시피 카탈로그</h2><p>${catalog.item_count}개 품목 · ${catalog.recipe_count}개 제작식</p><p class="hint">공식 패치 대조 ${catalog.official_recipe_count}개 · 보조 DB·사용자 대조 ${catalog.recipe_count - catalog.official_recipe_count}개<br>버전 ${esc(catalog.version)}</p>${catalog.notes.map((n) => `<p class="hint">${esc(n)}</p>`).join("")}<div class="actions"><button type="button" id="export-catalog">카탈로그 내보내기</button><button type="button" id="edit-catalog">제작식 편집</button></div><p class="hint">출처와 검증 상태를 함께 관리합니다. 미검증 제작식은 자동 차감을 차단합니다.</p><label for="catalog-file" class="hint">카탈로그 JSON 가져오기</label><input type="file" id="catalog-file" accept="application/json,.json"><div id="catalog-preview"></div></section></div><section class="panel"><h2>화면 기본 설정</h2><form id="preferences-form" data-protect><div class="form-row"><label>제작 트리 기본 표시<select name="tree_filter">${Object.entries(
      {
        all: "전체 단계",
        short: "부족·미확인만",
        ready: "제작 가능한 단계",
        base: "최하위 재료만",
      },
    )
      .map(
        ([v, t]) =>
          `<option value="${v}" ${state.settings.tree_filter === v ? "selected" : ""}>${t}</option>`,
      )
      .join(
        "",
      )}</select></label><label class="wide">재고 기본 검색어<input name="inventory_filter" maxlength="1000" value="${esc(state.settings.inventory_filter ?? "")}" placeholder="빈칸: 전체 품목"></label><button type="submit">화면 설정 저장</button></div></form><p class="hint">연금 DB와 백업에 저장합니다. 미저장 입력과 제작 결과는 변경하지 않습니다.</p></section><section class="panel catalog-editor" id="catalog-editor" hidden></section>`;
}
function modal(title, html) {
  $("#dialog-title").textContent = title;
  $("#dialog-content").innerHTML = html;
  $("#work-dialog").showModal();
}
const modalButtons = (text) =>
  `<div class="dialog-actions"><button type="button" data-close>취소</button><button class="primary" type="submit">${text}</button></div>`;
async function startModal(id, rid, calls = 1) {
  if (!guard()) return;
  jobDetail = await recipe(id);
  const r =
    jobDetail.recipes.find((r) => r.recipe_id === rid) ?? jobDetail.recipes[0];
  if (!r) throw Error("제작식이 없는 외부 수급 품목입니다.");
  modal(
    name(id) + " · 제작 시작",
    `<form id="start-form" class="dialog-form" data-protect><div class="form-row"><label class="wide">제작 경로<select name="recipe_id" id="start-recipe">${jobDetail.recipes.map((v) => `<option value="${v.recipe_id}" ${v.recipe_id === r.recipe_id ? "selected" : ""}>${esc(v.method)} · ${v.output_quantity}개 단위</option>`).join("")}</select></label><label>제작 횟수<input type="number" name="calls" min="1" max="1000000000" value="${calls}" required></label></div><div id="start-ingredients"></div><div class="callout">시작하면 입력 재료만 차감합니다. 예상 산출은 재고에 넣지 않습니다. 완료 후 실제 산출량을 입력하세요.</div>${modalButtons("재료 차감하고 제작 시작")}</form>`,
  );
  startIngredients();
}
const startRecipe = () =>
  jobDetail.recipes.find((r) => r.recipe_id === $("#start-recipe").value);
function startIngredients() {
  const r = startRecipe();
  $("#start-ingredients").innerHTML =
    `<p class="hint">${esc(r.method)} · 최소 산출 ${r.output_quantity}개/회 · 요구 단계 ${esc(r.required_skill ?? "미확인")}</p><div class="table-wrap"><table><thead><tr><th>소비 재료 · 혼합 투입 없음</th><th class="num">현재 보유</th><th class="num">차감 수량</th><th>확인</th></tr></thead><tbody>${r.inputs
      .map((i) => {
        const chosen =
          goal?.substitutions?.[r.recipe_id + ":" + i.item_id] ?? i.item_id;
        return `<tr><td><span data-input-icon>${icon(chosen)}</span><select data-substitute="${i.item_id}" aria-label="${esc(name(i.item_id))} 소비 재료">${[{ item_id: i.item_id, quantity: i.quantity }, ...(i.alternatives ?? [])].map((v) => `<option value="${v.item_id}" data-quantity="${v.quantity}" ${chosen === v.item_id ? "selected" : ""}>${esc(name(v.item_id))} · 1회 ${v.quantity}개</option>`).join("")}</select></td><td class="num" data-current></td><td class="num" data-consume></td><td data-ready></td></tr>`;
      })
      .join(
        "",
      )}</tbody></table></div>${r.verification !== "verified" || jobDetail.errors.some((v) => v.recipe_id === r.recipe_id) ? '<p class="error-note">검증 필요 또는 순환 참조가 있는 제작식입니다. 제작을 시작할 수 없습니다.</p>' : ""}`;
  startPreview();
}
function startPreview() {
  const calls = qty($("#start-form [name=calls]").value);
  for (const s of document.querySelectorAll("[data-substitute]")) {
    const tr = s.closest("tr"),
      needed = Number(s.selectedOptions[0].dataset.quantity) * calls,
      current = state.inventory[s.value];
    $("[data-input-icon]", tr).innerHTML = icon(s.value);
    $("[data-current]", tr).textContent = fmt(current);
    $("[data-consume]", tr).textContent = fmt(needed);
    $("[data-ready]", tr).innerHTML = badge(
      current == null ? "unknown" : current >= needed ? "ready" : "short",
    );
  }
}
async function finishModal(id, correct = false) {
  if (!guard()) return;
  job = (await api("/jobs/" + encodeURIComponent(id))).job;
  const d = await recipe(job.recipe.output_item_id);
  remember(d.items);
  modal(
    name(job.recipe.output_item_id) +
      (correct ? " · 결과 정정" : " · 실제 제작 결과"),
    `<form id="finish-form" class="dialog-form" data-protect data-correct="${correct}"><div class="form-row"><label>실제로 수행한 횟수<input type="number" name="executed_calls" min="0" max="${job.calls}" value="${correct ? job.executed_calls : job.calls}" ${correct ? "readonly" : ""} required></label><span class="hint">시작 ${fmt(job.calls)}회 · ${correct ? "산출량만 정정합니다." : "미수행 회차의 재료는 반환합니다."}</span></div><p class="hint">일반품·상위품·부산물을 각각 입력하세요. 주 산출량은 0도 명시 입력합니다. 추가 산출의 빈칸은 추가 없음입니다.</p>${[job.recipe.output_item_id, ...(job.recipe.additional_output_ids ?? [])].map((id, i) => `<div class="output-row"><span>${icon(id)}${esc(name(id))}<small class="hint"><br>현재 재고 ${fmt(state.inventory[id])}</small></span><label>실제 산출량<input type="number" min="0" max="1000000000" value="${correct ? (job.outputs[id] ?? 0) : ""}" data-output="${id}" ${i === 0 ? "required" : ""} aria-label="${esc(name(id))} 실제 산출량"></label><label>${state.inventory[id] == null ? `제작 전 보유량 확인<input type="number" min="0" max="1000000000" data-baseline="${id}" placeholder="미확인 → 직접 확인">` : "확인된 기존 수량에 추가"}</label></div>`).join("")}${correct ? '<label>정정 사유<textarea name="reason" required></textarea></label><p class="callout">이후 작업에서 소비한 수량과 충돌하면 정정을 중단하고 원장을 유지합니다.</p>' : '<p class="callout">미확인 결과물은 0으로 간주하지 않습니다. 재고에 추가하려면 제작 전 보유량을 직접 확인해 입력하세요.</p>'}${modalButtons(correct ? "정정 기록 저장" : "실제 산출량으로 제작 완료")}</form>`,
  );
}
function adjustModal(id) {
  if (!guard()) return;
  modal(
    name(id) + " · 수급·사용",
    `<form id="adjust-form" class="dialog-form" data-protect data-item="${id}"><p class="hint">현재 실제 재고 ${fmt(state.inventory[id])}개</p><div class="form-row"><label>변경 유형<select name="kind"><option value="gather">채집·노드 수급 추가</option><option value="purchase">거래소 구매 추가</option><option value="use">게임에서 사용 차감</option><option value="adjustment">실사 절대 수량 보정</option></select></label><label>수량<input type="number" min="0" name="quantity" required></label></div><label>변경 사유<textarea name="reason" required></textarea></label>${modalButtons("재고 변경 저장")}</form>`,
  );
}
async function download(path, filename) {
  const data = await api(path),
    url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function editCatalog() {
  if (!guard()) return;
  fullCatalog = await api("/catalog?full=1");
  remember(fullCatalog.items);
  $("#catalog-editor").hidden = false;
  $("#catalog-editor").innerHTML =
    `<h2>제작식 편집</h2><label>대상 제작식<select id="edit-recipe">${fullCatalog.recipes.map((r) => `<option value="${r.recipe_id}">${esc(name(r.output_item_id))} · ${esc(r.method)} · ${r.output_quantity}개</option>`).join("")}</select></label><div id="recipe-editor"></div>`;
  recipeEditor();
}
function recipeEditor() {
  const r = fullCatalog.recipes.find(
    (v) => v.recipe_id === $("#edit-recipe").value,
  );
  $("#recipe-editor").innerHTML =
    `<form id="recipe-edit-form" data-protect><div class="form-row"><label>산출 단위<input type="number" min="1" name="output_quantity" value="${r.output_quantity}" required></label><label>산출 유형<select name="yield_type">${["fixed", "variable", "additional"].map((t) => `<option value="${t}" ${r.yield_type === t ? "selected" : ""}>${{ fixed: "고정", variable: "가변", additional: "추가 산출" }[t]}</option>`).join("")}</select></label><label>제작 방식<input name="method" value="${esc(r.method)}" required></label><label>요구 단계<input name="required_skill" value="${esc(r.required_skill ?? "")}" placeholder="미확인"></label></div><div class="table-wrap"><table><thead><tr><th>재료</th><th>1회 수량</th></tr></thead><tbody>${r.inputs.map((i) => `<tr><td>${icon(i.item_id)}${esc(name(i.item_id))}</td><td><input type="number" min="1" value="${i.quantity}" data-recipe-input="${i.item_id}" aria-label="${esc(name(i.item_id))} 제작식 수량" required></td></tr>`).join("")}</tbody></table></div><div class="form-row"><label class="wide">검증 출처 URL<input type="url" name="source" value="${esc(r.source_urls[0])}" required></label><label>검증 상태<select name="verification"><option value="review_required">검증 필요 · 제작 차단</option><option value="verified" ${r.verification === "verified" ? "selected" : ""}>직접 대조 확인 · 제작 허용</option></select></label></div><label>변경 사유<input name="reason" required></label><p class="hint">배포 원본을 덮어쓰지 않고 연금 DB에 사용자 카탈로그로 저장합니다. 변경 시 새 버전과 확인일을 남깁니다. 대체 재료가 있는 수량을 바꾸면 기존 치환은 해제됩니다.</p><button class="primary" type="submit">제작식 변경 저장</button></form>`;
}

async function submit(form) {
  const f = new FormData(form);
  if (form.id === "preferences-form") {
    await save(
      "settings",
      {
        settings: {
          tree_filter: f.get("tree_filter"),
          inventory_filter: f.get("inventory_filter"),
        },
      },
      form,
    );
    query = state.settings.inventory_filter ?? "";
  }
  if (form.id === "goal-form")
    await save(
      "goal",
      {
        ...(goal ?? {}),
        item_id: f.get("item_id"),
        quantity: qty(f.get("quantity")),
        mode: f.get("mode"),
        priority: qty(f.get("priority")),
      },
      form,
    );
  if (form.id === "inventory-search") {
    if (!guard()) return;
    query = f.get("q");
    offset = 0;
    await inventory();
  }
  if (form.id === "inventory-form") {
    const changes = [...form.querySelectorAll("[data-stock]")]
      .map((i) => ({
        item_id: i.dataset.stock,
        quantity: i.value === "" ? null : qty(i.value),
      }))
      .filter(
        (v) =>
          v.quantity !==
          (rows.find((i) => i.item_id === v.item_id)?.quantity ?? null),
      );
    if (!changes.length) {
      dirty.delete(form);
      status("변경한 수량이 없습니다.");
      return;
    }
    await save("inventory", { changes }, form);
  }
  if (form.id === "bulk-form") {
    for (const d of dirty)
      if (d.isConnected && d !== form)
        throw Error("다른 재고 입력을 먼저 저장하세요.");
    const all = (await api("/items?limit=200")).items;
    remember(all);
    const lines = f
        .get("text")
        .split(/\r?\n/)
        .filter((s) => s.trim()),
      changes = [],
      seen = new Set();
    if (lines.length > 200)
      throw Error("한 번에 최대 200개 품목까지 입력하세요.");
    for (const line of lines) {
      const parts = line.split(/\t|=/).map((v) => v.trim());
      if (parts.length !== 2) throw Error("품목명 = 수량 형식을 확인하세요.");
      const found = all.filter(
        (i) => i.name === parts[0] || i.aliases?.includes(parts[0]),
      );
      if (found.length !== 1 || seen.has(found[0].item_id))
        throw Error(parts[0] + ": 중복·미등록·모호한 이름입니다.");
      seen.add(found[0].item_id);
      changes.push({ item_id: found[0].item_id, quantity: qty(parts[1]) });
    }
    dirty.delete(form);
    modal(
      "일괄 재고 변경 미리보기",
      `<form id="bulk-apply" data-protect><div class="table-wrap"><table><thead><tr><th>품목</th><th>현재</th><th>변경 후</th></tr></thead><tbody>${changes.map((v) => `<tr><td>${icon(v.item_id)}${esc(name(v.item_id))}</td><td>${fmt(state.inventory[v.item_id])}</td><td>${fmt(v.quantity)}</td></tr>`).join("")}</tbody></table></div><p class="callout">${changes.length}개 품목의 절대 수량을 저장합니다.</p>${modalButtons("일괄 적용")}</form>`,
    );
    $("#bulk-apply")._changes = changes;
    dirty.add($("#bulk-apply"));
  }
  if (form.id === "bulk-apply")
    await save("inventory", { changes: form._changes }, form);
  if (form.id === "start-form") {
    const r = startRecipe(),
      substitutions = { ...(goal?.substitutions ?? {}) };
    for (const s of form.querySelectorAll("[data-substitute]"))
      substitutions[r.recipe_id + ":" + s.dataset.substitute] = s.value;
    await save(
      "start",
      {
        recipe_id: r.recipe_id,
        calls: qty(f.get("calls")),
        goal_id: goal?.goal_id ?? null,
        choices: goal?.choices ?? {},
        substitutions,
      },
      form,
    );
  }
  if (form.id === "finish-form") {
    const outputs = {},
      baseline_counts = {};
    for (const i of form.querySelectorAll("[data-output]"))
      if (i.value !== "") outputs[i.dataset.output] = qty(i.value);
    for (const i of form.querySelectorAll("[data-baseline]"))
      if (i.value !== "") baseline_counts[i.dataset.baseline] = qty(i.value);
    await save(
      form.dataset.correct === "true" ? "correct" : "finish",
      {
        job_id: job.job_id,
        outputs,
        baseline_counts,
        executed_calls: qty(f.get("executed_calls")),
        reason: f.get("reason") ?? "",
      },
      form,
    );
  }
  if (form.id === "adjust-form")
    await save(
      "inventory",
      {
        changes: [
          {
            item_id: form.dataset.item,
            kind: f.get("kind"),
            quantity: qty(f.get("quantity")),
          },
        ],
        reason: f.get("reason"),
      },
      form,
    );
  if (form.id === "yield-form") {
    const expected_yields = { ...goal.expected_yields },
      id = f.get("recipe_id");
    if (f.get("expected") === "") delete expected_yields[id];
    else expected_yields[id] = Number(f.get("expected"));
    await save("goal", { ...goal, expected_yields }, form);
  }
  if (form.id === "recipe-edit-form") {
    const data = structuredClone(fullCatalog),
      r = data.recipes.find((r) => r.recipe_id === $("#edit-recipe").value);
    Object.assign(r, {
      output_quantity: qty(f.get("output_quantity")),
      yield_type: f.get("yield_type"),
      method: f.get("method"),
      required_skill: f.get("required_skill") || null,
      verification: f.get("verification"),
      source_urls: [f.get("source")],
      source_kind: "user_checked",
      verified_at:
        f.get("verification") === "verified"
          ? new Date().toISOString().slice(0, 10)
          : null,
      verification_note: "사용자 확인: " + f.get("reason"),
    });
    for (const i of form.querySelectorAll("[data-recipe-input]")) {
      const input = r.inputs.find((v) => v.item_id === i.dataset.recipeInput);
      if (input.quantity !== qty(i.value)) delete input.alternatives;
      input.quantity = qty(i.value);
    }
    data.version = catalog.version + "+user-" + Date.now();
    r.data_version = data.version;
    const check = await api("/catalog/preview", data);
    if (check.errors.length) throw Error(check.errors.join(" / "));
    await save("catalog", { catalog: data }, form);
  }
}
document.addEventListener("submit", (event) => {
  event.preventDefault();
  submit(event.target).catch(report);
});
document.addEventListener("input", (event) => {
  const f = event.target.closest("form[data-protect]");
  if (f) dirty.add(f);
  if (event.target.id === "catalog-search")
    $("#products").innerHTML = productCards(
      catalog.products.filter((i) => i.name.includes(event.target.value)),
    );
  if (event.target.id === "plan-search")
    tree(plans.find((p) => p.goal_id === goal.goal_id));
  if (event.target.closest("#start-form") && event.target.name === "calls") {
    try {
      startPreview();
    } catch (error) {
      report(error);
    }
  }
});
document.addEventListener("change", async (event) => {
  try {
    const i = event.target,
      form = i.closest("form[data-protect]");
    if (form) dirty.add(form);
    if (i.id === "plan-filter")
      tree(plans.find((p) => p.goal_id === goal.goal_id));
    if (i.id === "assume-zero") {
      if (guard())
        await save("goal", { ...goal, assume_unknown_zero: i.checked });
    }
    if (i.id === "start-recipe") startIngredients();
    if (i.matches("[data-substitute]")) startPreview();
    if (i.id === "edit-recipe" && guard()) recipeEditor();
    if (i.id === "backup-file" && i.files[0] && guard()) {
      backup = JSON.parse(await i.files[0].text());
      const result = await api("/backup/preview", backup);
      $("#backup-preview").innerHTML =
        `<pre class="backup-preview">검증 완료: ${result.items}개 품목 / ${result.goals}개 목표 / ${result.jobs}개 작업\n데이터 ${esc(result.data_version)}</pre><p class="callout">현재 연금 데이터를 교체합니다. 복원 전 상태는 자동 백업합니다.</p><button type="button" class="danger" id="restore-backup">확인한 백업으로 복원</button>`;
    }
    if (i.id === "catalog-file" && i.files[0] && guard()) {
      fullCatalog = JSON.parse(await i.files[0].text());
      const result = await api("/catalog/preview", fullCatalog);
      $("#catalog-preview").innerHTML =
        `<p class="hint">${result.items}개 품목 / ${result.recipes}개 제작식 · ${esc(result.version)}</p>${result.errors.map((s) => `<p class="error-note">${esc(s)}</p>`).join("")}<button id="import-catalog" type="button" ${result.errors.length ? "disabled" : ""}>확인한 카탈로그 적용</button>`;
    }
  } catch (error) {
    report(error);
  }
});
document.addEventListener("click", async (event) => {
  const a = event.target.closest("a[href]");
  if (
    a &&
    !a.getAttribute("href").startsWith("#") &&
    a.target !== "_blank" &&
    hasDraft()
  ) {
    if (!leave()) {
      event.preventDefault();
      return;
    }
    dirty.clear();
  }
  const b = event.target.closest("button");
  if (!b || b.type === "submit") return;
  try {
    if (b.matches("[data-close]") || b.id === "close-dialog") {
      if (leave()) {
        dirty.clear();
        $("#work-dialog").close();
      }
      return;
    }
    if (b.id === "refresh") {
      if (leave() && !pending) {
        dirty.clear();
        cache.clear();
        await load();
      }
      return;
    }
    if (b.id === "retry" && pending) {
      const task = pending;
      await save(task.action, JSON.parse(task.signature).fields, [...dirty][0]);
      return;
    }
    if (b.dataset.start) {
      await startModal(
        b.dataset.start,
        b.dataset.recipe,
        Number(b.dataset.calls ?? 1),
      );
      return;
    }
    if (b.dataset.finish) {
      await finishModal(b.dataset.finish);
      return;
    }
    if (b.dataset.correct) {
      await finishModal(b.dataset.correct, true);
      return;
    }
    if (b.dataset.cancel) {
      if (
        guard() &&
        confirm(
          "실제 제작을 전혀 진행하지 않았나요? 차감한 재료를 전부 반환합니다. 일부 제작했다면 결과 입력에서 수행 횟수를 입력하세요.",
        )
      )
        await save("cancel", { job_id: b.dataset.cancel });
      return;
    }
    if (b.dataset.adjust) {
      adjustModal(b.dataset.adjust);
      return;
    }
    if (b.dataset.delete) {
      if (
        guard() &&
        confirm("목표를 삭제할까요? 실제 재고와 제작 기록은 유지합니다.")
      )
        await save("goal", { goal_id: b.dataset.delete, delete: true });
      return;
    }
    if (b.dataset.active) {
      if (!guard()) return;
      const g = state.goals.find((g) => g.goal_id === b.dataset.active);
      await save("goal", { ...g, active: !g.active });
      return;
    }
    if (b.dataset.selectRecipe) {
      if (guard()) {
        const r = detail.recipes.find(
          (r) => r.recipe_id === b.dataset.selectRecipe,
        );
        await save("goal", {
          ...goal,
          choices: { ...goal.choices, [r.output_item_id]: r.recipe_id },
        });
      }
      return;
    }
    if (b.dataset.page) {
      if (!guard()) return;
      offset = Math.max(0, offset + 50 * Number(b.dataset.page));
      if (page === "inventory") await inventory();
      else await history();
      return;
    }
    if (b.id === "copy-shortages") {
      const materials = plans
        .find((p) => p.goal_id === goal.goal_id)
        .rows.filter((r) => !r.recipe_id && (r.missing !== 0 || r.unknown));
      await navigator.clipboard.writeText(
        materials
          .map(
            (r) =>
              r.name +
              "\t" +
              (r.missing == null ? "재고 확인 필요" : fmt(r.missing)),
          )
          .join("\n"),
      );
      status("부족 재료를 복사했습니다.", "success");
    }
    if (b.id === "export-backup")
      await download(
        "/backup",
        "BDO-alchemy-" + new Date().toISOString().slice(0, 10) + ".json",
      );
    if (b.id === "export-catalog")
      await download("/catalog?full=1", "BDO-alchemy-catalog.json");
    if (b.id === "edit-catalog") await editCatalog();
    if (
      b.id === "restore-backup" &&
      guard() &&
      confirm("미리보기에서 확인한 연금 백업으로 복원할까요?")
    )
      await save("restore", { backup });
    if (
      b.id === "import-catalog" &&
      guard() &&
      confirm("확인한 카탈로그를 적용할까요?")
    )
      await save("catalog", { catalog: fullCatalog });
  } catch (error) {
    report(error);
  }
});
$("#work-dialog").addEventListener("cancel", (event) => {
  if (!leave()) event.preventDefault();
  else dirty.clear();
});
window.addEventListener("beforeunload", (event) => {
  if (hasDraft() || busy || pending) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    cache.clear();
    names.clear();
    icons.clear();
    state = null;
    plans = [];
    fullCatalog = null;
  }
});
load().catch((error) => {
  $("#content").setAttribute("aria-busy", "false");
  report(error);
});
