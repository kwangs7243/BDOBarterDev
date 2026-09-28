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

const DEFAULT_HTML = path.join(ROOT, 'BDO_물교_v1.0.html');
const BACKUP = readJson('inputs/ORIGINAL_user_backup_20260923.json');
const USER_ROWS = readJson('fixtures/USER_CAPTURE_20260923_74_ROWS.json');
const SPECIAL4 = readJson('fixtures/KNOWN_CORRECT_SPECIAL_IMPORT_4.json');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? path.resolve(process.argv[index + 1]) : fallback;
}

const HTML = argValue('--html', DEFAULT_HTML);
const OUTPUT = argValue('--json-out', path.join(ROOT, 'test_results', 'tier7_completion_regression.json'));

function rawRow(island, fromItem) {
  const row = USER_ROWS.find(item => item.island === island && item.fromItem === fromItem);
  assert(row, `사용자 입력에서 행을 찾지 못했습니다: ${island} / ${fromItem}`);
  return clone(row);
}

const T56 = rawRow('하코번 섬', '팔랑나비 박제품');
const T67 = rawRow('소산 주둔지 선착장', '발렌시아 사막 보검');
const CROW = rawRow('카슈마 섬', '청록빛 소금덩어리');

function buildRuntime(stock, rows = [T56, T67]) {
  const snapshot = clone(BACKUP);
  snapshot.scannedTrades = [];
  snapshot.savedSchedules = {};
  snapshot.state['팔랑나비 박제품'].stock = stock;
  snapshot.rules[5] = 5;
  snapshot.appConfig.ALLOW_OCEAN = 't7_3region';
  snapshot.ui = {
    maxParley: '1250000',
    parleyPerTrade: '10000',
    parleyCrow: '10000',
    normalWeight: '85000',
    maxWeight: '85000',
    allowOcean: 't7_3region',
  };

  const runtime = createRuntime(HTML, snapshot);
  runtime.context.__rawRows = clone(rows);
  runtime.evaluate(`
    processParsedTrades(__rawRows);
    APP_CONFIG.ALLOW_OCEAN = 't7_3region';
    document.getElementById('allowOceanSelectMain').value = 't7_3region';
    runAlgorithmAllModes(true);
  `);
  return runtime;
}

function buildFullUserRuntime() {
  const snapshot = clone(BACKUP);
  snapshot.scannedTrades = [];
  snapshot.savedSchedules = {};
  snapshot.appConfig.ALLOW_OCEAN = 't7_3region';
  snapshot.ui = {
    ...(snapshot.ui || {}),
    allowOcean: 't7_3region',
  };
  const runtime = createRuntime(HTML, snapshot);
  runtime.context.__rawRows = clone(USER_ROWS);
  runtime.evaluate(`
    processParsedTrades(__rawRows);
    APP_CONFIG.ALLOW_OCEAN = 't7_3region';
    document.getElementById('allowOceanSelectMain').value = 't7_3region';
    runAlgorithmAllModes(true);
  `);
  return runtime;
}

function card(runtime, fromTier, toTier) {
  return scheduleTrades(runtime, 'speed').find(item => item.fromTier === fromTier && item.toTier === toTier);
}

function complete(runtime, selected, buttonId) {
  runtime.evaluate(`window.completeTrade(
    document.getElementById(${JSON.stringify(buttonId)}),
    'speed',
    ${selected.sortieIndex},
    ${selected.tradeIndex},
    ${selected.originalIndex}
  )`);
}

function buildDirectCompletionRuntime({ fromItem, toItem, fromTier, toTier, isCoin = false, isSpec = false, stock = 1, count = 1, reqA = 1, mult = 1 }) {
  const snapshot = clone(BACKUP);
  snapshot.scannedTrades = [{
    island: isCoin ? '까마귀의 둥지' : '특수 교환 검증',
    fromItem,
    toItem,
    reqAmount: reqA,
    count,
    yield: mult,
  }];
  snapshot.savedSchedules = {};
  snapshot.state[fromItem].stock = stock;
  snapshot.ui.maxParley = '1250000';
  snapshot.ui.parleyPerTrade = '10000';
  snapshot.ui.parleyCrow = '10000';

  const runtime = createRuntime(HTML, snapshot);
  runtime.context.__directCard = {
    island: snapshot.scannedTrades[0].island,
    fromClean: fromItem,
    toClean: toItem,
    fromTier,
    toTier,
    isCoin,
    isSpec,
    isRandomCoin: false,
    execC: count,
    reqA,
    mult,
    originalIndex: 0,
    completed: false,
  };
  runtime.evaluate('sortiesSpeed = [{ trades: [__directCard] }];');
  return runtime;
}

function runCase(name, fn, report) {
  try {
    const details = fn();
    report.tests.push({ name, status: 'PASS', details });
  } catch (error) {
    report.tests.push({ name, status: 'FAIL', error: error.stack || String(error) });
  }
}

