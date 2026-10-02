import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adaptRegistrySnapshotV1ToMasterBundleV2,
  applyTradeMasterReferenceManifestToBundleV2,
  masterBundleContentHash,
} from "../frontend/js/domain/trade-master-bundle.js";
import { computeCatalogProvenanceV2 } from "../frontend/js/domain/trade-catalog-provenance.js";
import { adaptLegacyCatalog, registrySnapshotSha256 } from "../frontend/js/domain/trade-master-registry.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogBytes = await readFile(resolve(root, "frontend/data/trade-catalog.json"));
const catalogText = new TextDecoder("utf-8", { fatal: true }).decode(catalogBytes);
const manifest = JSON.parse(await readFile(resolve(root, "frontend/data/trade-master-reference-manifest-v2.json"), "utf8"));
const expectedBundleHash = "ad0b6a929130dfeafd0f66bc5c302a7d2c60c400d5145cd16cd20b66bd3e652b";
const expectedRegistryHash = "9b2fa94dfb3c77d550777354a224ab3bfd336284c0097b948ce0a5a86bd3fc3f";

function reconstruct(text) {
  const bytes = new TextEncoder().encode(text);
  const catalogProvenance = computeCatalogProvenanceV2(bytes);
  const registry = adaptLegacyCatalog(catalogProvenance.catalog, {
    sourceRevision: `catalog-provenance-v2:${catalogProvenance.sha256}`,
    sourceSha256: catalogProvenance.sha256,
    curatedMappings: null,
  });
  const registryHash = registrySnapshotSha256(registry);
  const base = adaptRegistrySnapshotV1ToMasterBundleV2(registry, {
    createdAt: "2026-10-03T00:00:00.000Z",
    catalogProvenance: {
      schemaVersion: catalogProvenance.schemaVersion,
      hashBasis: catalogProvenance.hashBasis,
      sha256: catalogProvenance.sha256,
    },
  });
  const bundle = applyTradeMasterReferenceManifestToBundleV2(base, manifest, {
    createdAt: "2026-10-03T00:00:00.000Z",
    catalogBytes: bytes,
  });
  return { catalogDigest: catalogProvenance.sha256, registryHash, bundleHash: masterBundleContentHash(bundle) };
}

const lfText = catalogText.replace(/\r\n/g, "\n");
const crlfText = lfText.replace(/\n/g, "\r\n");
const lf = reconstruct(lfText);
const crlf = reconstruct(crlfText);
assert.deepEqual(lf, crlf, "LF and CRLF checkouts reconstruct identical provenance, Registry, and Bundle semantics");
assert.equal(lf.catalogDigest, "bc7f1e50460ea29ebe822018606008506334315cab07ac67f8cdbec2a19e606e");
assert.equal(lf.registryHash, expectedRegistryHash);
assert.equal(lf.bundleHash, expectedBundleHash);

console.log(`PASS trade_catalog_provenance_v2_baseline_regression: LF=CRLF=${expectedBundleHash}`);
