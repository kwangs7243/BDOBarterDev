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
const HTML = process.env.BDO_HTML ? path.resolve(process.env.BDO_HTML) : DEFAULT_HTML;
const BACKUP = readJson('inputs/ORIGINAL_user_backup_20260923.json');
const USER_ROWS = readJson('fixtures/USER_CAPTURE_20260923_74_ROWS.json');

const REGION_BY_T6_ISLAND = {
  '하코번 섬': 'east',
  '아레하자 마을': 'east',
  '해모 섬': 'west',
  '달래나루': 'west',
  '그란디하': 'south',
  '깊은 밤의 항구': 'south',
};
const BASE_ALLOWED = new Set(['필바라 섬', '푸자라 섬', '바레미 섬', '아지르 섬']);
const SOUTH_EXTRA = new Set(['오르프스 섬', '발베쥬 섬', '나르보 섬', '파딕스 섬', '오벤 섬', '시오닐 섬', '라메다 섬']);

const tier6Rows = USER_ROWS.filter(row => REGION_BY_T6_ISLAND[row.island]);
const tier5Items = tier6Rows.map(row => row.fromItem);
const producerRows = tier6Rows.map(row => USER_ROWS.find(candidate => candidate.toItem === row.fromItem));

function prepareSnapshot(mutator) {
  const snapshot = clone(BACKUP);
  snapshot.scannedTrades = [];
  snapshot.savedSchedules = {};
  snapshot.appConfig.ALLOW_OCEAN = 't7_3region';
  snapshot.ui = {
    ...(snapshot.ui || {}),
    maxParley: '1250000',
    parleyPerTrade: String(snapshot.appConfig.PARLEY_PER_TRADE),
    parleyCrow: String(snapshot.appConfig.CROW_PARLEY),
    normalWeight: String((snapshot.ui || {}).normalWeight || 14379),
    maxWeight: String((snapshot.ui || {}).maxWeight || 24445),
    allowOcean: 't7_3region',
  };
  if (mutator) mutator(snapshot);
  return snapshot;
}

