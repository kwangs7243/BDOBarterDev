#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TIER_KEYS = Object.freeze(["1", "2", "3", "4", "5", "6", "7"]);
const COLLECTIONS = Object.freeze([
  ...TIER_KEYS.map((tier) => ({ key: `MASTER_TIER_${tier}`, locator: `/masterData/${tier}`, kind: "MASTER_ITEM", tier: Number(tier) })),
  { key: "SPECIAL_ITEMS", locator: "/specialItems", kind: "SPECIAL_ITEM", tier: null },
  { key: "GENERAL_ISLANDS", locator: "/islands", kind: "ISLAND", tier: null },
  { key: "T6_ISLANDS", locator: "/t6Islands", kind: "ISLAND", tier: null },
  { key: "T7_ISLANDS", locator: "/t7Islands", kind: "ISLAND", tier: null },
]);
const TOP_LEVEL_KEYS = Object.freeze(["masterData", "specialItems", "islands", "t6Islands", "t7Islands"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
}

function assertStringArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") throw new TypeError(`${label}[${index}] must be a string`);
    if (value[index].trim().length === 0) throw new TypeError(`${label}[${index}] must not be empty or whitespace-only`);
  }
}

function validateCatalog(catalog) {
  assertPlainObject(catalog, "catalog");
  const extraKeys = Object.keys(catalog).filter((key) => !TOP_LEVEL_KEYS.includes(key));
  const missingKeys = TOP_LEVEL_KEYS.filter((key) => !Object.hasOwn(catalog, key));
  if (missingKeys.length || extraKeys.length) {
    throw new TypeError(`catalog top-level keys mismatch (missing: ${missingKeys.join(",") || "none"}; unexpected: ${extraKeys.join(",") || "none"})`);
  }
  assertPlainObject(catalog.masterData, "masterData");
  const actualTiers = Object.keys(catalog.masterData);
  const unexpectedTiers = actualTiers.filter((tier) => !TIER_KEYS.includes(tier));
  const missingTiers = TIER_KEYS.filter((tier) => !Object.hasOwn(catalog.masterData, tier));
  if (missingTiers.length || unexpectedTiers.length) {
    throw new TypeError(`masterData tiers mismatch (missing: ${missingTiers.join(",") || "none"}; unexpected: ${unexpectedTiers.join(",") || "none"})`);
  }
  for (const tier of TIER_KEYS) assertStringArray(catalog.masterData[tier], `masterData.${tier}`);
  for (const key of TOP_LEVEL_KEYS.slice(1)) assertStringArray(catalog[key], key);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizedWhitespace(raw) {
  return raw.replace(/\s+/g, "");
}

// Matches the existing V1 UTF-16 edit-distance convention. This is diagnostic only.
function levenshtein(left, right) {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  const matrix = Array.from({ length: right.length + 1 }, (_, index) => [index]);
  for (let column = 0; column <= left.length; column += 1) matrix[0][column] = column;
  for (let row = 1; row <= right.length; row += 1) {
    for (let column = 1; column <= left.length; column += 1) {
      matrix[row][column] = right.charAt(row - 1) === left.charAt(column - 1)
        ? matrix[row - 1][column - 1]
        : Math.min(matrix[row - 1][column - 1] + 1, matrix[row][column - 1] + 1, matrix[row - 1][column] + 1);
    }
  }
  return matrix[right.length][left.length];
}

function groupBy(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  return [...groups.values()];
}

function orderedRecords(records) {
  return [...records].sort((left, right) => compareText(left.locator, right.locator));
}

function groupedFinding(type, severity, records, extra = {}) {
  const ordered = orderedRecords(records);
  return {
    type,
    severity,
    ...extra,
    locators: ordered.map((record) => record.locator),
    rawValues: ordered.map((record) => record.raw),
    scopes: [...new Set(ordered.map((record) => record.scope))].sort(compareText),
  };
}

function compareFinding(left, right) {
  return compareText(left.type, right.type)
    || compareText((left.leftLocator ?? left.locators?.[0] ?? ""), (right.leftLocator ?? right.locators?.[0] ?? ""))
    || compareText((left.rightLocator ?? left.locators?.[1] ?? ""), (right.rightLocator ?? right.locators?.[1] ?? ""));
}

/**
 * Produce a deterministic, diagnostic-only audit of the legacy catalog.
 * Locators identify current JSON positions; they are not stable IDs. Similarity
 * bounds compare with the existing V1 matcher and never assert alias or identity.
 */
export function auditTradeCatalog(catalog, { sourceRevision, sourceSha256 } = {}) {
  validateCatalog(catalog);
  if (typeof sourceRevision !== "string" || sourceRevision.trim().length === 0) {
    throw new TypeError("sourceRevision must be a non-empty string");
  }
  if (typeof sourceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sourceSha256)) {
    throw new TypeError("sourceSha256 must be a 64-character SHA-256 hex string");
  }

  const entries = [];
  for (const collection of COLLECTIONS) {
    const values = collection.key.startsWith("MASTER_TIER_")
      ? catalog.masterData[String(collection.tier)]
      : catalog[collection.locator.slice(1)];
    values.forEach((raw, index) => entries.push({
      locator: `${collection.locator}/${index}`,
      raw,
      kind: collection.kind,
      tier: collection.tier,
      scope: collection.key,
      provenanceStatus: "LEGACY_UNVERIFIED",
    }));
  }
  entries.sort((left, right) => compareText(left.locator, right.locator));

  const findings = [];
  const exactCollectionGroups = groupBy(entries, (entry) => `${entry.scope}\0${entry.raw}`)
    .filter((group) => group.length > 1);
  for (const group of exactCollectionGroups) {
    findings.push(groupedFinding("EXACT_DUPLICATE", "REVIEW_REQUIRED", group, {
      rawKey: group[0].raw,
      scope: group[0].scope,
    }));
  }

  const crossTierGroups = groupBy(entries.filter((entry) => entry.kind === "MASTER_ITEM"), (entry) => entry.raw)
    .filter((group) => new Set(group.map((entry) => entry.tier)).size > 1);
  for (const group of crossTierGroups) {
    findings.push(groupedFinding("CROSS_TIER_NAME_REPEAT", "REVIEW_REQUIRED", group, { rawKey: group[0].raw }));
  }

  const whitespaceGroups = groupBy(entries, (entry) => `${entry.kind}\0${normalizedWhitespace(entry.raw)}`)
    .filter((group) => group.length > 1 && new Set(group.map((entry) => entry.raw)).size > 1);
  for (const group of whitespaceGroups) {
    findings.push(groupedFinding("WHITESPACE_NORMALIZED_COLLISION", "REVIEW_REQUIRED", group, {
      normalizedKey: normalizedWhitespace(group[0].raw),
      normalization: "remove JavaScript \\s+ only; no Unicode normalization",
    }));
  }

  const islandEntries = entries.filter((entry) => entry.kind === "ISLAND");
  for (const group of groupBy(islandEntries, (entry) => entry.raw).filter((values) => new Set(values.map((entry) => entry.scope)).size > 1)) {
    findings.push(groupedFinding("ISLAND_SCOPE_OVERLAP", "INFO", group, { rawKey: group[0].raw }));
  }

  const itemEntries = entries.filter((entry) => entry.kind === "MASTER_ITEM" || entry.kind === "SPECIAL_ITEM");
  const nearNameCandidatePairs = [];
  const comparePairs = (records, collectionName) => {
    const ordered = orderedRecords(records);
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      const left = ordered[leftIndex];
      const normalizedLeft = normalizedWhitespace(left.raw);
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const right = ordered[rightIndex];
        const normalizedRight = normalizedWhitespace(right.raw);
        if (left.raw === right.raw || normalizedLeft === normalizedRight) continue;
        const distance = levenshtein(normalizedLeft, normalizedRight);
        if (distance === 0 || distance > 3) continue;
        const similarity = 1 - distance / Math.max(normalizedLeft.length, normalizedRight.length);
        if (similarity < 0.75) continue;
        const scopeRelation = left.scope === right.scope ? "SAME_SCOPE" : "CROSS_SCOPE";
        nearNameCandidatePairs.push({
          type: "NEAR_NAME_CANDIDATE",
          // This severity requests authority review before IDs are assigned; it does not assert alias or identity.
          severity: scopeRelation === "CROSS_SCOPE" ? "SCHEMA_AUTHORITY_REVIEW" : "INFO",
          comparison: collectionName,
          distance,
          similarity,
          leftLocator: left.locator,
          rightLocator: right.locator,
          leftRaw: left.raw,
          rightRaw: right.raw,
          scopeRelation,
          leftScope: left.scope,
          rightScope: right.scope,
          diagnosticOnly: true,
        });
      }
    }
  };
  comparePairs(itemEntries, "ITEMS");
  comparePairs(islandEntries, "ISLANDS");
  findings.push(...nearNameCandidatePairs);
  findings.sort(compareFinding);

  const masterItemsByTier = Object.fromEntries(TIER_KEYS.map((tier) => [tier, catalog.masterData[tier].length]));
  const sourceEntries = entries.length;
  const masterItems = Object.values(masterItemsByTier).reduce((sum, count) => sum + count, 0);
  const counts = {
    sourceEntries,
    masterItems,
    masterItemsByTier,
    specialItems: catalog.specialItems.length,
    generalIslands: catalog.islands.length,
    t6IslandEntries: catalog.t6Islands.length,
    t7IslandEntries: catalog.t7Islands.length,
    exactDuplicateGroups: exactCollectionGroups.length,
    whitespaceCollisionGroups: whitespaceGroups.length,
    crossTierRepeatGroups: crossTierGroups.length,
    islandScopeOverlapGroups: findings.filter((finding) => finding.type === "ISLAND_SCOPE_OVERLAP").length,
    nearNameCandidatePairs: nearNameCandidatePairs.length,
    invalidEntries: 0,
  };

  return { schemaVersion: 1, entries, findings, counts };
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function semanticAuditSha256(audit) {
  return createHash("sha256").update(stableSerialize(audit), "utf8").digest("hex");
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--input", "--out", "--source-revision"].includes(key) || values.has(key)) {
      throw new TypeError(`unsupported or repeated argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`missing value for ${key}`);
    values.set(key, value);
    index += 1;
  }
  for (const required of ["--input", "--out", "--source-revision"]) {
    if (!values.has(required)) throw new TypeError(`required argument missing: ${required}`);
  }
  return { input: values.get("--input"), output: values.get("--out"), sourceRevision: values.get("--source-revision") };
}

async function canonicalFuturePath(filePath) {
  const absolute = path.resolve(filePath);
  const unresolvedSegments = [];
  let probe = absolute;
  while (true) {
    try {
      const canonicalAncestor = await realpath(probe);
      return path.join(canonicalAncestor, ...unresolvedSegments.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      unresolvedSegments.push(path.basename(probe));
      probe = parent;
    }
  }
}

async function runCli(argv) {
  const { input, output, sourceRevision } = parseArguments(argv);
  const inputPath = path.resolve(input);
  const outputPath = path.resolve(output);
  const inputCanonical = await realpath(inputPath);
  const outputCanonical = await canonicalFuturePath(outputPath);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../../..");
  const protectedCatalog = await realpath(path.resolve(repoRoot, "_dev/local_app/frontend/data/trade-catalog.json"));

  if (inputCanonical === outputCanonical) throw new Error("output must not overwrite the input source");
  if (outputCanonical === protectedCatalog) throw new Error("output must not target the protected trade catalog source");
  const relativeSourcePath = path.relative(repoRoot, inputCanonical);
  if (relativeSourcePath === ".." || relativeSourcePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSourcePath)) {
    throw new Error("input must be inside the repository so the manifest can use a repository-relative path");
  }

  const sourceBytes = await readFile(inputPath);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const catalog = JSON.parse(sourceBytes.toString("utf8"));
  const audit = auditTradeCatalog(catalog, { sourceRevision, sourceSha256 });
  const manifest = {
    manifestVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      revision: sourceRevision,
      sha256: sourceSha256,
      relativePath: relativeSourcePath.split(path.sep).join("/"),
    },
    semanticSha256: semanticAuditSha256(audit),
    audit,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({ output: outputPath, semanticSha256: manifest.semanticSha256, sourceSha256 })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`catalog audit failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
