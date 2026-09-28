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
const LOW = readJson('fixtures/TEST_ONLY_corrected_low_stock.json');
const YIELD8 = readJson('fixtures/KNOWN_YIELD_MISMATCHES_8.json');

function configure(runtime, { controlled = false } = {}) {
  runtime.evaluate(`
    APP_CONFIG.ALLOW_OCEAN = 'none';
    if (${controlled}) {
      scannedTrades.forEach(t => {
        const tier = inventory[t.toItem] ? inventory[t.toItem].tier : getItemTier(t.toItem);
        if (tier === 5 || getItemTier(t.toItem) === 'mat' || getItemTier(t.toItem) === 'coin') t.disabled = true;
      });
    }
    runAlgorithmAllModes(true);
  `);
}

function reserveAudit(runtime, mode = 'speed') {
  const cards = scheduleTrades(runtime, mode);
  const stock = clone(runtime.evaluate('Object.fromEntries(Object.entries(inventory).map(([name,value])=>[name,value.stock]))'));
  const rules = clone(runtime.evaluate('tierRules'));
  const events = [];
  for (const card of cards) {
    const before = stock[card.from] === undefined ? null : stock[card.from];
    const cost = card.execC * card.reqA;
    const reserve = typeof card.fromTier === 'number' && card.fromTier >= 1 && card.fromTier <= 5
      ? Number(rules[card.fromTier] || (card.fromTier === 5 ? 1 : 20))
      : 0;
    const allowedException = card.isSpec || card.isRandomCoin || card.isCoin
      || (card.toTier === 5 && (card.isUrgent || card.isConsumedByT7));
    if (before !== null && card.fromTier !== 0) {
      const after = before - cost;
      if (after < reserve) {
        events.push({
          sortie: card.sortieIndex + 1,
          card: card.tradeIndex + 1,
          island: card.island,
          item: card.from,
          before,
          cost,
          after,
          reserve,
          startedBelowReserve: before < reserve,
          allowedException,
          chained: card.isChained,
          toTier: card.toTier,
        });
      }
      stock[card.from] = Math.max(0, after);
    }
    if (stock[card.to] !== undefined) stock[card.to] += card.execC * card.mult;
  }
  return { cards: cards.length, sorties: Math.max(0, ...cards.map(card => card.sortieIndex + 1)), events, finalStock: stock };
}

function completeAll(runtime, mode = 'speed') {
  const arrayName = mode === 'speed' ? 'sortiesSpeed' : 'sortiesBalance';
  const shape = clone(runtime.evaluate(`${arrayName}.map(s => s.trades.map(t => ({from:t.fromClean,to:t.toClean,fromTier:t.fromTier,reqA:t.reqA,execC:t.execC,idx:t.originalIndex,isWaypoint:!!t.isWaypoint})))`));
  const events = [];
  shape.forEach((sortie, sortieIndex) => sortie.forEach((card, tradeIndex) => {
    if (card.isWaypoint) return;
    const beforeFrom = runtime.evaluate(`inventory[${JSON.stringify(card.from)}]?.stock ?? null`);
    const beforeTo = runtime.evaluate(`inventory[${JSON.stringify(card.to)}]?.stock ?? null`);
    runtime.evaluate(`window.completeTrade(document.getElementById('complete-${sortieIndex}-${tradeIndex}'), ${JSON.stringify(mode)}, ${sortieIndex}, ${tradeIndex}, ${card.idx})`);
    const afterFrom = runtime.evaluate(`inventory[${JSON.stringify(card.from)}]?.stock ?? null`);
    const afterTo = runtime.evaluate(`inventory[${JSON.stringify(card.to)}]?.stock ?? null`);
    const completed = runtime.evaluate(`${arrayName}[${sortieIndex}].trades[${tradeIndex}].completed`);
    events.push({ sortie: sortieIndex + 1, card: tradeIndex + 1, from: card.from, to: card.to, beforeFrom, afterFrom, beforeTo, afterTo, completed });
  }));
  return {
    events,
    inventory: clone(runtime.evaluate('inventory')),
    parley: runtime.element('maxParley').value,
  };
}

