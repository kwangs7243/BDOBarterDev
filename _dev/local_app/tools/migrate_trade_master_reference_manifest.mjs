import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adaptLegacyCatalog } from "../frontend/js/domain/trade-master-registry.js";
import { validateTradeMasterReferenceManifest } from "../frontend/js/domain/trade-master-bundle.js";
import { computeCatalogProvenanceV2 } from "../frontend/js/domain/trade-catalog-provenance.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, "../frontend/data");
const V1_PATH = resolve(DATA, "trade-master-reference-manifest.json");
const V2_PATH = resolve(DATA, "trade-master-reference-manifest-v2.json");
const CATALOG_PATH = resolve(DATA, "trade-catalog.json");
const V1_AUDIT = "46c10355ccf3b8b5aba08880cd5947408cc66720dafdccef4d9deeb12ab2df82";
const V1_RAW_CATALOG = "8183b03e6aa0ee354142cf9720b401494bec365e528632f3c0c84ec11b46b4b3";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function compareCodePoints(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort(compareCodePoints).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function migrateTradeMasterReferenceManifestV1ToV2({ catalogBytes, legacyManifest }) {
  const oldValidation = validateTradeMasterReferenceManifest(legacyManifest);
  if (!oldValidation.ok || legacyManifest.schemaVersion !== 1
      || legacyManifest.scope.catalogSha256 !== V1_RAW_CATALOG
      || legacyManifest.referenceAuditHash !== V1_AUDIT
      || legacyManifest.claims.length !== 87 || legacyManifest.unresolved.length !== 143
      || legacyManifest.scope.sourceOccurrenceCount !== 241 || legacyManifest.scope.legacyGroupCount !== 230) {
    throw new TypeError("input is not the approved v1 reference manifest baseline");
  }
  const provenance = computeCatalogProvenanceV2(catalogBytes);
  const normalizedText = new TextDecoder("utf-8", { fatal: true }).decode(catalogBytes).replace(/\r\n/g, "\n");
  const normalizedBytes = new TextEncoder().encode(normalizedText);
  const rawHash = sha256(catalogBytes);
  const reconstructedLegacyCrlfHash = sha256(new TextEncoder().encode(normalizedText.replace(/\n/g, "\r\n")));
  if (rawHash !== V1_RAW_CATALOG && reconstructedLegacyCrlfHash !== V1_RAW_CATALOG) {
    throw new TypeError("catalog is not EOL-equivalent to the catalog bytes pinned by v1");
  }
  const source = adaptLegacyCatalog(provenance.catalog, {
    sourceRevision: `catalog-provenance-v2:${provenance.sha256}`,
    sourceSha256: provenance.sha256,
    curatedMappings: null,
  });
  const names = new Set(source.legacyNames.map((record) => record.legacyNameKey));
  const accounted = [...legacyManifest.claims, ...legacyManifest.unresolved].map((record) => record.legacyNameKey);
  assert.equal(source.legacyNames.length, 230);
  assert.equal(source.legacyNames.reduce((sum, record) => sum + record.occurrences.length, 0), 241);
  assert.equal(new Set(accounted).size, accounted.length);
  assert.deepEqual(new Set(accounted), names, "all v1 claims/unresolved entries must match the exact source catalog groups");

  const manifest = {
    schemaVersion: 2,
    policyVersion: "trade-master-reference-v2",
    scope: {
      originalHtmlSha256: legacyManifest.scope.originalHtmlSha256,
      catalogDigest: { schemaVersion: 2, hashBasis: provenance.hashBasis, sha256: provenance.sha256 },
      sourceOccurrenceCount: 241,
      legacyGroupCount: 230,
    },
    migration: {
      fromManifestSchemaVersion: 1,
      fromReferenceAuditHash: legacyManifest.referenceAuditHash,
      fromCatalogRawSha256: V1_RAW_CATALOG,
    },
    claims: structuredClone(legacyManifest.claims),
    unresolved: structuredClone(legacyManifest.unresolved),
  };
  manifest.referenceAuditHash = sha256(canonical(manifest));
  const validation = validateTradeMasterReferenceManifest(manifest);
  if (!validation.ok) throw new TypeError(`generated v2 reference manifest is invalid: ${validation.errors.join("; ")}`);
  return { manifest, normalizedCatalogSha256: sha256(normalizedBytes) };
}

async function main() {
  const [catalogBytes, oldBytes] = await Promise.all([readFile(CATALOG_PATH), readFile(V1_PATH)]);
  const legacyManifest = JSON.parse(oldBytes.toString("utf8"));
  const { manifest } = migrateTradeMasterReferenceManifestV1ToV2({ catalogBytes, legacyManifest });
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  if (process.argv.includes("--base64")) {
    process.stdout.write(Buffer.from(output, "utf8").toString("base64"));
    return;
  }
  try {
    const existing = await readFile(V2_PATH, "utf8");
    if (existing !== output) throw new Error("v2 manifest output already exists with different content; refusing overwrite");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(V2_PATH, output, { encoding: "utf8" });
  }
  console.log(JSON.stringify({ output: V2_PATH, claims: manifest.claims.length,
    unresolved: manifest.unresolved.length, sourceOccurrences: manifest.scope.sourceOccurrenceCount,
    legacyGroups: manifest.scope.legacyGroupCount, sha256: manifest.scope.catalogDigest.sha256,
    referenceAuditHash: manifest.referenceAuditHash }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
