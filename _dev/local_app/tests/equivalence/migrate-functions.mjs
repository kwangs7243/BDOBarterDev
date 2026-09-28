import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findFunctionDefinitions, normalizeFunctionBody, sha256 } from "./source-tools.mjs";

const root = resolve(import.meta.dirname, "../../..");
const source = await readFile(resolve(root, "BDO_물교_v1.0.html"), "utf8");
const baselinePath = resolve(import.meta.dirname, "baseline-manifest.json");
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
if (sha256(source) !== baseline.sourceSha256) throw new Error("Reference HTML differs from the captured SPEC-000 source.");

const groups = {
  T002: { file: "constants.js", functions: ["getItemTier", "getItemWeight"], insertBefore: "// DOMAIN_CONSTANTS_MIGRATED" },
  T003: { file: "scheduler.js", functions: ["runAlgorithmAllModes", "buildSorties"] },
  T004: { file: "tier7.js", functions: ["buildTier7Sorties"] },
  T005: { file: "routing.js", functions: ["calculateTravelTime", "getIslandCoords", "getPermutations", "getOptimalRoute", "optimizeRouteTSP", "sortFixedOcean", "getIslandRegion", "getAllowedRegions", "applyOceanCurrent", "legDistance", "simulateWeightsTemp", "getDistToSegment", "formatTimeExact"] },
  T006: { file: "schedule-edit.js", functions: ["routeDragStart", "routeDragEnd", "routeDragOver", "routeDrop", "adjustTradeCount", "rebuildSortieReq", "applySortieRecompute", "mergeAdjacentDupTrades", "sortieDragStart", "sortieDragEnd", "sortieDragOver", "sortieDrop"] },
  T007: { file: "completion.js", functions: ["completeTradeAndTimer", "openWaypointModal", "removeWaypoint", "completeWaypoint", "playAlarmSound", "completeTrade"] },
  T007_EXTRA: { file: "completion.js", functions: ["renderWaypointCard", "closeWaypointModal", "toggleWaypointMaterial", "confirmWaypoint"], appendToMarker: 'window.__SPEC005_SCRIPT_LOADED["completion.js"] = true;' },
  T007_TIMER: { file: "timer-ui.js", functions: ["toggleTimer", "toggleReturnTimer"], timerTick: true },
};

const task = process.argv[2];
const group = groups[task];
if (!group) throw new Error(`Choose a migration task: ${Object.keys(groups).join(", ")}`);
const destination = resolve(root, "local_app/frontend/js/domain", group.file);
let existing = "";
try { existing = await readFile(destination, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (task === "T002") {
  if (!existing.includes("// DOMAIN_CONSTANTS_MIGRATED")) throw new Error("constants.js migration marker is missing.");
  if (existing.includes("/* SPEC-005 T002 FUNCTIONS */")) throw new Error("T002 functions already inserted.");
} else if (task === "T007_EXTRA") {
  if (!existing.includes('window.__SPEC005_SCRIPT_LOADED["completion.js"] = true;')) throw new Error("completion.js loaded marker is missing.");
  if (existing.includes("/* SPEC-005 T007 EXTRA FUNCTIONS */")) throw new Error("T007 extra functions already inserted.");
} else if (existing) {
  throw new Error(`${destination} already exists; refusing to overwrite.`);
}

const definitions = group.functions.map((name) => {
  const expected = baseline.definitions.find((item) => item.name === name);
  if (!expected) throw new Error(`No source baseline for ${name}`);
  const sourceDefinitions = findFunctionDefinitions(source, name);
  const selected = sourceDefinitions.at(-1);
  if (!selected || selected.line !== expected.selectedLine || sourceDefinitions.length !== expected.definitionCount) throw new Error(`Definition selection changed for ${name}`);
  const bodyHash = sha256(normalizeFunctionBody(selected.body));
  if (bodyHash !== expected.bodyNormalizedSha256) throw new Error(`Source body hash changed for ${name}`);
  const suffix = source[selected.close + 1] === ";" ? ";" : "";
  return { name, definition: `${selected.source}${suffix}`, bodyHash, sourceLine: selected.line };
});

let timerTick = "";
if (group.timerTick) {
  const tick = baseline.timerTick;
  const start = source.indexOf(tick.sourceStart);
  const end = source.indexOf(tick.sourceEndExclusive, start);
  timerTick = source.slice(start, end).trim();
  if (sha256(timerTick) !== tick.sha256) throw new Error("Timer tick block differs from the T001 source baseline.");
}
const activeTimers = group.timerTick ? "window.ACTIVE_TIMERS = window.ACTIVE_TIMERS || {};\n" : "";
const block = `/* SPEC-005 ${task} FUNCTIONS — copied from the selected final definitions in BDO_물교_v1.0.html. */\n${activeTimers}${definitions.map((item) => item.definition).join("\n\n")}\n${timerTick}\n`;
if (task === "T002") {
  const marker = "// DOMAIN_CONSTANTS_MIGRATED";
  existing = existing.replace(marker, `${block}${marker}`);
  await writeFile(destination, existing, "utf8");
} else {
  if (task === "T007_EXTRA") {
    existing = existing.replace(group.appendToMarker, `${block}${group.appendToMarker}`);
    await writeFile(destination, existing, "utf8");
  } else {
    await writeFile(destination, `${block}\nwindow.__SPEC005_SCRIPT_LOADED = window.__SPEC005_SCRIPT_LOADED || {}; window.__SPEC005_SCRIPT_LOADED[${JSON.stringify(group.file)}] = true;\n`, "utf8");
  }
}
console.log(JSON.stringify({ task, destination, migrated: definitions.map(({ name, bodyHash, sourceLine }) => ({ name, bodyHash, sourceLine })) }, null, 2));
