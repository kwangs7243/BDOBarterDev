import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findVariableDeclaration, sha256 } from "./source-tools.mjs";

const root = resolve(import.meta.dirname, "../../..");
const htmlPath = resolve(root, "BDO_물교_v1.0.html");
const outputPath = resolve(root, "local_app/frontend/js/domain/constants.js");
const settingsPath = resolve(root, "local_app/frontend/js/settings-ui.js");
const indexPath = resolve(root, "local_app/frontend/index.html");
const baseline = JSON.parse(await readFile(resolve(import.meta.dirname, "baseline-manifest.json"), "utf8"));
const source = await readFile(htmlPath, "utf8");
if (sha256(source) !== baseline.sourceSha256) throw new Error("Reference HTML no longer matches the captured SPEC-000 source baseline.");
const oldModule = await readFile(outputPath, "utf8");
if (!oldModule.startsWith("export const MODES") || oldModule.includes("DOMAIN_CONSTANTS_MIGRATED")) throw new Error("Unexpected constants.js state; refusing to overwrite it.");

const variable = (name) => findVariableDeclaration(source, name).source;
const appConfig = variable("APP_CONFIG");
const masterData = variable("masterData");
const rawData = variable("rawData");
const islandCoordinates = variable("islandCoordinates");
const routeCalibrations = variable("defaultRouteCalibrations");
const regionMap = variable("REGION_MAP");

const moduleConstants = `const MODES = ["none", "inner", "ocean", "t7_2region", "t7_2region_south", "t7_2region_arehazaX", "t7_3region"];
const MODE_LABELS = { none: "없음", inner: "내해", ocean: "대양", t7_2region: "7단 2지역", t7_2region_south: "7단 2지역(남부)", t7_2region_arehazaX: "7단 2지역(아레하자)", t7_3region: "7단 3지역" };
const TUNING_FIELDS = [
  ["specialMatPriority", "특수 재료 우선도", "integer"], ["crowCoinPriority", "까마귀주화 우선도", "integer"],
  ["pathEfficiencyBonus", "경로 효율 보너스", "integer"], ["smallTradePenalty", "소량 교환 페널티", "integer"],
  ["chainMaxDistance", "연속 경로 최대 거리", "integer"], ["chainBonusScore", "연속 경로 보너스", "integer"],
  ["distancePenaltyWeight", "거리 페널티 가중치", "number"], ["overloadPenalty", "과적 페널티", "number"],
  ["efficiencyThreshold", "효율 임계값", "integer"], ["iliyaPitstopRadius", "일리야 경유 반경", "integer"],
  ["overloadTimeWeight", "과적 시간 가중치", "number"], ["deficitRatioBonus", "부족 비율 보너스", "integer"],
  ["emergencyBonus", "긴급 보너스", "integer"], ["preservationBonus", "보존 보너스", "integer"],
  ["westBias", "서쪽 편향", "integer"], ["useClustering", "군집 가중치 (숫자)", "integer"]
];
const PANEL_IDS = ["mainPanel", "slotPanel", "routeListPanel", "coordChangesPanel", "memoListPanel", "routeCalibrationPanel"];
const EMPTY_SESSION_STATE = Object.freeze({ scannedTrades: null, schedule: null, completed: null, remainingParley: null, timers: null, selection: null, drag: null });

${appConfig}
${masterData}
${rawData}
${islandCoordinates}
${routeCalibrations}
${regionMap}

let routeCalibrations = { ...defaultRouteCalibrations };
window.BDO_CONSTANTS = { MODES, MODE_LABELS, TUNING_FIELDS, PANEL_IDS, EMPTY_SESSION_STATE };
window.APP_CONFIG = APP_CONFIG;
window.masterData = masterData;
window.islandCoordinates = islandCoordinates;
window.REGION_MAP = REGION_MAP;
window.applyBdoPersistentConfig = (settings) => {
  const config = settings || {};
  const ship = config.ship || {};
  const parley = config.parley || {};
  const tuning = config.tuning || {};
  const navigation = config.navigation || {};
  if (ship.speed !== undefined) APP_CONFIG.SHIP_SPEED = ship.speed;
  if (ship.mode !== undefined) APP_CONFIG.ALLOW_OCEAN = ship.mode;
  if (parley.normalCost !== undefined) APP_CONFIG.PARLEY_PER_TRADE = parley.normalCost;
  if (parley.crowCost !== undefined) APP_CONFIG.CROW_PARLEY = parley.crowCost;
  const mappings = {
    specialMatPriority: "SPECIAL_MAT_PRIORITY", crowCoinPriority: "CROW_COIN_PRIORITY",
    pathEfficiencyBonus: "PATH_EFFICIENCY_BONUS", smallTradePenalty: "SMALL_TRADE_PENALTY",
    chainMaxDistance: "CHAIN_MAX_DISTANCE", chainBonusScore: "CHAIN_BONUS_SCORE",
    distancePenaltyWeight: "DISTANCE_PENALTY_WEIGHT", overloadPenalty: "OVERLOAD_PENALTY",
    efficiencyThreshold: "EFFICIENCY_THRESHOLD", iliyaPitstopRadius: "ILIYA_PITSTOP_RADIUS",
    overloadTimeWeight: "OVERLOAD_TIME_WEIGHT", deficitRatioBonus: "DEFICIT_RATIO_BONUS",
    emergencyBonus: "EMERGENCY_BONUS", preservationBonus: "PRESERVATION_BONUS",
    westBias: "WEST_BIAS", useClustering: "USE_CLUSTERING"
  };
  for (const [key, target] of Object.entries(mappings)) if (tuning[key] !== undefined) APP_CONFIG[target] = tuning[key];
  if (tuning.tierPriority) APP_CONFIG.TIER_PRIORITY = { ...tuning.tierPriority };
  if (tuning.excludeSurplus) APP_CONFIG.EXCLUDE_SURPLUS = { ...tuning.excludeSurplus };
  for (const key of Object.keys(islandCoordinates)) delete islandCoordinates[key];
  Object.assign(islandCoordinates, rawData, navigation.coords || {});
  routeCalibrations = { ...defaultRouteCalibrations, ...(navigation.routeCalibrations || {}) };
  window.routeCalibrations = routeCalibrations;
};
window.applyBdoPersistentConfig({});
// DOMAIN_CONSTANTS_MIGRATED: classic-script globals preserve the reference execution environment.
`;

const settings = await readFile(settingsPath, "utf8");
const oldImport = 'import { MODES, MODE_LABELS, TUNING_FIELDS } from "./domain/constants.js";';
if (!settings.includes(oldImport)) throw new Error("Expected settings-ui constants import was not found.");
const updatedSettings = settings.replace(oldImport, "const { MODES, MODE_LABELS, TUNING_FIELDS } = window.BDO_CONSTANTS;");
const index = await readFile(indexPath, "utf8");
if (index.includes('src="/assets/js/domain/constants.js"')) throw new Error("constants.js script is already loaded; refusing duplicate insertion.");
const scriptAnchor = '  <script type="module" src="/assets/js/state.js"></script>';
if (!index.includes(scriptAnchor)) throw new Error("Expected frontend script ordering anchor was not found.");
const updatedIndex = index.replace(scriptAnchor, '  <script src="/assets/js/domain/constants.js"></script>\n' + scriptAnchor);

await writeFile(outputPath, moduleConstants, "utf8");
await writeFile(settingsPath, updatedSettings, "utf8");
await writeFile(indexPath, updatedIndex, "utf8");
console.log(JSON.stringify({ output: outputPath, moved: baseline.constants, scriptOrder: "classic constants before frontend modules" }, null, 2));
