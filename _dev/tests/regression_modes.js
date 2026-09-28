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
const FULL_INPUTS = readJson('fixtures/TEST_ONLY_synthetic_T1T4_full_T5_original.json');
const TARGET_FULL = readJson('fixtures/TEST_ONLY_synthetic_target_full_stock.json');
const SPECIAL4 = readJson('fixtures/KNOWN_CORRECT_SPECIAL_IMPORT_4.json');
const YIELD8 = readJson('fixtures/KNOWN_YIELD_MISMATCHES_8.json');

function runMode(snapshot, allowOcean, setup = '') {
  const runtime = createRuntime(FIXED, snapshot);
  runtime.evaluate(`APP_CONFIG.ALLOW_OCEAN=${JSON.stringify(allowOcean)};${setup};runAlgorithmAllModes(true);`);
  return runtime;
}

function unexpectedReserveViolations(runtime, mode) {
  const cards = scheduleTrades(runtime, mode);
  const stock = clone(runtime.evaluate('Object.fromEntries(Object.entries(inventory).map(([name,value])=>[name,value.stock]))'));
  const rules = clone(runtime.evaluate('tierRules'));
  const failures = [];
  cards.forEach(card => {
    if (card.fromTier !== 0 && stock[card.from] !== undefined) {
      const before = stock[card.from];
      const cost = card.execC * card.reqA;
      const after = before - cost;
      const reserve = Number(rules[card.fromTier] || (card.fromTier === 5 ? 1 : 20));
      const bulk = (card.isSpec || card.isRandomCoin) && before >= reserve;
      const allowed = bulk || card.isCoin || (card.toTier === 5 && (card.isUrgent || card.isConsumedByT7));
      if (after < reserve && !allowed) failures.push({ island: card.island, item: card.from, before, cost, after, reserve });
      stock[card.from] = Math.max(0, after);
    }
    if (stock[card.to] !== undefined) stock[card.to] += card.execC * card.mult;
  });
  return failures;
}

function singleTradeSnapshot(row) {
  const snapshot = clone(LOW);
  snapshot.scannedTrades = [clone(row)];
  snapshot.savedSchedules = {};
  snapshot.state[row.fromItem].stock = 100;
  if (snapshot.state[row.toItem]) {
    snapshot.state[row.toItem].stock = 0;
    snapshot.state[row.toItem].target = 100;
  }
  snapshot.ui.maxParley = '1250000';
  snapshot.ui.parleyPerTrade = '10000';
  snapshot.ui.parleyCrow = '10000';
  snapshot.ui.normalWeight = '50000';
  snapshot.ui.maxWeight = '85000';
  return snapshot;
}