function run() {
  const report = {
    generatedAt: new Date().toISOString(),
    html: path.relative(ROOT, HTML),
    tests: [],
  };

  runCase('완료 함수에 보류 판정 코드가 남아 있지 않다', () => {
    const source = fs.readFileSync(HTML, 'utf8');
    const section = source.slice(
      source.indexOf('window.completeTrade = function'),
      source.indexOf('function renderModeColumn')
    );
    assert(section.length > 0, 'completeTrade 함수 본문을 찾지 못했습니다.');
    for (const forbidden of ['완료 보류', 'availableStock', 'reserveBypass', 'bulkBypass', 'isTier7WarehouseLeg', 'isTier7ChainedLeg']) {
      assert(!section.includes(forbidden), `완료 보류 판정 흔적이 남아 있습니다: ${forbidden}`);
    }
    return { checkedTokens: 6 };
  }, report);

  runCase('현재 재고 1개에서는 5→6→7이 1회만 생성된다', () => {
    const runtime = buildRuntime(1);
    const leg56 = card(runtime, 5, 6);
    const leg67 = card(runtime, 6, 7);
    assert(leg56 && leg67, '5→6 또는 6→7 카드가 생성되지 않았습니다.');
    assert.strictEqual(leg56.execC, 1);
    assert.strictEqual(leg67.execC, 1);
    return { stock: 1, tier56: leg56.execC, tier67: leg67.execC };
  }, report);

  runCase('충분 재고 5개에서는 5→6→7이 온전한 5회로 생성된다', () => {
    const runtime = buildRuntime(5);
    const leg56 = card(runtime, 5, 6);
    const leg67 = card(runtime, 6, 7);
    assert(leg56 && leg67, '5→6 또는 6→7 카드가 생성되지 않았습니다.');
    assert.strictEqual(leg56.execC, 5);
    assert.strictEqual(leg67.execC, 5);
    return { stock: 5, tier56: leg56.execC, tier67: leg67.execC };
  }, report);

  runCase('생성된 5→6→7 카드는 순서대로 완료되고 재고와 목록 수량이 갱신된다', () => {
    const runtime = buildRuntime(5);
    const leg56 = card(runtime, 5, 6);
    const leg67 = card(runtime, 6, 7);
    assert(leg56 && leg67);

    const initialParley = Number(runtime.element('maxParley').value);
    complete(runtime, leg56, 'complete-56');
    const after56 = {
      completed: runtime.evaluate(`sortiesSpeed[${leg56.sortieIndex}].trades[${leg56.tradeIndex}].completed`),
      stock: runtime.evaluate(`inventory['팔랑나비 박제품'].stock`),
      remaining: runtime.evaluate(`scannedTrades[${leg56.originalIndex}].count`),
      toasts: clone(runtime.diagnostics.toasts),
    };
    complete(runtime, leg67, 'complete-67');
    const after67 = {
      completed: runtime.evaluate(`sortiesSpeed[${leg67.sortieIndex}].trades[${leg67.tradeIndex}].completed`),
      remaining: runtime.evaluate(`scannedTrades[${leg67.originalIndex}].count`),
      parley: Number(runtime.element('maxParley').value),
      toasts: clone(runtime.diagnostics.toasts),
    };

    assert.strictEqual(after56.completed, true);
    assert.strictEqual(after56.stock, 0);
    assert.strictEqual(after56.remaining, 0);
    assert.strictEqual(after67.completed, true);
    assert.strictEqual(after67.remaining, 0);
    assert.strictEqual(after67.parley, initialParley - 100000);
    return { initialParley, after56, after67 };
  }, report);

  runCase('사용자 전체 입력의 현재 3지역 7단 카드 17개가 모두 순서대로 완료된다', () => {
      const runtime = buildFullUserRuntime();
      const neededTier5 = new Set(USER_ROWS
        .filter(row => ['하코번 섬', '아레하자 마을', '해모 섬', '달래나루', '그란디하', '깊은 밤의 항구'].includes(row.island))
        .map(row => row.fromItem));
      const cards = scheduleTrades(runtime, 'speed').filter(item =>
        (item.fromTier === 4 && item.toTier === 5 && neededTier5.has(item.to))
        || (item.fromTier === 5 && item.toTier === 6)
        || (item.fromTier === 6 && item.toTier === 7)
      );
      const tier56Total = cards.filter(item => item.fromTier === 5 && item.toTier === 6)
        .reduce((sum, item) => sum + item.execC, 0);
      const tier67Total = cards.filter(item => item.fromTier === 6 && item.toTier === 7)
        .reduce((sum, item) => sum + item.execC, 0);
      assert.strictEqual(tier56Total, 17);
      assert.strictEqual(tier67Total, 17);

      cards.forEach((item, index) => complete(runtime, item, `full-${index}`));
      const completed = cards.map(item => runtime.evaluate(
        `sortiesSpeed[${item.sortieIndex}].trades[${item.tradeIndex}].completed`
      ));
      assert(completed.every(Boolean));
      assert(!runtime.diagnostics.toasts.some(message => message.includes('완료 보류')));
      return {
        cards: cards.length,
        tier45Total: cards.filter(item => item.fromTier === 4 && item.toTier === 5)
          .reduce((sum, item) => sum + item.execC, 0),
        tier56Total,
        tier67Total,
        completionToasts: runtime.diagnostics.toasts.filter(message => message.includes('교환 완료')).length,
      };
  }, report);

  runCase('생성 후 실제 5단 재고가 부족해져도 생성된 카드는 완료된다', () => {
    const runtime = buildRuntime(5);
    const leg56 = card(runtime, 5, 6);
    assert(leg56);
    runtime.evaluate(`inventory['팔랑나비 박제품'].stock = 4;`);
    complete(runtime, leg56, 'stale-56');
    assert.strictEqual(runtime.evaluate(`sortiesSpeed[${leg56.sortieIndex}].trades[${leg56.tradeIndex}].completed`), true);
    assert.strictEqual(runtime.evaluate(`inventory['팔랑나비 박제품'].stock`), 0);
    assert.strictEqual(runtime.evaluate(`scannedTrades[${leg56.originalIndex}].count`), 0);
    assert(!runtime.diagnostics.toasts.some(message => message.includes('완료 보류')));
    return { stock: 0, remaining: 0, toasts: clone(runtime.diagnostics.toasts) };
  }, report);

  runCase('6→7을 먼저 눌러도 완료와 목록·교섭력 갱신이 적용된다', () => {
      const runtime = buildRuntime(5);
      const leg67 = card(runtime, 6, 7);
      assert(leg67);
      const beforeParley = Number(runtime.element('maxParley').value);
      complete(runtime, leg67, 'out-of-order-67');
      assert.strictEqual(runtime.evaluate(`sortiesSpeed[${leg67.sortieIndex}].trades[${leg67.tradeIndex}].completed`), true);
      assert.strictEqual(runtime.evaluate(`scannedTrades[${leg67.originalIndex}].count`), 0);
      assert.strictEqual(Number(runtime.element('maxParley').value), beforeParley - 50000);
      assert(!runtime.diagnostics.toasts.some(message => message.includes('완료 보류')));
      return { remaining: 0, parley: Number(runtime.element('maxParley').value) };
  }, report);

  runCase('까마귀의 둥지 청동 촛대→까마귀 주화는 최소보존과 무관하게 완료된다', () => {
    const runtime = buildDirectCompletionRuntime({
      fromItem: '청동 촛대',
      toItem: '까마귀 주화',
      fromTier: 4,
      toTier: 'coin',
      isCoin: true,
      stock: 1,
      count: 1,
      reqA: 1,
      mult: 373,
    });
    const beforeParley = Number(runtime.element('maxParley').value);
    complete(runtime, { sortieIndex: 0, tradeIndex: 0, originalIndex: 0 }, 'crow-nest');
    assert.strictEqual(runtime.evaluate('sortiesSpeed[0].trades[0].completed'), true);
    assert.strictEqual(runtime.evaluate(`inventory['청동 촛대'].stock`), 0);
    assert.strictEqual(runtime.evaluate('scannedTrades[0].count'), 0);
    assert.strictEqual(Number(runtime.element('maxParley').value), beforeParley - 10000);
    assert(!runtime.diagnostics.toasts.some(message => message.includes('완료 보류')));
    return { stock: 0, remaining: 0, parley: Number(runtime.element('maxParley').value) };
  }, report);

  runCase('특수 교환도 최소보존과 무관하게 완료된다', () => {
    const special = SPECIAL4[0];
    const runtime = buildDirectCompletionRuntime({
      fromItem: special.fromItem,
      toItem: special.toItem,
      fromTier: 4,
      toTier: 'mat',
      isSpec: true,
      stock: 1,
      count: 1,
      reqA: 1,
      mult: 1,
    });
    complete(runtime, { sortieIndex: 0, tradeIndex: 0, originalIndex: 0 }, 'special');
    assert.strictEqual(runtime.evaluate('sortiesSpeed[0].trades[0].completed'), true);
    assert.strictEqual(runtime.evaluate(`inventory[${JSON.stringify(special.fromItem)}].stock`), 0);
    assert.strictEqual(runtime.evaluate('scannedTrades[0].count'), 0);
    assert(!runtime.diagnostics.toasts.some(message => message.includes('완료 보류')));
    return { item: special.fromItem, stock: 0, remaining: 0 };
  }, report);

  runCase('7단 재고 교환이 없어도 까마귀주화 행은 별도로 관찰된다', () => {
    const runtime = buildRuntime(0, [CROW]);
    const coins = scheduleTrades(runtime, 'speed').filter(item => item.isCoin);
    return {
      generated: coins.length,
      cards: coins.map(item => ({ island: item.island, execC: item.execC })),
      note: coins.length > 0
        ? '까마귀주화 카드는 유지됨'
        : '이 입력/경로 조합에서는 까마귀주화 카드가 생성되지 않음(관찰만 수행)',
    };
  }, report);

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  report.tests.forEach(entry => console.log(`${entry.status} ${entry.name}`));
  const failures = report.tests.filter(entry => entry.status === 'FAIL');
  console.log(`SUMMARY ${report.tests.length - failures.length}/${report.tests.length} PASS`);
  if (failures.length) {
    failures.forEach(entry => console.error(entry.error));
    process.exitCode = 1;
  }
}

run();
