const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function extractMainScript(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const marker = html.indexOf('function runAlgorithmAllModes');
  if (marker < 0) throw new Error(`runAlgorithmAllModes not found: ${htmlPath}`);
  const open = html.lastIndexOf('<script', marker);
  const body = html.indexOf('>', open) + 1;
  const close = html.indexOf('</script>', marker);
  if (open < 0 || body <= 0 || close < 0) throw new Error(`inline script not found: ${htmlPath}`);
  return html.slice(body, close);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createRuntime(htmlPath, snapshot, options = {}) {
  const elements = {};
  const diagnostics = { alerts: [], toasts: [], warnings: [], downloads: [], reloads: 0 };

  function classList() {
    const values = new Set();
    return {
      add(...names) { names.forEach(name => values.add(name)); },
      remove(...names) { names.forEach(name => values.delete(name)); },
      contains(name) { return values.has(name); },
      replace(from, to) { values.delete(from); values.add(to); },
      toggle(name) { if (values.has(name)) values.delete(name); else values.add(name); },
    };
  }

  function element(id) {
    if (!elements[id]) {
      elements[id] = {
        id,
        value: '',
        checked: false,
        disabled: false,
        innerHTML: '',
        textContent: '',
        style: {},
        dataset: {},
        classList: classList(),
        parentNode: { replaceChild() {} },
        addEventListener() {},
        appendChild() {},
        removeChild() {},
        remove() {},
        click() {},
        cloneNode() { return element(`${id}:clone`); },
        querySelector() { return element(`${id}:child`); },
        querySelectorAll() { return []; },
        closest() { return element(`${id}:parent`); },
        setAttribute() {},
        getAttribute() { return null; },
        getContext() { return {}; },
      };
    }
    return elements[id];
  }

  const documentListeners = {};
  const document = {
    getElementById: element,
    createElement: () => element(`created:${Object.keys(elements).length}`),
    createElementNS: () => element(`createdNS:${Object.keys(elements).length}`),
    querySelector: () => element('query'),
    querySelectorAll: () => [],
    getElementsByName: () => [],
    addEventListener(type, handler) {
      if (!documentListeners[type]) documentListeners[type] = [];
      documentListeners[type].push(handler);
    },
    body: element('body'),
    documentElement: element('documentElement'),
    head: element('head'),
  };

  const store = { ...(options.initialStore || {}) };
  const localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem(key) { delete store[key]; },
    clear() { Object.keys(store).forEach(key => delete store[key]); },
  };

  class FileReaderStub {
    readAsText(file) {
      const result = typeof file === 'string' ? file : file.content;
      if (this.onload) this.onload({ target: { result } });
    }
    readAsDataURL() { throw new Error('readAsDataURL is not used by this regression harness'); }
  }

  const URLStub = {
    createObjectURL(blob) { diagnostics.downloads.push(blob); return `blob:regression-${diagnostics.downloads.length}`; },
    revokeObjectURL() {},
  };
  const consoleStub = {
    log() {},
    error(...args) { diagnostics.warnings.push(args); },
    warn(...args) { diagnostics.warnings.push(args); },
  };
  const contextObject = {
    document,
    localStorage,
    console: consoleStub,
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    addEventListener() {},
    alert(message) { diagnostics.alerts.push(String(message)); },
    confirm() { return true; },
    URL: URLStub,
    Blob,
    FileReader: FileReaderStub,
    location: { reload() { diagnostics.reloads += 1; } },
  };
  contextObject.window = contextObject;

  const context = vm.createContext(contextObject);
  const evaluate = code => vm.runInContext(code, context, { timeout: options.timeout || 120000 });
  let source = extractMainScript(htmlPath);
  if (options.transformSource) source = options.transformSource(source);
  evaluate(source);
  contextObject.__diagnostics = diagnostics;
  evaluate('showToast = message => window.__diagnostics.toasts.push(String(message));');

  if (snapshot) {
    const ui = snapshot.ui || {};
    const values = {
      maxParley: ui.maxParley || '1250000',
      parleyPerTrade: ui.parleyPerTrade || '10973',
      parleyCrow: ui.parleyCrow || '20000',
      normalWeight: ui.normalWeight || '14379',
      maxWeight: ui.maxWeight || '24445',
      mainShipSpeed: String((snapshot.appConfig || {}).SHIP_SPEED || 100),
      allowOceanSelectMain: ui.allowOcean || (snapshot.appConfig || {}).ALLOW_OCEAN || 'none',
      apiModelSelect: ui.apiModel || 'gemini-2.5-flash',
      uiZoomSelect: ui.uiZoom || '1.0',
    };
    Object.entries(values).forEach(([id, value]) => { element(id).value = String(value); });
    contextObject.__snapshot = clone(snapshot);
    evaluate(`
      Object.assign(APP_CONFIG, __snapshot.appConfig || {});
      inventory = JSON.parse(JSON.stringify(__snapshot.state || {}));
      tierRules = JSON.parse(JSON.stringify(__snapshot.rules || {}));
      scannedTrades = JSON.parse(JSON.stringify(__snapshot.scannedTrades || []));
      savedSchedules = JSON.parse(JSON.stringify(__snapshot.savedSchedules || {}));
      shipPresets = JSON.parse(JSON.stringify(__snapshot.shipPresets || {}));
      sortiesSpeed = [];
      sortiesBalance = [];
      window.__realRenderModeColumn = renderModeColumn;
      window.__realRenderTrades = renderTrades;
      renderModeColumn = () => {};
      openModal = () => {};
      updateGridAndCircles = () => {};
      updateSlotUI = () => {};
      updatePresetUI = () => {};
      updateDashboardUIFromConfig = () => {};
      renderTrades = () => {};
      window.mergeAdjacentDupTrades = () => {};
    `);
  }

  return { context, evaluate, elements, element, store, localStorage, diagnostics, documentListeners };
}

function scheduleTrades(runtime, mode = 'speed') {
  return clone(runtime.evaluate(`${mode === 'speed' ? 'sortiesSpeed' : 'sortiesBalance'}.flatMap((sortie, sortieIndex) => sortie.trades.filter(t => !t.isWaypoint).map((t, tradeIndex) => ({
    sortieIndex, tradeIndex, island: t.island, from: t.fromClean, to: t.toClean,
    execC: t.execC, mult: t.mult, reqA: t.reqA, fromTier: t.fromTier, toTier: t.toTier,
    originalIndex: t.originalIndex, completed: !!t.completed, isChained: !!t.isChained,
    isSpec: !!t.isSpec, isCoin: !!t.isCoin, isRandomCoin: !!t.isRandomCoin,
    isUrgent: !!t.isUrgent, isConsumedByT7: !!t.isConsumedByT7
  })))`));
}

module.exports = {
  ROOT,
  clone,
  createRuntime,
  extractMainScript,
  readJson,
  scheduleTrades,
};
