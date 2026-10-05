import assert from 'node:assert/strict';
import vm from 'node:vm';
import {environment} from './scheduler_departure_causality.mjs';

function setup() {
  const {ctx} = environment();
  ctx.applyBdoPersistentConfig = () => {};
  const events = [];
  ctx.CustomEvent = class { constructor(type) { this.type = type; } };
  ctx.dispatchEvent = event => events.push(event.type);
  const app = {
    settings: {tierRules:{1:20,2:20,3:20,4:20,5:2},
      ship:{normalWeight:22689,maxWeight:40259,mode:'inner'},
      parley:{normalCost:10278,crowCost:15576,defaultBudget:1250000},tuning:{}},
    inventory:[{programName:'갈퀴 꽃 씨앗 주머니',stock:23,target:0},
      {programName:'괴생물 촉수',stock:0,target:20}], revision:1,
    session:{scannedTrades:[{island:'베이루와 섬',fromItem:'갈퀴 꽃 씨앗 주머니',
      toItem:'괴생물 촉수',count:3,reqAmount:1,yield:2}],remainingParley:1250000,timers:{}}
  };
  const generate = () => ctx.__bdoScheduleRuntime.generateSchedule(app, () => {});
  assert.equal(generate(), true);
  assert.ok(app.session.schedule.speed.length);
  assert.ok(app.session.schedule.balance.length);
  events.length = 0;
  return {ctx,app,events,generate};
}

const failures = [
  ['all disabled', app => app.session.scannedTrades[0].disabled = true],
  ['empty list', app => app.session.scannedTrades = []],
  ['invalid yield', app => app.session.scannedTrades[0].yield = null],
  ['zero budget', app => app.session.remainingParley = 0],
  ['insufficient budget', app => app.session.remainingParley = 1],
  ['invalid capacity', app => app.session.config.ship.normalWeight = 0],
  ['no eligible region', app => {
    app.session.config.ship.mode = 'none';
    Object.assign(app.session.scannedTrades[0], {toItem:'까마귀 주화',yield:100});
  }]
];
for (const [label,change] of failures) {
  const {app,events,generate} = setup();
  app.session.timers.return_speed_0 = {endTime:123,played:false};
  const previous = app.session.schedule, completed = app.session.completed;
  const diagnostics = app.session.diagnostics, timers = app.session.timers;
  change(app);
  const rows = JSON.stringify(app.session.scannedTrades), stock = JSON.stringify(app.inventory);
  assert.equal(generate(), false, label);
  assert.equal(app.session.schedule, previous, label);
  assert.equal(app.session.completed, completed, label);
  assert.equal(app.session.diagnostics, diagnostics, label);
  assert.equal(app.session.timers, timers, label);
  assert.equal(JSON.stringify(app.session.scannedTrades), rows, label);
  assert.equal(JSON.stringify(app.inventory), stock, label);
  assert.deepEqual(events, [], label);
}
{
  const {ctx,app,events,generate} = setup();
  const plan = JSON.stringify(app.session.schedule), stock = JSON.stringify(app.inventory);
  const rows = JSON.stringify(app.session.scannedTrades);
  app.session.timers.return_speed_0 = {endTime:123,played:false};
  app.session.timers.stale_trade = {endTime:123,played:false};
  for (let index = 0; index < 20; index++) {
    assert.equal(generate(), true);
    assert.equal(JSON.stringify(app.session.schedule), plan);
    assert.equal(Object.keys(app.session.timers).length, 0);
    assert.equal(app.session.timers, ctx.ACTIVE_TIMERS);
  }
  assert.equal(events.filter(type => type === 'bdo:timers-reset').length, 20);
  assert.equal(events.filter(type => type === 'bdo:session-changed').length, 20);
  assert.equal(JSON.stringify(app.inventory), stock);
  assert.equal(JSON.stringify(app.session.scannedTrades), rows);
  const speedObjects = new Set(app.session.schedule.speed.flatMap(s => [s,...s.trades]));
  assert.ok(app.session.schedule.balance.flatMap(s => [s,...s.trades]).every(x => !speedObjects.has(x)));
  const balance = JSON.stringify(app.session.schedule.balance);
  app.session.schedule.speed[0].trades[0].execC++;
  assert.equal(JSON.stringify(app.session.schedule.balance), balance);
  assert.equal(JSON.stringify(app.session.scannedTrades), rows);
  assert.ok(vm.runInContext('getRoutePermutationOrders.cache?.size || 0', ctx) <= 6);
}
console.log('PASS: 7 failed-generation cases preserve previous state; 20 regenerations reset timers, retain exact plans, and keep modes and source data independent');
