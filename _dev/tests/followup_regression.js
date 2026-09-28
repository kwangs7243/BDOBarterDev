const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  clone,
  createRuntime,
  readJson,
  scheduleTrades,
} = require('./engine_harness');

const FIXED = process.env.BDO_HTML
  ? path.resolve(process.env.BDO_HTML)
  : path.join(ROOT, 'BDO_물교_v1.0.html');
const BACKUP = readJson('inputs/ORIGINAL_user_backup_20260923.json');
const LOW = readJson('fixtures/TEST_ONLY_corrected_low_stock.json');
const SPECIAL4 = readJson('fixtures/KNOWN_CORRECT_SPECIAL_IMPORT_4.json');

function manualSnapshot() {
  const snapshot = clone(LOW);
  snapshot.scannedTrades = [];
  snapshot.savedSchedules = {};
  snapshot.appConfig.ALLOW_OCEAN = 'none';
  Object.assign(snapshot.ui, {
    allowOcean: 'none',
    maxParley: '1250000',
    parleyPerTrade: '10000',
    normalWeight: '50000',
    maxWeight: '85000',
  });
  snapshot.state['뗏목 조각품'].stock = 1000;
  snapshot.state['뗏목 조각품'].target = 0;
  snapshot.state['해양 구조품'].stock = 0;
  snapshot.state['해양 구조품'].target = 1000;
  return snapshot;
}

function run() {
  const report = {
    generatedAt: new Date().toISOString(),
    tests: [],
  };

  function test(name, fn) {
    try {
      const details = fn();
      report.tests.push({ name, status: 'PASS', details: details === undefined ? null : details });
    } catch (error) {
      report.tests.push({ name, status: 'FAIL', error: error.stack || String(error) });
    }
  }

  test('F1 manual non-coin row starts without a silent valid yield', () => {
    const runtime = createRuntime(FIXED, manualSnapshot());
    runtime.evaluate('addManualTrade()');
    const row = clone(runtime.evaluate('scannedTrades[0]'));
    assert.strictEqual(row.yield, 0);
    return row;
  });

  test('F2 manual non-coin yield is editable and drives schedule and persisted row', () => {
    const runtime = createRuntime(FIXED, manualSnapshot());
    runtime.evaluate(`
      addManualTrade();
      updateTradeField(0, 'fromItem', '뗏목 조각품');
      updateTradeField(0, 'toItem', '해양 구조품');
      updateTradeField(0, 'island', '타슈 섬');
      updateTradeField(0, 'yield', '2');
      updateTradeField(0, 'count', '10');
      window.__realRenderTrades();
      runAlgorithmAllModes(true);
    `);
    const cards = scheduleTrades(runtime, 'speed');
    const card = cards.find(item => item.originalIndex === 0);
    const tableHtml = runtime.element('scannedTradesBody').innerHTML;
    assert(tableHtml.includes("updateTradeField(0, 'yield'"), 'non-coin row has no yield input');
    assert(card, 'manual trade was not scheduled');
    assert.strictEqual(card.mult, 2);
    assert.strictEqual(card.execC * card.mult, 20);
    const storedRows = JSON.parse(runtime.store.bdoScannedTrades);
    assert.strictEqual(storedRows[0].yield, 2);
    return { inputRendered: true, mult: card.mult, projectedGain: card.execC * card.mult, storedYield: storedRows[0].yield };
  });

  test('F3 restored polluted backup holds same-island same-output conflicts', () => {
    const restore = createRuntime(FIXED, null);
    restore.context.__backupText = JSON.stringify(BACKUP);
    restore.evaluate("importData({target:{files:[{content:__backupText}],value:'backup.json'}})");

    const refreshed = createRuntime(FIXED, null, { initialStore: restore.store });
    refreshed.evaluate('init()');
    const beforeCount = refreshed.evaluate('scannedTrades.length');
    refreshed.context.__newRows = clone(SPECIAL4);
    refreshed.evaluate('processParsedTrades(__newRows)');
    const afterCount = refreshed.evaluate('scannedTrades.length');
    const impacted = new Set(SPECIAL4.map(row => row.island));
    const activeRows = clone(refreshed.evaluate('scannedTrades.filter(t => !t.deleted)'));
    const conflicts = Array.from(impacted).map(island => ({
      island,
      rows: activeRows.filter(row => row.island === island),
    }));

    assert.strictEqual(afterCount, beforeCount, 'conflicting corrected rows were appended');
    assert(conflicts.every(item => item.rows.length === 1), 'one or more islands were duplicated');
    assert(refreshed.diagnostics.toasts.some(message => message.includes('기존 행 충돌 4건')),
      `missing conflict warning: ${JSON.stringify(refreshed.diagnostics.toasts)}`);
    return { beforeCount, afterCount, conflicts, toasts: refreshed.diagnostics.toasts };
  });

  test('F4 exact repeated JSON import remains idempotent', () => {
    const runtime = createRuntime(FIXED, manualSnapshot());
    runtime.context.__rows = clone(SPECIAL4);
    runtime.evaluate('processParsedTrades(__rows); processParsedTrades(__rows)');
    const rows = clone(runtime.evaluate('scannedTrades'));
    assert.strictEqual(rows.length, SPECIAL4.length);
    return { rowCount: rows.length, toasts: runtime.diagnostics.toasts };
  });

  const outputIndex = process.argv.indexOf('--json-out');
  if (outputIndex >= 0) {
    const output = path.resolve(process.argv[outputIndex + 1]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  report.tests.forEach(entry => console.log(`${entry.status} ${entry.name}`));
  const failed = report.tests.filter(entry => entry.status === 'FAIL');
  console.log(`SUMMARY ${report.tests.length - failed.length}/${report.tests.length} PASS`);
  if (failed.length) {
    failed.forEach(entry => console.error(entry.error));
    process.exitCode = 1;
  }
}

run();
