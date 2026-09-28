const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./engine_harness');

const HTML = process.env.BDO_HTML
  ? path.resolve(process.env.BDO_HTML)
  : path.join(ROOT, 'BDO_물교_v1.0.html');
const EXPECTED_SCHEDULER_SHA256 = '0c64f7a542a028045a91b4b67b6721103ccfd76a646d74af0a894a9ee4f7be31';

function schedulerSource(html) {
  const start = html.indexOf('function runAlgorithmAllModes');
  const end = html.indexOf('window.completeTradeAndTimer', start);
  assert(start >= 0 && end > start, '스케줄러 소스 구간을 찾지 못했습니다.');
  return html.slice(start, end);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readResult(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'test_results', name), 'utf8'));
}

function run() {
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: '완료 보류 제거 과정에서 기존 스케줄·경로·최소보존 판단을 변경하지 않았는지 별도 검증',
    tests: [],
  };

  function test(name, fn) {
    try {
      report.tests.push({ name, status: 'PASS', details: fn() });
    } catch (error) {
      report.tests.push({ name, status: 'FAIL', error: error.stack || String(error) });
    }
  }

  test('S1 스케줄러와 경로 생성 소스 해시가 승인된 기준과 동일하다', () => {
    const actual = sha256(schedulerSource(fs.readFileSync(HTML, 'utf8')));
    assert.strictEqual(actual, EXPECTED_SCHEDULER_SHA256);
    return { sha256: actual };
  });

  test('S2 최소보존·목표값 저·고 대조에서 7단 본대 수량이 동일하다', () => {
    const threshold = readResult('tier7_threshold_diagnostics.json');
    assert.strictEqual(threshold.reserveTargetControl.tier67ScheduleUnchanged, true);
    const low = threshold.reserveTargetControl.low;
    const high = threshold.reserveTargetControl.high;
    return {
      low: { speed: low.speed.totalTier7, balance: low.balance.totalTier7 },
      high: { speed: high.speed.totalTier7, balance: high.balance.totalTier7 },
      unchanged: true,
    };
  });

  test('S3 기존 32개 재고·모드 조합 결과를 그대로 보존한다', () => {
    const matrix = readResult('scenario_matrix.json');
    assert.strictEqual(matrix.scenarios.length, 32);
    const violations = matrix.scenarios.flatMap(scenario => [
      ...scenario.speed.unexpectedReserveViolations,
      ...scenario.balance.unexpectedReserveViolations,
    ]);
    assert.strictEqual(violations.length, 0);
    return { scenarios: 32, unexpectedReserveViolations: 0 };
  });

  const outputIndex = process.argv.indexOf('--json-out');
  const output = outputIndex >= 0
    ? path.resolve(process.argv[outputIndex + 1])
    : path.join(ROOT, 'test_results', 'scheduler_preservation_regression.json');
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
