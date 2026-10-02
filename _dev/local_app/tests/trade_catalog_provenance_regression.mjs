import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCatalogProvenanceV2, CATALOG_PROVENANCE_V2 } from "../frontend/js/domain/trade-catalog-provenance.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vectors = JSON.parse(await readFile(resolve(root, "tests/fixtures/catalog-provenance-v2-vectors.json"), "utf8"));
const encoder = new TextEncoder();
const bytes = (text) => encoder.encode(text);
const baseline = bytes(vectors.catalogText);
const baselineDigest = computeCatalogProvenanceV2(baseline).sha256;
assert.equal(baselineDigest, vectors.expectedSha256);
assert.deepEqual(CATALOG_PROVENANCE_V2, { schemaVersion: 2, hashBasis: "CATALOG_UTF8_CRLF_TO_LF_V2" });

const lf = vectors.catalogText;
const crlf = lf.replace(/\n/g, "\r\n");
const mixed = lf.replace(/\n/g, (value, offset) => (offset % 2 ? "\r\n" : value));
for (const text of [lf, crlf, mixed]) assert.equal(computeCatalogProvenanceV2(bytes(text)).sha256, baselineDigest);

const changed = [
  lf.slice(0, -1),
  `${lf} `,
  lf.replace("[\"품목 A\"]", "[ \"품목 A\"]"),
  lf.replace("\"masterData\":", "\"specialItems\":[],\"masterData\":"),
  lf.replace("품목 A", "품목 B"),
  lf.replace("품목 A", "품목 Z").replace("섬 A", "섬 B"),
];
for (const text of changed) assert.notEqual(computeCatalogProvenanceV2(bytes(text)).sha256, baselineDigest);

for (const invalid of [
  new Uint8Array([...bytes(lf.replace("\n", "\r"))]),
  new Uint8Array([0xef, 0xbb, 0xbf, ...baseline]),
  new Uint8Array([0xc3, 0x28]),
  bytes("{broken json"),
  bytes(vectors.invalidCatalogText),
]) assert.throws(() => computeCatalogProvenanceV2(invalid));

console.log("PASS trade_catalog_provenance_regression: LF/CRLF/mixed stable; formatting and content changes detected; invalid input rejected");