function correctedScenario(controlled) {
  const runtime = createRuntime(FIXED, LOW);
  configure(runtime, { controlled });
  const initial = {
    speed: reserveAudit(runtime, 'speed'),
    balance: reserveAudit(runtime, 'balance'),
  };

  const batchRuntime = createRuntime(FIXED, LOW);
  configure(batchRuntime, { controlled });
  const batch = completeAll(batchRuntime, 'speed');

  const sequentialRuntime = createRuntime(FIXED, LOW);
  configure(sequentialRuntime, { controlled });
  const firstShape = clone(sequentialRuntime.evaluate('sortiesSpeed[0] ? sortiesSpeed[0].trades.map(t=>({idx:t.originalIndex,isWaypoint:!!t.isWaypoint})) : []'));
  firstShape.forEach((card, tradeIndex) => {
    if (!card.isWaypoint) sequentialRuntime.evaluate(`window.completeTrade(document.getElementById('first-${tradeIndex}'),'speed',0,${tradeIndex},${card.idx})`);
  });
  sequentialRuntime.evaluate('runAlgorithmAllModes(true)');
  const replanned = {
    speed: reserveAudit(sequentialRuntime, 'speed'),
    balance: reserveAudit(sequentialRuntime, 'balance'),
    parley: sequentialRuntime.element('maxParley').value,
  };
  const second = sequentialRuntime.evaluate('sortiesSpeed.length > 0') ? completeAll(sequentialRuntime, 'speed') : null;
  return { controlled, initial, batch, replanned, second };
}

function staleCompletionObservation(htmlPath) {
  const row = clone(YIELD8.find(item => item.island === '타슈 섬'));
  const snapshot = clone(LOW);
  snapshot.scannedTrades = [row];
  snapshot.savedSchedules = {};
  snapshot.appConfig.ALLOW_OCEAN = 'none';
  snapshot.ui.allowOcean = 'none';
  snapshot.ui.maxParley = '1250000';
  snapshot.ui.parleyPerTrade = '10000';
  snapshot.ui.normalWeight = '50000';
  snapshot.ui.maxWeight = '85000';
  snapshot.state[row.fromItem].stock = 100;
  snapshot.state[row.toItem].stock = 20;
  snapshot.state[row.toItem].target = 100;

  const runtime = createRuntime(htmlPath, snapshot);
  runtime.evaluate("APP_CONFIG.ALLOW_OCEAN='none';runAlgorithmAllModes(true);");
  const card = scheduleTrades(runtime, 'speed').find(item => item.originalIndex === 0);
  if (!card) throw new Error('stale completion setup did not produce a card');
  runtime.evaluate(`inventory[${JSON.stringify(row.fromItem)}].stock=0;saveInventoryState();`);
  const beforeOutput = runtime.evaluate(`inventory[${JSON.stringify(row.toItem)}].stock`);
  runtime.evaluate(`window.completeTrade(document.getElementById('stale'),'speed',${card.sortieIndex},${card.tradeIndex},0)`);
  return {
    required: card.execC * card.reqA,
    available: 0,
    outputBefore: beforeOutput,
    outputAfter: runtime.evaluate(`inventory[${JSON.stringify(row.toItem)}].stock`),
    completed: runtime.evaluate(`sortiesSpeed[${card.sortieIndex}].trades[${card.tradeIndex}].completed`),
    tradeRemaining: runtime.evaluate('scannedTrades[0].count'),
    toasts: clone(runtime.diagnostics.toasts),
  };
}

function run() {
  const report = {
    generatedAt: new Date().toISOString(),
    correctedLowStock: {
      allActive: correctedScenario(false),
      controlledNoTier5SpecialCoin: correctedScenario(true),
    },
    staleCompletion: {
      original: staleCompletionObservation(ORIGINAL),
      fixedCurrent: staleCompletionObservation(FIXED),
    },
  };

  const outputIndex = process.argv.indexOf('--json-out');
  if (outputIndex >= 0) {
    const output = path.resolve(process.argv[outputIndex + 1]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
}

run();
