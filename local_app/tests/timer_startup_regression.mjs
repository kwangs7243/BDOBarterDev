import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../frontend/js/domain/timer-ui.js", import.meta.url), "utf8");
let tick, now = 1000, alarms = 0;
const nodes = new Map();
const context = vm.createContext({
  window: {}, Date: { now: () => now },
  setInterval(callback) { tick = callback; },
  document: { getElementById: (id) => nodes.get(id) },
  playAlarmSound() { alarms++; },
});
vm.runInContext(source, context);
assert.doesNotThrow(() => tick(), "slow script loading does not read an undeclared schedule");
vm.runInContext("let sortiesSpeed = [];", context);
assert.doesNotThrow(() => tick(), "both schedules must be initialized before ticking");
vm.runInContext("let sortiesBalance = [];", context);
const trade = { island: "섬", toClean: "품목", timerActive: true, completed: false, timerEnd: 61000, alarmPlayed: false };
context.trade = trade;
vm.runInContext("sortiesSpeed.push({trades:[trade]});", context);
const node = () => ({ innerHTML: "", classList: { add() {}, remove() {} } });
nodes.set("timer_speed_0_0", node());
nodes.set("timer_return_speed_0", node());
context.window.ACTIVE_TIMERS["섬_품목"] = { endTime: 61000, played: false };
context.window.ACTIVE_TIMERS.return_speed_0 = { endTime: 31000, played: false };
tick();
assert.equal(nodes.get("timer_speed_0_0").innerHTML, "⏱️ 01:00");
assert.equal(nodes.get("timer_return_speed_0").innerHTML, "⏱️ 00:30");
assert.equal(alarms, 0);
now = 62000;
tick();
assert.equal(nodes.get("timer_speed_0_0").innerHTML, "⏱️ 00:00");
assert.equal(nodes.get("timer_return_speed_0").innerHTML, "⏱️ 00:00");
assert.equal(alarms, 2);
assert.equal(trade.alarmPlayed, true);
assert.equal(context.window.ACTIVE_TIMERS["섬_품목"].played, true);
assert.equal(context.window.ACTIVE_TIMERS.return_speed_0.played, true);
tick();
assert.equal(alarms, 2, "completed alarms do not repeat");
console.log("PASS: delayed schedule initialization, trade/return countdown and one-time alarms");
