const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT, clone, createRuntime, readJson } = require('./engine_harness');

const BEFORE = path.join(ROOT, 'inputs', 'BEFORE_master_inventory_patch_v1.0_20260924.html');
const HTML = path.join(ROOT, 'BDO_물교_v1.0.html');
const BACKUP = readJson('inputs/ORIGINAL_user_backup_20260923.json');
const SPECIAL4 = readJson('fixtures/KNOWN_CORRECT_SPECIAL_IMPORT_4.json');
const EXPECTED_TRADE_IMPORT_SHA256 = '683f5b883645208b16712c4f463800ea98367f2e4317f24bad86f1d18e6d8273';
const EXPECTED_SCHEDULER_SHA256 = '0c64f7a542a028045a91b4b67b6721103ccfd76a646d74af0a894a9ee4f7be31';

function sourceRange(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `source range missing: ${startMarker}`);
  return html.slice(start, end);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function pasteText(runtime, value) {
  const handlers = runtime.documentListeners.paste || [];
  assert(handlers.length > 0, 'paste handler was not registered');
  const clipboardData = { getData: type => type === 'text' ? value : '', items: [] };
  for (const handler of handlers) await handler({ clipboardData, originalEvent: { clipboardData } });
}

function inventorySnapshot(runtime) {
  return clone(runtime.evaluate('inventory'));
}

function createCleanRuntime(html = HTML) {
  const runtime = createRuntime(html, BACKUP);
  runtime.evaluate('scannedTrades = []; sortiesSpeed = []; sortiesBalance = []; sortiesBulk = [];');
  return runtime;
}

