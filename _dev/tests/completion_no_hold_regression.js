const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  ROOT,
  clone,
  createRuntime,
  readJson,
} = require('./engine_harness');

const HTML = process.env.BDO_HTML
  ? path.resolve(process.env.BDO_HTML)
  : path.join(ROOT, 'BDO_물교_v1.0.html');
const BACKUP = readJson('inputs/ORIGINAL_user_backup_20260923.json');
const SPECIAL4 = readJson('fixtures/KNOWN_CORRECT_SPECIAL_IMPORT_4.json');

function createCompletionCase({
  island,
  fromItem,
  toItem,
  fromTier,
  toTier,
  isCoin = false,
  isSpec = false,
  stock = 0,
  count = 1,
  reqA = 1,
  mult = 1,
}) {
  const snapshot = clone(BACKUP);
  snapshot.savedSchedules = {};
  snapshot.scannedTrades = [{
    island,
    fromItem,
    toItem,
    reqAmount: reqA,
    count,
    yield: mult,
  }];
  if (snapshot.state[fromItem]) snapshot.state[fromItem].stock = stock;
  snapshot.ui.maxParley = '1250000';
  snapshot.ui.parleyPerTrade = '10000';
  snapshot.ui.parleyCrow = '10000';

  const runtime = createRuntime(HTML, snapshot);
  runtime.context.__completionCard = {
    island,
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
  runtime.evaluate('sortiesSpeed = [{ trades: [__completionCard] }];');
  return runtime;
}

function complete(runtime, buttonId = 'complete') {
  runtime.evaluate(`window.completeTradeAndTimer(
    document.getElementById(${JSON.stringify(buttonId)}),
    'speed', 0, 0, 0,
    sortiesSpeed[0].trades[0].island,
    sortiesSpeed[0].trades[0].toClean
  )`);
}

function run() {
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: '스케줄에 표시된 교환의 완료 보류 기능이 완전히 제거되었는지 전용 검증',
    html: path.relative(ROOT, HTML),
    tests: [],
  };

  function test(name, fn) {
    try {
      report.tests.push({ name, status: 'PASS', details: fn() });
    } catch (error) {
      report.tests.push({ name, status: 'FAIL', error: error.stack || String(error) });
    }
  }

  test('C1 제품 HTML에 완료 보류 판정과 메시지가 없다', () => {
    const source = fs.readFileSync(HTML, 'utf8');
    const start = source.indexOf('window.completeTrade = function');
    const end = source.indexOf('function renderModeColumn', start);
    assert(start >= 0 && end > start, 'completeTrade 함수 범위를 찾지 못했습니다.');
    const completionSource = source.slice(start, end);
    const forbidden = [
      '완료 보류',
      'availableStock',
      'reserveBypass',
      'bulkBypass',
      'isTier7WarehouseLeg',
      'isTier7ChainedLeg',
      '선행 5→6 교환',
    ];
    forbidden.forEach(token => assert(!completionSource.includes(token), `완료 차단 코드가 남아 있습니다: ${token}`));
    assert(!source.includes('완료 보류'), '제품 HTML 어딘가에 완료 보류 메시지가 남아 있습니다.');
    return { checkedForbiddenTokens: forbidden };
  });

  test('C2 일반 교환은 실제 재고가 비용보다 적어도 완료된다', () => {
    const runtime = createCompletionCase({
      island: '일반 교환 검증',
      fromItem: '청동 촛대',
      toItem: '정체불명의 암석',
      fromTier: 4,
      toTier: 5,
      stock: 4,
      count: 5,
      reqA: 1,
      mult: 1,
    });
    const outputBefore = runtime.evaluate(`inventory['정체불명의 암석'].stock`);
    complete(runtime, 'regular');
    assert.strictEqual(runtime.evaluate('sortiesSpeed[0].trades[0].completed'), true);
    assert.strictEqual(runtime.evaluate(`inventory['청동 촛대'].stock`), 0);
    assert.strictEqual(runtime.evaluate(`inventory['정체불명의 암석'].stock`), outputBefore + 5);
    assert.strictEqual(runtime.evaluate('scannedTrades[0].count'), 0);
    return { completed: true, inputStock: 0, outputGain: 5 };
  });

  test('C3 6→7은 선행 5→6 완료 여부를 재검사하지 않는다', () => {
    const runtime = createCompletionCase({
      island: '소산 주둔지 선착장',
      fromItem: '발렌시아 사막 보검',
      toItem: '고대인의 석판',
      fromTier: 6,
      toTier: 7,
      stock: 0,
      count: 5,
      reqA: 1,
      mult: 1,
    });
    complete(runtime, 'tier67');
    assert.strictEqual(runtime.evaluate('sortiesSpeed[0].trades[0].completed'), true);
    assert.strictEqual(runtime.evaluate('scannedTrades[0].count'), 0);
    return { completed: true, remaining: 0 };
  });

  test('C4 까마귀의 둥지 청동 촛대→까마귀 주화도 보류 없이 완료된다', () => {
    const runtime = createCompletionCase({
      island: '까마귀의 둥지',
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
    complete(runtime, 'crow');
    assert.strictEqual(runtime.evaluate('sortiesSpeed[0].trades[0].completed'), true);
    assert.strictEqual(runtime.evaluate(`inventory['청동 촛대'].stock`), 0);
    assert.strictEqual(runtime.evaluate('scannedTrades[0].count'), 0);
    return { completed: true, inputStock: 0, remaining: 0 };
  });

  test('C5 특수 교환도 최소보존 수치와 무관하게 완료된다', () => {
    const special = SPECIAL4[0];
    const runtime = createCompletionCase({
      island: special.island,
      fromItem: special.fromItem,
      toItem: special.toItem,
      fromTier: 4,
      toTier: 'mat',
      isSpec: true,
      stock: 1,
      count: 1,
      reqA: special.reqAmount,
      mult: special.yield,
    });
    complete(runtime, 'special');
    assert.strictEqual(runtime.evaluate('sortiesSpeed[0].trades[0].completed'), true);
    assert.strictEqual(runtime.evaluate(`inventory[${JSON.stringify(special.fromItem)}].stock`), 0);
    assert.strictEqual(runtime.evaluate('scannedTrades[0].count'), 0);
    return { completed: true, item: special.fromItem, remaining: 0 };
  });

  test('C6 완료 재클릭 방지만 유지되고 첫 완료는 항상 반영된다', () => {
    const runtime = createCompletionCase({
      island: '중복 완료 검증',
      fromItem: '청동 촛대',
      toItem: '정체불명의 암석',
      fromTier: 4,
      toTier: 5,
      stock: 1,
      count: 1,
      reqA: 1,
      mult: 1,
    });
    const outputBefore = runtime.evaluate(`inventory['정체불명의 암석'].stock`);
    complete(runtime, 'first');
    complete(runtime, 'second');
    assert.strictEqual(runtime.evaluate('sortiesSpeed[0].trades[0].completed'), true);
    assert.strictEqual(runtime.evaluate(`inventory['정체불명의 암석'].stock`), outputBefore + 1);
    assert.strictEqual(runtime.evaluate('scannedTrades[0].count'), 0);
    return { completed: true, duplicateApplied: false };
  });

  const outputIndex = process.argv.indexOf('--json-out');
  const output = outputIndex >= 0
    ? path.resolve(process.argv[outputIndex + 1])
    : path.join(ROOT, 'test_results', 'completion_no_hold_regression.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  report.tests.forEach(entry => console.log(`${entry.status} ${entry.name}`));
  const failures = report.tests.filter(entry => entry.status === 'FAIL');
  console.log(`SUMMARY ${report.tests.length - failures.length}/${report.tests.length} PASS`);
  if (failures.length) {
    failures.forEach(entry => console.error(entry.error));
    process.exitCode = 1;
  }
}

run();