function runSnapshot(snapshot) {
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

function regionForCard(card) {
  return REGION_BY_T6_ISLAND[card.island]
    || (card.island === '소산 주둔지 선착장' || card.island === '성전 해안 정찰지' ? 'east'
      : (card.island === '레마 섬' || card.island === '일리야 섬' ? 'west' : 'south'));
}

function summarize(runtime, mode) {
  const cards = scheduleTrades(runtime, mode);
  const relevant = cards.filter(card =>
    (card.fromTier === 4 && card.toTier === 5)
    || (card.fromTier === 5 && card.toTier === 6)
    || (card.fromTier === 6 && card.toTier === 7)
    || card.isCoin
  );
  const regions = { east: { tier56: 0, tier67: 0 }, west: { tier56: 0, tier67: 0 }, south: { tier56: 0, tier67: 0 } };
  relevant.forEach(card => {
    const region = regionForCard(card);
    if (card.fromTier === 5 && card.toTier === 6 && regions[region]) regions[region].tier56 += card.execC;
    if (card.fromTier === 6 && card.toTier === 7 && regions[region]) regions[region].tier67 += card.execC;
  });
  return {
    normalWeight: Number(runtime.element('normalWeight').value),
    maxWeight: Number(runtime.element('maxWeight').value),
    tier45: relevant.filter(card => card.fromTier === 4 && card.toTier === 5)
      .map(card => ({ island: card.island, from: card.from, to: card.to, execC: card.execC })),
    tier56: relevant.filter(card => card.fromTier === 5 && card.toTier === 6)
      .map(card => ({ region: regionForCard(card), island: card.island, from: card.from, execC: card.execC })),
    tier67: relevant.filter(card => card.fromTier === 6 && card.toTier === 7)
      .map(card => ({ region: regionForCard(card), island: card.island, from: card.from, execC: card.execC })),
    regions,
    totalTier7: relevant.filter(card => card.fromTier === 6 && card.toTier === 7)
      .reduce((sum, card) => sum + card.execC * card.mult, 0),
    crow: relevant.filter(card => card.isCoin)
      .map(card => ({ island: card.island, execC: card.execC, yield: card.mult })),
  };
}

function scenario(name, mutator) {
  const runtime = runSnapshot(prepareSnapshot(mutator));
  return { name, speed: summarize(runtime, 'speed'), balance: summarize(runtime, 'balance') };
}

function setT5(snapshot, values) {
  tier5Items.forEach(item => { snapshot.state[item].stock = values[item] ?? values.default; });
}

function setProducerStock(snapshot, value) {
  producerRows.forEach(row => {
    if (row && snapshot.state[row.fromItem]) snapshot.state[row.fromItem].stock = value;
  });
}

function thresholdTable() {
  return tier6Rows.map(row => {
    const region = REGION_BY_T6_ISLAND[row.island];
    const producer = USER_ROWS.find(candidate => candidate.toItem === row.fromItem);
    const producerAllowed = !!producer && (BASE_ALLOWED.has(producer.island) || (region === 'south' && SOUTH_EXTRA.has(producer.island)));
    return {
      region,
      tier56Island: row.island,
      tier5Item: row.fromItem,
      requiredForFive: 5 * Number(row.reqAmount || 1),
      currentTier5Stock: BACKUP.state[row.fromItem].stock,
      tier5Target: BACKUP.state[row.fromItem].target,
      producerIsland: producer ? producer.island : null,
      producerInput: producer ? producer.fromItem : null,
      producerRemainingExchanges: producer ? (producer.count >= 5 ? 5 : 0) : null,
      producerInputRequiredForFullRow: producer ? (producer.count >= 5 ? 5 * producer.reqAmount : 0) : null,
      currentProducerInputStock: producer && BACKUP.state[producer.fromItem] ? BACKUP.state[producer.fromItem].stock : null,
      producerAllowedInRegion: producerAllowed,
    };
  });
}

function run() {
  const current = scenario('current_inventory');
  const fiveDirect = scenario('all_required_t5_at_least_5', snapshot => {
    tier5Items.forEach(item => { snapshot.state[item].stock = Math.max(5, snapshot.state[item].stock); });
  });
  const fiveDirectAndSpeedWeight = scenario('all_required_t5_at_least_5_and_normal_weight_20000', snapshot => {
    tier5Items.forEach(item => { snapshot.state[item].stock = Math.max(5, snapshot.state[item].stock); });
    snapshot.ui.normalWeight = '20000';
  });
  const producersOnly = scenario('zero_t5_all_producer_inputs_5_weight_20000', snapshot => {
    setT5(snapshot, { default: 0 });
    setProducerStock(snapshot, 5);
    snapshot.ui.normalWeight = '20000';
  });
  const mixedThreshold = scenario('east_t5_5_west_south_producer_inputs_5_weight_20000', snapshot => {
    setT5(snapshot, {
      default: 0,
      '팔랑나비 박제품': 5,
      '흰색 애벌레 박제품': 5,
    });
    setProducerStock(snapshot, 5);
    snapshot.ui.normalWeight = '20000';
  });

  const lowControl = scenario('control_low_targets_and_reserve', snapshot => {
    snapshot.rules[5] = 1;
    tier5Items.forEach(item => { snapshot.state[item].target = 0; });
  });
  const highControl = scenario('control_high_targets_and_reserve', snapshot => {
    snapshot.rules[5] = 100;
    tier5Items.forEach(item => { snapshot.state[item].target = 999; });
  });

  const signature = result => JSON.stringify({ speed: result.speed.regions, balance: result.balance.regions });
  const report = {
    generatedAt: new Date().toISOString(),
    html: path.relative(ROOT, HTML),
    currentSettings: {
      normalWeight: current.speed.normalWeight,
      maxWeight: current.balance.maxWeight,
      maxParley: 1250000,
      parleyPerTrade: BACKUP.appConfig.PARLEY_PER_TRADE,
      crowParley: BACKUP.appConfig.CROW_PARLEY,
      tier5Reserve: BACKUP.rules[5],
    },
    thresholds: thresholdTable(),
    scenarios: [current, fiveDirect, fiveDirectAndSpeedWeight, producersOnly, mixedThreshold],
    reserveTargetControl: {
      low: lowControl,
      high: highControl,
      tier67ScheduleUnchanged: signature(lowControl) === signature(highControl),
    },
    conclusions: {
      directTier5RequiredPerRow: 5,
      producerInputRequiredPerCurrentFullRow: 5,
      weightRequiredPerRegionForTenTier7: 20000,
      baseParleyForThirtyWithoutRefillOrCrow: 60 * BACKUP.appConfig.PARLEY_PER_TRADE,
      tier5ReserveAndTargetControlTier7MainChain: false,
    },
  };

  const outputIndex = process.argv.indexOf('--json-out');
  const output = outputIndex >= 0
    ? path.resolve(process.argv[outputIndex + 1])
    : path.join(ROOT, 'test_results', 'tier7_threshold_diagnostics.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    currentSpeedTier7: current.speed.totalTier7,
    currentBalanceTier7: current.balance.totalTier7,
    fiveDirectSpeedTier7: fiveDirect.speed.totalTier7,
    fiveDirectBalanceTier7: fiveDirect.balance.totalTier7,
    speedWeight20000Tier7: fiveDirectAndSpeedWeight.speed.totalTier7,
    producerOnlyBalanceTier7: producersOnly.balance.totalTier7,
    mixedThresholdBalanceTier7: mixedThreshold.balance.totalTier7,
    reserveTargetUnchanged: report.reserveTargetControl.tier67ScheduleUnchanged,
  }, null, 2));
}

run();