async function run() {
  const report = { generatedAt: new Date().toISOString(), tests: [] };

  async function test(name, fn) {
    try {
      const details = await fn();
      report.tests.push({ name, status: 'PASS', details: details === undefined ? null : details });
    } catch (error) {
      report.tests.push({ name, status: 'FAIL', error: error.stack || String(error) });
    }
  }

  await test('P1 기존 Array JSON paste 결과가 수정 전과 동일하다', async () => {
    const before = createCleanRuntime(BEFORE);
    const after = createCleanRuntime(HTML);
    const payload = JSON.stringify(SPECIAL4);
    await pasteText(before, payload);
    await pasteText(after, payload);
    const beforeRows = clone(before.evaluate('scannedTrades'));
    const afterRows = clone(after.evaluate('scannedTrades'));
    assert.deepStrictEqual(afterRows, beforeRows);
    assert.strictEqual(afterRows.length, SPECIAL4.length);
    return { rows: afterRows.length, identicalToBefore: true };
  });

  await test('P2 정상 1~4단 PATCH는 검토 전 무변경이고 적용 후 지정 항목만 바꾼다', async () => {
    const runtime = createCleanRuntime();
    const before = inventorySnapshot(runtime);
    const storeBefore = clone(runtime.store);
    const patch = {
      type: 'master_inventory_patch', version: 1,
      items: { '굳어진 용암 액': 31, '해적선 돛대': 33, '롬타스 그물': 15 },
    };
    await pasteText(runtime, JSON.stringify(patch));
    assert.deepStrictEqual(inventorySnapshot(runtime), before);
    assert.deepStrictEqual(runtime.store, storeBefore);
    assert.strictEqual(runtime.evaluate('scanReviewContext.type'), 'master_inventory_patch');
    assert.strictEqual(runtime.element('scanReviewApplyButton').disabled, false);
    assert(runtime.element('scanReviewBody').innerHTML.includes('기존 재고'));
    assert(runtime.element('scanReviewBody').innerHTML.includes('새 재고'));
    runtime.evaluate('applyScanReview()');
    const after = inventorySnapshot(runtime);
    assert.strictEqual(after['굳어진 용암 액'].stock, 31);
    assert.strictEqual(after['해적선 돛대'].stock, 33);
    assert.strictEqual(after['롬타스 그물'].stock, 15);
    const changed = Object.keys(after).filter(name => after[name].stock !== before[name].stock).sort();
    assert.deepStrictEqual(changed, Object.keys(patch.items).sort());
    const stored = JSON.parse(runtime.store.bdoInventoryState);
    assert.strictEqual(stored['해적선 돛대'].stock, 33);
    return { applied: changed, unspecifiedItemsPreserved: Object.keys(after).length - changed.length };
  });

  await test('P3 부분 PATCH는 입력되지 않은 재고를 유지한다', async () => {
    const runtime = createCleanRuntime();
    const before = inventorySnapshot(runtime);
    runtime.context.__patch = { type: 'master_inventory_patch', version: 1, items: { '굳어진 용암 액': 0 } };
    runtime.evaluate('showMasterInventoryPatchReview(__patch); applyScanReview();');
    const after = inventorySnapshot(runtime);
    assert.strictEqual(after['굳어진 용암 액'].stock, 0);
    for (const name of Object.keys(before)) {
      if (name !== '굳어진 용암 액') assert.strictEqual(after[name].stock, before[name].stock, name);
    }
    return { zeroAccepted: true, otherItemsUnchanged: Object.keys(before).length - 1 };
  });

  await test('P4 5단 키가 섞이면 전체 PATCH가 차단된다', async () => {
    const runtime = createCleanRuntime();
    const before = inventorySnapshot(runtime);
    runtime.context.__patch = {
      type: 'master_inventory_patch', version: 1,
      items: { '굳어진 용암 액': 31, '흰색 애벌레 박제품': 5 },
    };
    runtime.evaluate('showMasterInventoryPatchReview(__patch)');
    assert.strictEqual(runtime.evaluate('scanReviewContext.type'), 'master_inventory_patch_invalid');
    assert.strictEqual(runtime.element('scanReviewApplyButton').disabled, true);
    assert(runtime.element('scanReviewBody').innerHTML.includes('5단 품목'));
    runtime.evaluate('applyScanReview()');
    assert.deepStrictEqual(inventorySnapshot(runtime), before);
    assert.strictEqual(runtime.store.bdoInventoryState, undefined);
    return { rejected: '흰색 애벌레 박제품', atomicNoChange: true };
  });

  await test('P5 6·7단, 알 수 없는 키, 정식명 롭타스 그물은 보정 없이 거부된다', async () => {
    const catalog = createCleanRuntime();
    const [tier6Name, tier7Name] = clone(catalog.evaluate('[masterData[6][0].name, masterData[7][0].name]'));
    for (const name of [tier6Name, tier7Name, '알 수 없는 품목', '롭타스 그물']) {
      const runtime = createCleanRuntime();
      const before = inventorySnapshot(runtime);
      runtime.context.__patch = { type: 'master_inventory_patch', version: 1, items: { [name]: 10 } };
      runtime.evaluate('showMasterInventoryPatchReview(__patch); applyScanReview();');
      assert.deepStrictEqual(inventorySnapshot(runtime), before);
      assert(runtime.element('scanReviewApplyButton').disabled);
    }
    return { rejected: [tier6Name, tier7Name, '알 수 없는 품목', '롭타스 그물'], autocorrected: false };
  });

  await test('P6 음수·문자열·소수·NaN 수량은 모두 거부된다', async () => {
    const values = [-1, '10', 1.5, NaN];
    for (const value of values) {
      const runtime = createCleanRuntime();
      const before = inventorySnapshot(runtime);
      runtime.context.__badValue = value;
      runtime.evaluate(`showMasterInventoryPatchReview({
        type:'master_inventory_patch', version:1,
        items:{'굳어진 용암 액':__badValue}
      }); applyScanReview();`);
      assert.deepStrictEqual(inventorySnapshot(runtime), before);
      assert.strictEqual(runtime.store.bdoInventoryState, undefined);
    }
    return { rejected: ['-1', '"10"', '1.5', 'NaN'] };
  });

  await test('P7 검토창 취소는 재고·localStorage·스케줄 상태를 바꾸지 않는다', async () => {
    const runtime = createCleanRuntime();
    runtime.evaluate(`sortiesSpeed=[{id:'keep-speed'}]; sortiesBalance=[{id:'keep-balance'}];`);
    const beforeInventory = inventorySnapshot(runtime);
    const beforeSchedules = clone(runtime.evaluate('[sortiesSpeed, sortiesBalance, sortiesBulk]'));
    const beforeStore = clone(runtime.store);
    runtime.context.__patch = { type: 'master_inventory_patch', version: 1, items: { '해적선 돛대': 33 } };
    runtime.evaluate('showMasterInventoryPatchReview(__patch); closeScanReview();');
    assert.deepStrictEqual(inventorySnapshot(runtime), beforeInventory);
    assert.deepStrictEqual(clone(runtime.evaluate('[sortiesSpeed, sortiesBalance, sortiesBulk]')), beforeSchedules);
    assert.deepStrictEqual(runtime.store, beforeStore);
    return { inventoryChanges: 0, storageChanges: 0, scheduleChanges: 0 };
  });

  await test('P8 잘못된 version/items 구조와 지원하지 않는 객체 JSON을 안내한다', async () => {
    const runtime = createCleanRuntime();
    const before = inventorySnapshot(runtime);
    runtime.context.__bad = { type: 'master_inventory_patch', version: 2, items: [] };
    runtime.evaluate('showMasterInventoryPatchReview(__bad)');
    assert.strictEqual(runtime.element('scanReviewApplyButton').disabled, true);
    assert(runtime.element('scanReviewBody').innerHTML.includes('version'));
    await pasteText(runtime, JSON.stringify({ type: 'different_json', version: 1 }));
    assert(runtime.diagnostics.alerts.some(message => message.includes('지원하지 않는 JSON')));
    assert.deepStrictEqual(inventorySnapshot(runtime), before);
    return { invalidPatchBlocked: true, unsupportedJsonAlerted: true };
  });

  await test('P9 적용 시 inventory 저장 외 물교·스케줄·설정 상태를 변경하지 않는다', async () => {
    const runtime = createRuntime(HTML, BACKUP);
    const beforeTrades = clone(runtime.evaluate('scannedTrades'));
    const beforeSchedules = clone(runtime.evaluate('[sortiesSpeed, sortiesBalance, sortiesBulk]'));
    const beforeConfig = clone(runtime.evaluate('APP_CONFIG'));
    const beforeStore = clone(runtime.store);
    runtime.context.__patch = { type: 'master_inventory_patch', version: 1, items: { '해적선 돛대': 33 } };
    runtime.evaluate('showMasterInventoryPatchReview(__patch); applyScanReview();');
    assert.deepStrictEqual(clone(runtime.evaluate('scannedTrades')), beforeTrades);
    assert.deepStrictEqual(clone(runtime.evaluate('[sortiesSpeed, sortiesBalance, sortiesBulk]')), beforeSchedules);
    assert.deepStrictEqual(clone(runtime.evaluate('APP_CONFIG')), beforeConfig);
    const changedStorageKeys = Object.keys(runtime.store).filter(key => runtime.store[key] !== beforeStore[key]);
    assert.deepStrictEqual(changedStorageKeys, ['bdoInventoryState']);
    return { changedStorageKeys };
  });

  await test('P10 기존 물교 입력과 스케줄러 핵심 소스 해시가 동일하다', async () => {
    const html = fs.readFileSync(HTML, 'utf8');
    const tradeHash = sha256(sourceRange(html, 'function processParsedTrades', 'function openCaptureModal'));
    const schedulerHash = sha256(sourceRange(html, 'function runAlgorithmAllModes', 'window.completeTradeAndTimer'));
    assert.strictEqual(tradeHash, EXPECTED_TRADE_IMPORT_SHA256);
    assert.strictEqual(schedulerHash, EXPECTED_SCHEDULER_SHA256);
    return { processParsedTradesSha256: tradeHash, schedulerSha256: schedulerHash };
  });

  const output = path.join(ROOT, 'test_results', 'master_inventory_patch_regression.json');
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

run().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
