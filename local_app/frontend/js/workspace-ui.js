import { state } from './state.js';

const normalize = value => String(value ?? '').replace(/\s+/g, '').toLocaleLowerCase();
let inventoryTier = 'all';

export function applyInventoryFilters() {
  const query = normalize(document.getElementById('inventory-search')?.value);
  const mode = document.getElementById('inventory-stock-filter')?.value ?? 'all';
  const items = new Map(state.inventory.map(item => [item.programName, item]));
  let shown = 0;
  for (const section of document.querySelectorAll('#inventory-root .tier-section')) {
    let count = 0;
    for (const row of section.querySelectorAll('.inventory-row')) {
      const item = items.get(row.dataset.name);
      const matches = item && (inventoryTier === 'all' || row.dataset.tier === inventoryTier)
        && normalize(item.programName).includes(query)
        && (mode === 'all' || (mode === 'unknown' ? item.stock === null
          : item.stock !== null && item.target !== null && item.stock < item.target));
      row.hidden = !matches;
      if (matches) count++;
    }
    section.hidden = count === 0;
    shown += count;
  }
  const summary = document.getElementById('inventory-filter-summary');
  if (summary) summary.textContent = `${shown} / ${state.inventory.length}종 표시`;
  const empty = document.getElementById('inventory-filter-empty');
  if (empty) empty.hidden = shown > 0;
}

export function applyTradeFilters() {
  const query = normalize(document.getElementById('trade-search')?.value);
  const mode = document.getElementById('trade-visibility')?.value ?? 'all';
  let count = 0;
  for (const row of document.querySelectorAll('#trade-list-root .trade-row')) {
    const trade = state.session.scannedTrades?.[Number(row.dataset.index)];
    const active = trade && !trade.disabled && !trade.deleted;
    row.hidden = !trade || !normalize(`${trade.island} ${trade.fromItem} ${trade.toItem}`).includes(query)
      || (mode === 'active' && !active) || (mode === 'excluded' && active);
    if (!row.hidden) count++;
  }
  const summary = document.getElementById('trade-filter-summary');
  if (summary) summary.textContent = state.session.scannedTrades === null ? '' : `${count}행 표시`;
  const empty = document.getElementById('trade-filter-empty');
  if (empty) empty.hidden = count > 0;
}

export function initWorkspaceUI() {
  const toolsMenu = document.querySelector('.header-tools');
  toolsMenu.addEventListener('click', event => { if (event.target.closest('button')) toolsMenu.open = false; });
  document.addEventListener('pointerdown', event => { if (!toolsMenu.contains(event.target)) toolsMenu.open = false; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') toolsMenu.open = false; });
  for (const id of ['settings-dialog','tuning-dialog','map-tools-dialog']) {
    const status = document.createElement('p'); status.className = 'dialog-save-status';
    status.dataset.workspaceStatus = ''; status.setAttribute('role', 'status');
    document.getElementById(id).append(status);
  }
  const workspace = document.getElementById('app-content');
  const views = {session: document.getElementById('trade-session-panel'), inventory: document.getElementById('mainPanel')};
  const showView = name => {
    if (!views[name]) return;
    workspace.dataset.view = name;
    for (const [key, panel] of Object.entries(views)) panel.hidden = key !== name;
    for (const button of document.querySelectorAll('[data-workspace-view]')) {
      if (button.dataset.workspaceView === name) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    document.getElementById('workspace-title').textContent = name === 'session' ? '현재 회차' : '창고 재고';
  };
  for (const button of document.querySelectorAll('[data-workspace-view]')) button.addEventListener('click', () => showView(button.dataset.workspaceView));
  for (const button of document.querySelectorAll('[data-open-tool]')) button.addEventListener('click', () => {
    const target = document.getElementById(button.dataset.openTool);
    if (!target) return;
    target.click();
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (dialog) dialog.addEventListener('close', () => button.focus(), {once:true});
  });
  for (const id of ['inventory-search','inventory-stock-filter']) document.getElementById(id)?.addEventListener('input', applyInventoryFilters);
  for (const id of ['trade-search','trade-visibility']) document.getElementById(id)?.addEventListener('input', applyTradeFilters);
  for (const button of document.querySelectorAll('[data-inventory-tier]')) button.addEventListener('click', () => {
    inventoryTier = button.dataset.inventoryTier;
    for (const tab of document.querySelectorAll('[data-inventory-tier]')) tab.setAttribute('aria-pressed', String(tab === button));
    applyInventoryFilters();
    document.getElementById('inventory-root').scrollTop = 0;
  });
  showView('session');
}