function run() {
  const report = { generatedAt: new Date().toISOString(), tests: [] };
  function test(name, fn) {
    try {
      const details = fn();
      report.tests.push({ name, status: 'PASS', details: details === undefined ? null : details });
    } catch (error) {
      report.tests.push({ name, status: 'FAIL', error: error.stack || String(error) });
    }
  }

  test('R1 general and inner modes still generate speed and balance schedules', () => {
    const results = {};
    for (const mode of ['none', 'inner']) {
      const runtime = runMode(LOW, mode);
      results[mode] = {
        speed: runtime.evaluate('sortiesSpeed.length'),
        balance: runtime.evaluate('sortiesBalance.length'),
      };
      assert(results[mode].speed > 0 && results[mode].balance > 0);
    }
    return results;
  });

  test('R2 tier 7 mode still generates tier 6 or tier 7 cards', () => {
    const runtime = runMode(TARGET_FULL, 't7_3region', `
      scannedTrades.forEach(t => {
        const tier=getItemTier(t.toItem);
        if (tier===6 || tier===7) t.disabled=false;
      })
    `);
    const cards = scheduleTrades(runtime, 'speed');
    const tier67 = cards.filter(card => card.toTier === 6 || card.toTier === 7);
    assert(tier67.length > 0);
    return { sorties: runtime.evaluate('sortiesSpeed.length'), tier67Cards: tier67.length };
  });

  test('R3 tier 4 to 5 exchanges remain five-exchange bundles', () => {
    const runtime = runMode(FULL_INPUTS, 'none', `
      scannedTrades.forEach(t => {
        if (getItemTier(t.toItem)==='coin') t.disabled=true;
        if (getItemTier(t.fromItem)===4 && getItemTier(t.toItem)===5) t.disabled=false;
      })
    `);
    const cards = scheduleTrades(runtime, 'speed').filter(card => card.fromTier === 4 && card.toTier === 5);
    assert(cards.length > 0);
    assert(cards.every(card => card.execC === 5));
    return { cards: cards.length, exchanges: cards.reduce((sum, card) => sum + card.execC, 0) };
  });

  test('R4 special and coin completion consume input and list count without fake inventory output', () => {
    const specialRow = clone(SPECIAL4[0]);
    const special = runMode(singleTradeSnapshot(specialRow), 'none');
    const specialCard = scheduleTrades(special, 'speed')[0];
    assert(specialCard && specialCard.isSpec);
    const specialBefore = special.evaluate(`inventory[${JSON.stringify(specialRow.fromItem)}].stock`);
    special.evaluate(`window.completeTrade(document.getElementById('special'),'speed',${specialCard.sortieIndex},${specialCard.tradeIndex},0)`);
    assert.strictEqual(special.evaluate(`inventory[${JSON.stringify(specialRow.fromItem)}].stock`), specialBefore - specialCard.execC * specialCard.reqA);
    assert.strictEqual(special.evaluate('scannedTrades[0].count'), 0);

    const catalog = createRuntime(FIXED, BACKUP);
    const coinRow = clone(catalog.evaluate("scannedTrades.find(t=>getItemTier(t.toItem)==='coin'&&t.island==='카슈마 섬') || scannedTrades.find(t=>getItemTier(t.toItem)==='coin')"));
    const coin = runMode(singleTradeSnapshot(coinRow), 'inner', 'scannedTrades[0].disabled=false');
    const coinCard = scheduleTrades(coin, 'speed').find(card => card.isCoin);
    assert(coinCard);
    const coinBefore = coin.evaluate(`inventory[${JSON.stringify(coinRow.fromItem)}].stock`);
    coin.evaluate(`window.completeTrade(document.getElementById('coin'),'speed',${coinCard.sortieIndex},${coinCard.tradeIndex},0)`);
    assert.strictEqual(coin.evaluate(`inventory[${JSON.stringify(coinRow.fromItem)}].stock`), coinBefore - coinCard.execC * coinCard.reqA);
    assert.strictEqual(coin.evaluate('scannedTrades[0].count'), coinRow.count - coinCard.execC);
    return { specialExec: specialCard.execC, coinExec: coinCard.execC };
  });

  test('R5 corrected low-stock batch and replan schedules have no unintended reserve violation', () => {
    const setup = `
      scannedTrades.forEach(t=>{
        const tier=inventory[t.toItem]?inventory[t.toItem].tier:getItemTier(t.toItem);
        if(tier===5 || getItemTier(t.toItem)==='mat' || getItemTier(t.toItem)==='coin') t.disabled=true;
      })
    `;
    const runtime = runMode(LOW, 'none', setup);
    const speedFailures = unexpectedReserveViolations(runtime, 'speed');
    const balanceFailures = unexpectedReserveViolations(runtime, 'balance');
    assert.deepStrictEqual(speedFailures, []);
    assert.deepStrictEqual(balanceFailures, []);

    const first = clone(runtime.evaluate('sortiesSpeed[0].trades.map(t=>({idx:t.originalIndex,isWaypoint:!!t.isWaypoint}))'));
    first.forEach((card, index) => {
      if (!card.isWaypoint) runtime.evaluate(`window.completeTrade(document.getElementById('first-${index}'),'speed',0,${index},${card.idx})`);
    });
    runtime.evaluate('runAlgorithmAllModes(true)');
    const replanFailures = unexpectedReserveViolations(runtime, 'speed');
    assert.deepStrictEqual(replanFailures, []);
    return { initialSpeed: scheduleTrades(runtime, 'speed').length, replanFailures };
  });

  test('R6 generated stale card completes and applies all state updates without a hold', () => {
    const row = clone(YIELD8.find(item => item.island === '타슈 섬'));
    const runtime = runMode(singleTradeSnapshot(row), 'none');
    const card = scheduleTrades(runtime, 'speed')[0];
    runtime.evaluate(`inventory[${JSON.stringify(row.fromItem)}].stock=0;saveInventoryState();`);
    const beforeOutput = runtime.evaluate(`inventory[${JSON.stringify(row.toItem)}].stock`);
    runtime.evaluate(`window.completeTrade(document.getElementById('stale'),'speed',${card.sortieIndex},${card.tradeIndex},0)`);
    assert.strictEqual(runtime.evaluate(`inventory[${JSON.stringify(row.fromItem)}].stock`), 0);
    assert.strictEqual(runtime.evaluate(`inventory[${JSON.stringify(row.toItem)}].stock`), beforeOutput + card.execC * card.mult);
    assert.strictEqual(runtime.evaluate('scannedTrades[0].count'), 0);
    assert.strictEqual(runtime.evaluate(`sortiesSpeed[${card.sortieIndex}].trades[${card.tradeIndex}].completed`), true);
    assert(!runtime.diagnostics.toasts.some(message => message.includes('완료 보류')));
    return { completed: true, inputStock: 0, outputGain: card.execC * card.mult };
  });

  test('R7 saved tuning, weight, speed, and route settings restore unchanged', () => {
    const runtime = runMode(LOW, 'inner');
    const expected = clone(runtime.evaluate(`({
      shipSpeed:APP_CONFIG.SHIP_SPEED,
      oceanRoute:APP_CONFIG.OCEAN_ROUTE,
      weight:APP_CONFIG.WEIGHT,
      normalWeight:document.getElementById('normalWeight').value,
      maxWeight:document.getElementById('maxWeight').value
    })`));
    runtime.evaluate("selectedMainSlot=1;saveSchedule('main');APP_CONFIG.SHIP_SPEED=1;APP_CONFIG.OCEAN_ROUTE='changed';loadSchedule('main');");
    const actual = clone(runtime.evaluate(`({
      shipSpeed:APP_CONFIG.SHIP_SPEED,
      oceanRoute:APP_CONFIG.OCEAN_ROUTE,
      weight:APP_CONFIG.WEIGHT,
      normalWeight:document.getElementById('normalWeight').value,
      maxWeight:document.getElementById('maxWeight').value
    })`));
    assert.deepStrictEqual(actual, expected);
    return actual;
  });

  const outputIndex = process.argv.indexOf('--json-out');
  if (outputIndex >= 0) {
    const output = path.resolve(process.argv[outputIndex + 1]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  report.tests.forEach(entry => console.log(`${entry.status} ${entry.name}`));
  const failures = report.tests.filter(entry => entry.status === 'FAIL');
  console.log(`SUMMARY ${report.tests.length - failures.length}/${report.tests.length} PASS`);
  if (failures.length) {
    failures.forEach(entry => console.error(entry.error));
    process.exitCode = 1;
  }
}

run();
