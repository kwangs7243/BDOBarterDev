const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  clone,
  createRuntime,
  readJson,
  scheduleTrades,
} = require('./engine_harness');

const ORIGINAL = path.join(ROOT, 'inputs', 'ORIGINAL_v14_1.html');
const FIXED = process.env.BDO_HTML
  ? path.resolve(process.env.BDO_HTML)
  : path.join(ROOT, 'BDO_물교_v1.0.html');
const BACKUP = readJson('inputs/ORIGINAL_user_backup_20260923.json');
const LOW = readJson('fixtures/TEST_ONLY_corrected_low_stock.json');
const SPECIAL4 = readJson('fixtures/KNOWN_CORRECT_SPECIAL_IMPORT_4.json');
const YIELD8 = readJson('fixtures/KNOWN_YIELD_MISMATCHES_8.json');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function normalizeItem(name) {
  return String(name || '').replace(/\[.*?\]\s*/g, '').replace(/\s*x\s*\d+/gi, '').replace(/\s+/g, '');
}

function importObservation(htmlPath, rows) {
  const runtime = createRuntime(htmlPath, BACKUP);
  runtime.context.__rows = clone(rows);
  runtime.evaluate('scannedTrades = []; processParsedTrades(__rows);');
  return {
    rows: clone(runtime.evaluate('scannedTrades')),
    diagnostics: clone(runtime.diagnostics),
    runtime,
  };
}

function makeSingleTradeSnapshot(row) {
  const snapshot = clone(LOW);
  snapshot.scannedTrades = [clone(row)];
  snapshot.savedSchedules = {};
  snapshot.appConfig.ALLOW_OCEAN = 'none';
  snapshot.ui.allowOcean = 'none';
  snapshot.ui.maxParley = '1250000';
  snapshot.ui.parleyPerTrade = '10000';
  snapshot.ui.parleyCrow = '10000';
  snapshot.ui.normalWeight = '50000';
  snapshot.ui.maxWeight = '85000';
  snapshot.state[row.fromItem].stock = 1000;
  snapshot.state[row.fromItem].target = 0;
  snapshot.state[row.toItem].stock = 0;
  snapshot.state[row.toItem].target = 1000;
  return snapshot;
}

function yieldObservation(htmlPath, row) {
  const runtime = createRuntime(htmlPath, makeSingleTradeSnapshot(row));
  runtime.evaluate("APP_CONFIG.ALLOW_OCEAN='none'; runAlgorithmAllModes(true);");
  const cards = scheduleTrades(runtime, 'speed');
  const card = cards.find(item => item.originalIndex === 0);
  return {
    island: row.island,
    requestedYield: row.yield,
    scheduled: !!card,
    execC: card ? card.execC : 0,
    mult: card ? card.mult : null,
    gain: card ? card.execC * card.mult : 0,
    runtime,
    card,
  };
}

