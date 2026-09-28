import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findFunctionDefinitions, findVariableDeclaration, normalizeFunctionBody, sha256, sha256TextEol } from "./source-tools.mjs";

const root = resolve(import.meta.dirname, "../../..");
const sourcePath = resolve(root, "BDO_물교_v1.0.html");
const expected = JSON.parse(await readFile(resolve(root, "specs/000-baseline/baseline-manifest.json"), "utf8"));
const previousManifest = JSON.parse(await readFile(resolve(import.meta.dirname, "baseline-manifest.json"), "utf8"));
const source = await readFile(sourcePath, "utf8");
const sourceHash = sha256TextEol(source);
const normalizedExpected = expected.referenceImplementation.sha256.toLowerCase();
if (sourceHash !== normalizedExpected) {
  throw new Error(`Current HTML does not match SPEC-000 baseline: ${sourceHash} != ${normalizedExpected}`);
}

const functionNames = [
  "calculateTravelTime", "getItemTier", "getItemWeight", "getIslandCoords", "getPermutations",
  "getOptimalRoute", "optimizeRouteTSP", "runAlgorithmAllModes", "sortFixedOcean", "getIslandRegion",
  "getAllowedRegions", "buildSorties", "buildTier7Sorties", "applyOceanCurrent", "legDistance",
  "simulateWeightsTemp", "getDistToSegment", "formatTimeExact", "routeDragStart", "routeDragEnd", "routeDragOver",
  "routeDrop", "adjustTradeCount", "completeTradeAndTimer", "rebuildSortieReq", "applySortieRecompute",
  "mergeAdjacentDupTrades", "toggleTimer", "renderWaypointCard", "openWaypointModal", "closeWaypointModal",
  "toggleWaypointMaterial", "confirmWaypoint", "removeWaypoint", "completeWaypoint", "toggleReturnTimer",
  "playAlarmSound", "completeTrade", "sortieDragStart", "sortieDragEnd", "sortieDragOver", "sortieDrop",
];

const allFunctionNames = new Set([...source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
for (const match of source.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=\s*function\s*\(/g)) allFunctionNames.add(match[1]);
const globals = [
  "APP_CONFIG", "masterData", "rawData", "islandCoordinates", "defaultRouteCalibrations", "REGION_MAP",
  "inventory", "scannedTrades", "tierRules", "sortiesSpeed", "sortiesBalance", "maxParley",
  "shipPresets", "routeCalibrations", "customIslandCoordinates", "draggedRoute", "draggedSortie",
  "ACTIVE_TIMERS", "ENGINE_DEBUG", "__lastGen",
];

const functions = functionNames.map((name) => {
  const definitions = findFunctionDefinitions(source, name);
  if (!definitions.length) throw new Error(`Protected function missing: ${name}`);
  const selected = definitions.at(-1);
  const normalized = normalizeFunctionBody(selected.body);
  const calls = [...new Set([...normalized.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))]
    .filter((candidate) => allFunctionNames.has(candidate)).sort();
  return {
    name,
    source: "BDO_물교_v1.0.html",
    definitionLines: definitions.map((d) => d.line),
    selectedLine: selected.line,
    selectedIsFinalDefinition: true,
    definitionCount: definitions.length,
    directFunctionCalls: calls,
    referencedGlobals: globals.filter((globalName) => new RegExp(`\\b${globalName}\\b`).test(selected.body)),
    usesDocument: /\bdocument\./.test(selected.body),
    windowReferences: [...new Set([...selected.body.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))].sort(),
    bodyNormalizedSha256: sha256(normalized),
  };
});

const regions = expected.protectedRegions.map((region) => {
  const start = source.indexOf(region.start);
  const end = source.indexOf(region.endExclusive, start);
  if (start < 0 || end <= start) throw new Error(`Protected region markers missing: ${region.id}`);
  const actual = sha256TextEol(source.slice(start, end));
  if (actual !== region.sha256) throw new Error(`Protected region changed: ${region.id} ${actual} != ${region.sha256}`);
  return { id: region.id, start: region.start, endExclusive: region.endExclusive, sha256: actual, hashBasis: "sha256-utf8-crlf-to-lf-only", matchesSpec000: true };
});

const constants = ["APP_CONFIG", "masterData", "rawData", "islandCoordinates", "defaultRouteCalibrations", "REGION_MAP"].map((name) => {
  const declaration = findVariableDeclaration(source, name);
  return { name, source: "BDO_물교_v1.0.html", line: declaration.line, sourceSha256: sha256TextEol(declaration.source) };
});
const timerTickStart = source.indexOf(previousManifest.timerTick.sourceStart);
const timerTickEndToken = "}, 1000);";
const timerTickEnd = source.indexOf(timerTickEndToken, timerTickStart);
if (timerTickStart < 0 || timerTickEnd <= timerTickStart) throw new Error("Timer tick source markers missing.");
const timerTick = source.slice(timerTickStart, timerTickEnd + timerTickEndToken.length);

const output = {
  spec: "SPEC-005",
  source: "BDO_물교_v1.0.html",
  sourceSha256: sourceHash,
  baselineSourceSha256: normalizedExpected,
  normalization: "Text hashes replace CRLF pairs with LF only before SHA-256 UTF-8; no trim, whitespace, code, or data normalization.",
  hashBasis: {
    source: "sha256-utf8-crlf-to-lf-only",
    functionBodies: "sha256-utf8-crlf-to-lf-only",
    constantDeclarations: "sha256-utf8-crlf-to-lf-only",
    timerTick: "sha256-utf8-crlf-to-lf-only",
    protectedRegions: "sha256-utf8-crlf-to-lf-only",
  },
  definitions: functions,
  constants,
  timerTick: { sourceStart: previousManifest.timerTick.sourceStart, sourceEndInclusive: timerTickEndToken, sha256: sha256TextEol(timerTick) },
  protectedRegions: regions,
};
const outputPath = resolve(import.meta.dirname, "baseline-manifest.json");
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: outputPath, sourceSha256: sourceHash, functions: functions.length, definitions: functions.map(({ name, definitionCount, selectedLine }) => ({ name, definitionCount, selectedLine })), protectedRegions: regions }, null, 2));
