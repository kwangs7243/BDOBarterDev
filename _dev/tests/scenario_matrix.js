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
const FIXTURES = {
  A: 'fixtures/TEST_ONLY_corrected_low_stock.json',
  B: 'fixtures/TEST_ONLY_synthetic_T4_25_each.json',
  C: 'fixtures/TEST_ONLY_synthetic_T1T4_full_T5_original.json',
  D: 'fixtures/TEST_ONLY_synthetic_target_full_stock.json',
};

function simulate(runtime, cards) {
  const stock = clone(runtime.evaluate('Object.fromEntries(Object.entries(inventory).map(([name,value])=>[name,value.stock]))'));
  const rules = clone(runtime.evaluate('tierRules'));
  const unexpectedReserveViolations = [];
  for (const card of cards) {
    const cost = card.execC * card.reqA;
    if (card.fromTier !== 0 && stock[card.from] !== undefined) {
      const before = stock[card.from];
      const after = before - cost;
      const reserve = typeof card.fromTier === 'number' && card.fromTier >= 1 && card.fromTier <= 5
        ? Number(rules[card.fromTier] || (card.fromTier === 5 ? 1 : 20))
        : 0;
      const bulkBypass = (card.isSpec || card.isRandomCoin) && before >= reserve;
      const allowed = bulkBypass || card.isCoin || (card.toTier === 5 && (card.isUrgent || card.isConsumedByT7));
      if (after < reserve && !allowed) {
        unexpectedReserveViolations.push({ island: card.island, item: card.from, before, cost, after, reserve });
      }
      stock[card.from] = Math.max(0, after);
    }
    if (stock[card.to] !== undefined) stock[card.to] += card.execC * card.mult;
  }
  return { stock, unexpectedReserveViolations };
}

function summarize(runtime, mode) {
  const cards = scheduleTrades(runtime, mode);
  const sortiesName = mode === 'speed' ? 'sortiesSpeed' : 'sortiesBalance';
  const parleyUsed = runtime.evaluate(`${sortiesName}.reduce((sum,s)=>sum+s.parleyUsed,0)`);
  const maxParley = Number(runtime.element('maxParley').value || 0);
  const scheduledByOriginal = {};
  cards.forEach(card => { scheduledByOriginal[card.originalIndex] = (scheduledByOriginal[card.originalIndex] || 0) + card.execC; });
  const remaining = runtime.context.__matrixTrades.reduce((sum, trade, index) => sum + Math.max(0, Number(trade.count || 0) - (scheduledByOriginal[index] || 0)), 0);
  const simulated = simulate(runtime, cards);
  return {
    sorties: runtime.evaluate(`${sortiesName}.length`),
    cards: cards.length,
    exchanges: cards.reduce((sum, card) => sum + card.execC, 0),
    parleyUsed,
    parleyRemaining: maxParley - parleyUsed,
    remainingListExchanges: remaining,
    tier45Exchanges: cards.filter(card => card.fromTier === 4 && card.toTier === 5).reduce((sum, card) => sum + card.execC, 0),
    tier45Cards: cards.filter(card => card.fromTier === 4 && card.toTier === 5).length,
    coinExchanges: cards.filter(card => card.isCoin).reduce((sum, card) => sum + card.execC, 0),
    specialExchanges: cards.filter(card => card.isSpec).reduce((sum, card) => sum + card.execC, 0),
    unexpectedReserveViolations: simulated.unexpectedReserveViolations,
  };
}

function runScenario(snapshot, fixture, allowOcean, coinSetting, tier45Setting) {
  const runtime = createRuntime(FIXED, snapshot);
  runtime.evaluate(`
    APP_CONFIG.ALLOW_OCEAN = ${JSON.stringify(allowOcean)};
    const coinRows = scannedTrades.map((trade,index)=>({trade,index})).filter(x=>getItemTier(x.trade.toItem)==='coin');
    const preferredCoin = coinRows.find(x=>x.trade.island==='카슈마 섬') || coinRows[0];
    coinRows.forEach(x => { x.trade.disabled = ${JSON.stringify(coinSetting)} === 'off' || !preferredCoin || x.index !== preferredCoin.index; });
    scannedTrades.forEach(trade => {
      if (getItemTier(trade.fromItem) === 4 && getItemTier(trade.toItem) === 5) {
        trade.disabled = ${JSON.stringify(tier45Setting)} === 'off';
      }
    });
    window.__matrixTrades = JSON.parse(JSON.stringify(scannedTrades));
    runAlgorithmAllModes(true);
  `);
  runtime.context.__matrixTrades = clone(runtime.evaluate('window.__matrixTrades'));
  const selectedCoin = runtime.evaluate(`{
    const rows=scannedTrades.filter(t=>getItemTier(t.toItem)==='coin'&&!t.disabled);
    rows.length ? rows[0].island : null;
  }`);
  return {
    fixture,
    allowOcean,
    coinSetting,
    tier45Setting,
    selectedCoin,
    speed: summarize(runtime, 'speed'),
    balance: summarize(runtime, 'balance'),
  };
}

function run() {
  const fixtureArg = process.argv.includes('--fixture') ? process.argv[process.argv.indexOf('--fixture') + 1] : null;
  const fixtureKeys = fixtureArg ? [fixtureArg] : Object.keys(FIXTURES);
  const scenarios = [];
  for (const key of fixtureKeys) {
    if (!FIXTURES[key]) throw new Error(`unknown fixture key: ${key}`);
    const snapshot = readJson(FIXTURES[key]);
    for (const allowOcean of ['none', 'inner']) {
      for (const coinSetting of ['off', 'one']) {
        for (const tier45Setting of ['off', 'on']) {
          scenarios.push(runScenario(snapshot, key, allowOcean, coinSetting, tier45Setting));
        }
      }
    }
  }

  const report = { generatedAt: new Date().toISOString(), fixtureFiles: FIXTURES, scenarios };
  const outputIndex = process.argv.indexOf('--json-out');
  if (outputIndex >= 0) {
    const output = path.resolve(process.argv[outputIndex + 1]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  scenarios.forEach(row => {
    console.log(`${row.fixture} ocean=${row.allowOcean} coin=${row.coinSetting} 4to5=${row.tier45Setting} | speed sorties=${row.speed.sorties} exchanges=${row.speed.exchanges} 4to5=${row.speed.tier45Exchanges} | balance sorties=${row.balance.sorties} exchanges=${row.balance.exchanges} 4to5=${row.balance.tier45Exchanges}`);
  });
}

run();