async function run() {
  const report = {
    generatedAt: new Date().toISOString(),
    immutableInputs: {
      originalHtml: { path: path.relative(ROOT, ORIGINAL), sha256: sha256(ORIGINAL) },
      originalBackup: {
        path: 'inputs/ORIGINAL_user_backup_20260923.json',
        sha256: sha256(path.join(ROOT, 'inputs', 'ORIGINAL_user_backup_20260923.json')),
      },
    },
    observations: {},
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

  const originalImport = importObservation(ORIGINAL, SPECIAL4);
  const fixedImport = importObservation(FIXED, SPECIAL4);
  report.observations.specialImportBefore = originalImport.rows;
  report.observations.specialImportAfter = fixedImport.rows;

  test('A1 known special 4 preserve exact item names and row values', () => {
    assert.strictEqual(fixedImport.rows.length, SPECIAL4.length);
    SPECIAL4.forEach((expected, index) => {
      const actual = fixedImport.rows[index];
      for (const key of ['island', 'reqAmount', 'count', 'yield']) assert.strictEqual(actual[key], expected[key]);
      assert.strictEqual(normalizeItem(actual.fromItem), normalizeItem(expected.fromItem));
      assert.strictEqual(normalizeItem(actual.toItem), normalizeItem(expected.toItem));
    });
    return fixedImport.rows;
  });

  test('A2 repeated import is idempotent', () => {
    const runtime = fixedImport.runtime;
    runtime.context.__rowsAgain = clone(SPECIAL4);
    runtime.evaluate('processParsedTrades(__rowsAgain);');
    const count = runtime.evaluate('scannedTrades.length');
    assert.strictEqual(count, SPECIAL4.length);
    return { count };
  });

  test('A3 normal, coin, tier 6, and tier 7 valid rows remain unchanged', () => {
    const catalog = createRuntime(ORIGINAL, BACKUP);
    const samples = clone(catalog.evaluate(`[
      scannedTrades.find(t => { const x=getItemTier(t.toItem); return typeof x==='number' && x>=1 && x<=5; }),
      scannedTrades.find(t => getItemTier(t.toItem)==='coin'),
      scannedTrades.find(t => getItemTier(t.toItem)===6),
      scannedTrades.find(t => getItemTier(t.toItem)===7)
    ]`));
    assert(samples.every(Boolean), 'one or more regression categories are missing from the backup');
    const result = importObservation(FIXED, samples).rows;
    assert.strictEqual(result.length, samples.length);
    samples.forEach((expected, index) => {
      assert.strictEqual(normalizeItem(result[index].fromItem), normalizeItem(expected.fromItem));
      assert.strictEqual(normalizeItem(result[index].toItem), normalizeItem(expected.toItem));
      assert.strictEqual(result[index].yield, expected.yield);
    });
    return result;
  });

  test('A4 invalid or unverifiable items are held instead of silently remapped', () => {
    const bad = clone(SPECIAL4[0]);
    bad.fromItem = '확인할 수 없는 품목';
    const observed = importObservation(FIXED, [bad]);
    assert.strictEqual(observed.rows.length, 0);
    assert(observed.diagnostics.toasts.some(message => message.includes('보류')));
    return observed.diagnostics.toasts;
  });

  test('A5 unique high-confidence OCR item typos are corrected from the master list', () => {
    const tarshu = clone(YIELD8.find(row => row.island === '타슈 섬'));
    tarshu.fromItem = '뗏목 조각픔';
    tarshu.toItem = '해양 구조픔';
    const special = clone(SPECIAL4[0]);
    special.fromItem = '갈퀴 꽃 씨앗 주머나';
    const observed = importObservation(FIXED, [tarshu, special]);
    assert.strictEqual(observed.rows.length, 2);
    assert.strictEqual(observed.rows[0].fromItem, '뗏목 조각품');
    assert.strictEqual(observed.rows[0].toItem, '해양 구조품');
    assert.strictEqual(observed.rows[1].fromItem, '갈퀴 꽃 씨앗 주머니');
    assert.strictEqual(observed.rows[1].toItem, SPECIAL4[0].toItem);
    return observed.rows;
  });

  test('A6 ambiguous OCR item candidates are held for user confirmation', () => {
    const ambiguous = clone(SPECIAL4[0]);
    ambiguous.fromItem = '로퀴 꽃 씨앗 주머니';
    const observed = importObservation(FIXED, [ambiguous]);
    assert.strictEqual(observed.rows.length, 0);
    assert(observed.diagnostics.toasts.some(message => message.includes('사용자 확인')));
    return observed.diagnostics.toasts;
  });

  test('B1 yield boundaries 1, 2, and 3 pass unchanged', () => {
    const rows = SPECIAL4.slice(0, 3).map((row, index) => ({ ...clone(row), yield: index + 1 }));
    const observed = importObservation(FIXED, rows);
    assert.deepStrictEqual(observed.rows.map(row => row.yield), [1, 2, 3]);
    return observed.rows.map(row => row.yield);
  });

  test('B2 missing, zero, negative, and string yields are held', () => {
    const invalid = [undefined, 0, -1, '2'];
    const results = invalid.map((value, index) => {
      const row = clone(SPECIAL4[index % SPECIAL4.length]);
      if (value === undefined) delete row.yield;
      else row.yield = value;
      const observed = importObservation(FIXED, [row]);
      return { value: value === undefined ? '<missing>' : value, accepted: observed.rows.length };
    });
    assert(results.every(result => result.accepted === 0));
    return results;
  });

  const originalYields = YIELD8.map(row => {
    const observed = yieldObservation(ORIGINAL, row);
    return { island: observed.island, requestedYield: observed.requestedYield, mult: observed.mult, gain: observed.gain };
  });
  const fixedYields = YIELD8.map(row => {
    const observed = yieldObservation(FIXED, row);
    return { island: observed.island, requestedYield: observed.requestedYield, mult: observed.mult, gain: observed.gain };
  });
  report.observations.yieldBefore = originalYields;
  report.observations.yieldAfter = fixedYields;

  test('B3 all 8 known rows use their own yield in scheduling', () => {
    fixedYields.forEach(row => {
      assert.strictEqual(row.mult, row.requestedYield, `${row.island} yield mismatch`);
      assert(row.gain > 0, `${row.island} was not scheduled`);
    });
    return fixedYields;
  });

  const tarshu = YIELD8.find(row => row.island === '타슈 섬');
  const tarshuRun = yieldObservation(FIXED, tarshu);
  test('B4 card text and completion use the same per-row yield', () => {
    const runtime = tarshuRun.runtime;
    runtime.evaluate("window.__realRenderModeColumn('col-speed', sortiesSpeed, 'speed');");
    const cardHtml = runtime.element('col-speed').innerHTML;
    assert(cardHtml.includes(`회당 ${tarshu.yield}개`));
    assert(cardHtml.includes(`획득 ${tarshuRun.card.execC * tarshu.yield}개`));

    const before = runtime.evaluate(`inventory[${JSON.stringify(tarshu.toItem)}].stock`);
    runtime.evaluate(`window.completeTrade(document.getElementById('complete'), 'speed', ${tarshuRun.card.sortieIndex}, ${tarshuRun.card.tradeIndex}, 0)`);
    const after = runtime.evaluate(`inventory[${JSON.stringify(tarshu.toItem)}].stock`);
    const expectedAfter = before + tarshuRun.card.execC * tarshu.yield;
    assert.strictEqual(after, expectedAfter);
    const stored = JSON.parse(runtime.store.bdoInventoryState);
    assert.strictEqual(stored[tarshu.toItem].stock, expectedAfter);

    runtime.evaluate(`window.completeTrade(document.getElementById('complete'), 'speed', ${tarshuRun.card.sortieIndex}, ${tarshuRun.card.tradeIndex}, 0)`);
    assert.strictEqual(runtime.evaluate(`inventory[${JSON.stringify(tarshu.toItem)}].stock`), expectedAfter);
    return { before, after, expectedAfter, secondClickAfter: expectedAfter };
  });

  test('B5 save, refresh, schedule load, export, and backup restore preserve completed inventory', () => {
    const runtime = tarshuRun.runtime;
    const expected = runtime.evaluate(`inventory[${JSON.stringify(tarshu.toItem)}].stock`);

    runtime.evaluate("selectedMainSlot=1; saveSchedule('main');");
    const saved = JSON.parse(runtime.store.bdoSavedSchedules);
    assert(saved['1'].speed.flatMap(sortie => sortie.trades).some(trade => trade.completed));

    const refreshed = createRuntime(FIXED, null, { initialStore: runtime.store });
    refreshed.evaluate('init();');
    assert.strictEqual(refreshed.evaluate(`inventory[${JSON.stringify(tarshu.toItem)}].stock`), expected);

    runtime.evaluate('forceSave=()=>{saveInventoryState();saveScannedTradesSilent();}; exportData();');
    assert(runtime.diagnostics.downloads.length > 0);
    return Promise.resolve(runtime.diagnostics.downloads.at(-1).text()).then(text => {
      const exported = JSON.parse(text);
      assert.strictEqual(exported.state[tarshu.toItem].stock, expected);
      assert(exported.savedSchedules['1'].speed.flatMap(sortie => sortie.trades).some(trade => trade.completed));

      const restore = createRuntime(FIXED, BACKUP);
      restore.context.__backupText = text;
      restore.evaluate("importData({target:{files:[{content:__backupText}],value:'backup.json'}});");
      const restoredState = JSON.parse(restore.store.bdoInventoryState);
      assert.strictEqual(restoredState[tarshu.toItem].stock, expected);
      const restoredSchedules = JSON.parse(restore.store.bdoSavedSchedules);
      assert(restoredSchedules['1'].speed.flatMap(sortie => sortie.trades).some(trade => trade.completed));
      return { expectedStock: expected, exportedVersion: exported.version, completedStatusRestored: true };
    });
  });

  // Resolve the one asynchronous backup test without hiding synchronous failures.
  for (const entry of report.tests) {
    if (entry.status === 'PASS' && entry.details && typeof entry.details.then === 'function') {
      try { entry.details = await entry.details; }
      catch (error) { entry.status = 'FAIL'; entry.error = error.stack || String(error); delete entry.details; }
    }
  }

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

run().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
