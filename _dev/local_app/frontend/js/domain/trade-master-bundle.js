import {
  registrySnapshotSha256,
  validateRegistrySnapshot,
} from "./trade-master-registry.js";

const SCHEMA_VERSION = 2;
const HASH_BASIS = "MASTER_CANONICAL_JSON_V2";
const REGISTRY_PREFIX = "registry-v2:";
const SPECIAL_CATEGORY = "LEGACY_SPECIAL_ITEM";
const ENTITY_KINDS = new Set(["ITEM", "ISLAND"]);
const LEGACY_KINDS = new Set(["MASTER_ITEM", "SPECIAL_ITEM", "ISLAND"]);
const STATUSES = new Set(["LEGACY_UNVERIFIED", "VERIFIED_REFERENCE", "VERIFIED_CURATED", "DISPUTED", "DEPRECATED"]);
const NAME_STATUSES = new Set(["LEGACY_UNVERIFIED", "VERIFIED_REFERENCE", "VERIFIED_CURATED", "DISPUTED", "DEPRECATED"]);
const TOP_KEYS = Object.freeze([
  "schemaVersion", "registryVersion", "createdAt", "entities", "compatibilityMappings",
  "unresolvedLegacyNames", "sourceRevisions", "provenance", "hashBasis", "contentHash",
]);
const ENTITY_KEYS = Object.freeze([
  "stableId", "kind", "canonicalName", "displayNames", "aliases", "legacyNames", "tier",
  "category", "status", "provenance", "replacedBy",
]);
const LEGACY_NAME_KEYS = Object.freeze([
  "legacyNameKey", "legacyKind", "rawName", "tier", "occurrences", "authorityStatus",
]);
const OCCURRENCE_KEYS = Object.freeze(["locator", "scope", "tier"]);
const NAME_ENTRY_KEYS = Object.freeze(["text", "status", "provenance"]);
const COMPATIBILITY_KEYS = Object.freeze(["stableId", "legacyNameKeys", "sourceLocators"]);
const UNRESOLVED_KEYS = Object.freeze([...LEGACY_NAME_KEYS, "reason"]);
const SOURCE_REVISION_KEYS = Object.freeze(["sourceType", "revision", "sha256"]);
const REFERENCE_MANIFEST_KEYS = Object.freeze(["schemaVersion", "policyVersion", "scope", "claims", "unresolved", "referenceAuditHash"]);
const REFERENCE_SCOPE_KEYS = Object.freeze(["originalHtmlSha256", "catalogSha256", "sourceOccurrenceCount", "legacyGroupCount"]);
const REFERENCE_CLAIM_KEYS = Object.freeze(["legacyNameKey", "stableId", "kind", "legacyKind", "canonicalName", "displayName", "tier", "category", "decision", "evidence"]);
const CREATE_INPUT_KEYS = Object.freeze([
  "createdAt", "entities", "compatibilityMappings", "unresolvedLegacyNames", "sourceRevisions", "provenance",
]);
const MAX_NODES = 250000;
const MAX_DEPTH = 40;

const SHA256_INITIAL = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_ROUND = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isAbsoluteFilesystemPath(value) {
  return /^(?:[a-z]:[\\/]|\\\\|\/(?!\/)|file:\/\/)/i.test(value);
}

function hasMachinePath(value) {
  if (typeof value === "string") return isAbsoluteFilesystemPath(value);
  if (Array.isArray(value)) return value.some(hasMachinePath);
  if (isRecord(value)) return Object.values(value).some(hasMachinePath);
  return false;
}

function validUnicode(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function defineDataProperty(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function cloneJson(value, label = "value", ancestors = new Set(), budget = { nodes: MAX_NODES }, depth = 0) {
  budget.nodes -= 1;
  if (budget.nodes < 0 || depth > MAX_DEPTH) throw new TypeError(`${label} exceeds structural limits`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!validUnicode(value)) throw new TypeError(`${label} contains invalid Unicode`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError(`${label} must contain only safe integers (not floats or -0)`);
    }
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${label} is not JSON data`);
  if (ancestors.has(value)) throw new TypeError(`${label} contains a cycle`);

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new TypeError(`${label} has a custom array prototype`);
    ancestors.add(value);
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
        throw new TypeError(`${label}[${index}] is not a JSON array item`);
      }
      result.push(cloneJson(descriptor.value, `${label}[${index}]`, ancestors, budget, depth + 1));
    }
    const names = Object.getOwnPropertyNames(value).filter((key) => key !== "length");
    if (names.length !== value.length || Object.getOwnPropertySymbols(value).length) {
      throw new TypeError(`${label} has non-index or symbol array properties`);
    }
    ancestors.delete(value);
    return result;
  }

  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} has a custom object prototype`);
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`${label} contains symbol keys`);
  ancestors.add(value);
  const result = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!validUnicode(key)) throw new TypeError(`${label} has an invalid Unicode key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
      throw new TypeError(`${label}.${key} is an accessor or hidden property`);
    }
    defineDataProperty(result, key, cloneJson(descriptor.value, `${label}.${key}`, ancestors, budget, depth + 1));
  }
  ancestors.delete(value);
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function compareOrdinal(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  return `{${Object.keys(value).sort(compareOrdinal)
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
}

function sha256(text) {
  const input = new TextEncoder().encode(text);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = input.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  const rotateRight = (word, bits) => (word >>> bits) | (word << (32 - bits));
  for (let block = 0; block < paddedLength; block += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(block + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA256_ROUND[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function hashPayload(bundle) {
  const semantic = {};
  for (const key of TOP_KEYS) {
    if (key !== "createdAt" && key !== "registryVersion" && key !== "contentHash") {
      defineDataProperty(semantic, key, bundle[key]);
    }
  }
  return sha256(canonicalStringify(semantic));
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort(compareOrdinal).join("\0") === [...keys].sort(compareOrdinal).join("\0");
}

function issue(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function isValidReferenceEvidence(entry) {
  if (!exactKeys(entry, ["sourceKind", "sourceUrl", "checkedAt", "externalId", "verifiedProperties"])) return false;
  if (!nonempty(entry.sourceUrl) || !nonempty(entry.checkedAt) || !(entry.externalId === null || nonempty(entry.externalId))) return false;
  const checked = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (!checked.test(entry.checkedAt) || Number.isNaN(Date.parse(entry.checkedAt))) return false;
  try {
    const url = new URL(entry.sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (entry.sourceKind === "BDO_OFFICIAL_KR") {
      if (!new Set(["kr.playblackdesert.com", "www.kr.playblackdesert.com"]).has(url.hostname)
          || !url.pathname.startsWith("/ko-KR/")) return false;
    } else if (entry.sourceKind === "BDOCODEX_KR") {
      if (url.hostname !== "bdocodex.com" || !url.pathname.startsWith("/kr/")) return false;
    } else return false;
  } catch {
    return false;
  }
  const allowed = new Set(["canonicalName", "displayName", "tier", "category", "identity"]);
  return Array.isArray(entry.verifiedProperties) && entry.verifiedProperties.length > 0
    && new Set(entry.verifiedProperties).size === entry.verifiedProperties.length
    && entry.verifiedProperties.every((property) => allowed.has(property));
}

function validateReferenceProvenance(provenance, path, errors) {
  if (!isRecord(provenance) || provenance.authority !== "VERIFIED_REFERENCE"
      || provenance.referenceDecision !== "MATCHED" || !Array.isArray(provenance.referenceEvidence)
      || provenance.referenceEvidence.length === 0
      || !provenance.referenceEvidence.every(isValidReferenceEvidence)) {
    issue(errors, path, "VERIFIED_REFERENCE requires matched Korean reference evidence");
  }
}

function validateReferenceManifestInternal(manifest) {
  const errors = [];
  if (!exactKeys(manifest, REFERENCE_MANIFEST_KEYS)) return { ok: false, errors: ["manifest has invalid top-level fields"] };
  if (manifest.schemaVersion !== 1 || manifest.policyVersion !== "trade-master-reference-v1") issue(errors, "manifest", "unsupported reference manifest version");
  if (!exactKeys(manifest.scope, REFERENCE_SCOPE_KEYS)) issue(errors, "manifest.scope", "has invalid fields");
  else {
    for (const key of ["originalHtmlSha256", "catalogSha256"]) if (!/^[a-f0-9]{64}$/.test(manifest.scope[key] ?? "")) issue(errors, `manifest.scope.${key}`, "must be lowercase SHA-256");
    if (!Number.isSafeInteger(manifest.scope.sourceOccurrenceCount) || manifest.scope.sourceOccurrenceCount < 0) issue(errors, "manifest.scope.sourceOccurrenceCount", "must be a nonnegative integer");
    if (!Number.isSafeInteger(manifest.scope.legacyGroupCount) || manifest.scope.legacyGroupCount < 0) issue(errors, "manifest.scope.legacyGroupCount", "must be a nonnegative integer");
  }
  if (!Array.isArray(manifest.claims) || !Array.isArray(manifest.unresolved)) return { ok: false, errors: [...errors, "manifest claims and unresolved must be arrays"] };
  const keys = new Set();
  const ids = new Set();
  manifest.claims.forEach((claim, index) => {
    const path = `manifest.claims[${index}]`;
    if (!exactKeys(claim, REFERENCE_CLAIM_KEYS)) { issue(errors, path, "has invalid fields"); return; }
    if (!nonempty(claim.legacyNameKey) || keys.has(claim.legacyNameKey)) issue(errors, `${path}.legacyNameKey`, "must be unique and nonempty");
    keys.add(claim.legacyNameKey);
    if (typeof claim.stableId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(claim.stableId) || ids.has(claim.stableId)) issue(errors, `${path}.stableId`, "must be a unique pinned UUID v4");
    ids.add(claim.stableId);
    if (!ENTITY_KINDS.has(claim.kind) || !LEGACY_KINDS.has(claim.legacyKind)) issue(errors, path, "has invalid entity or legacy kind");
    if ((claim.legacyKind === "ISLAND") !== (claim.kind === "ISLAND")) issue(errors, path, "legacy kind and entity kind disagree");
    if (!nonempty(claim.canonicalName) || !nonempty(claim.displayName)) issue(errors, path, "canonicalName and displayName must be nonempty");
    if (claim.legacyKind === "MASTER_ITEM" ? (!Number.isSafeInteger(claim.tier) || claim.tier < 1 || claim.tier > 7) : claim.tier !== null) issue(errors, `${path}.tier`, "does not match legacy kind");
    if (claim.category !== (claim.legacyKind === "SPECIAL_ITEM" ? SPECIAL_CATEGORY : null)) issue(errors, `${path}.category`, "does not preserve legacy special-item category");
    if (claim.decision !== "VERIFIED_REFERENCE" || !Array.isArray(claim.evidence) || !claim.evidence.length || !claim.evidence.every(isValidReferenceEvidence)) issue(errors, path, "must contain Korean direct reference evidence");
  });
  manifest.unresolved.forEach((entry, index) => {
    const path = `manifest.unresolved[${index}]`;
    if (!exactKeys(entry, ["legacyNameKey", "status", "evidence", "note"])) { issue(errors, path, "has invalid fields"); return; }
    if (!nonempty(entry.legacyNameKey) || keys.has(entry.legacyNameKey)) issue(errors, `${path}.legacyNameKey`, "must be unique across claims and unresolved names");
    keys.add(entry.legacyNameKey);
    if (!["SOURCE_CONFLICT", "TIER_CONFLICT", "NO_DIRECT_REFERENCE"].includes(entry.status)) issue(errors, `${path}.status`, "is unsupported");
    if (!Array.isArray(entry.evidence) || !nonempty(entry.note)) issue(errors, path, "requires evidence accounting and an explanation");
  });
  if (manifest.scope?.legacyGroupCount !== keys.size) issue(errors, "manifest.scope.legacyGroupCount", "does not equal accounted claim and unresolved group count");
  const semantic = {};
  for (const key of REFERENCE_MANIFEST_KEYS) if (key !== "referenceAuditHash") defineDataProperty(semantic, key, manifest[key]);
  if (!/^[a-f0-9]{64}$/.test(manifest.referenceAuditHash ?? "") || sha256(canonicalStringify(semantic)) !== manifest.referenceAuditHash) issue(errors, "manifest.referenceAuditHash", "does not match canonical semantic content");
  return { ok: errors.length === 0, errors };
}

function validateNameEntries(entries, path, errors) {
  if (!Array.isArray(entries)) {
    issue(errors, path, "must be an array");
    return;
  }
  entries.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (!exactKeys(entry, NAME_ENTRY_KEYS)) {
      issue(errors, at, "must contain exactly text, status, provenance");
      return;
    }
    if (!nonempty(entry.text)) issue(errors, `${at}.text`, "must be nonempty; source text is preserved without trimming");
    if (!NAME_STATUSES.has(entry.status)) issue(errors, `${at}.status`, "has an unsupported name status");
    if (!isRecord(entry.provenance)) issue(errors, `${at}.provenance`, "must be a JSON object");
    else if (hasMachinePath(entry.provenance)) issue(errors, `${at}.provenance`, "cannot contain absolute filesystem paths");
    else if (entry.status === "VERIFIED_REFERENCE") validateReferenceProvenance(entry.provenance, `${at}.provenance`, errors);
  });
}

function validateLegacyName(record, path, errors) {
  if (!exactKeys(record, LEGACY_NAME_KEYS)) {
    issue(errors, path, "must contain exactly the legacy-name contract fields");
    return false;
  }
  if (!nonempty(record.legacyNameKey)) issue(errors, `${path}.legacyNameKey`, "must be nonempty");
  if (!LEGACY_KINDS.has(record.legacyKind)) issue(errors, `${path}.legacyKind`, "is unknown");
  if (!nonempty(record.rawName)) issue(errors, `${path}.rawName`, "must be nonempty and is not normalized");
  if (!STATUSES.has(record.authorityStatus)) issue(errors, `${path}.authorityStatus`, "is unknown");
  if (record.legacyKind === "MASTER_ITEM") {
    if (!Number.isSafeInteger(record.tier) || record.tier < 1 || record.tier > 7) issue(errors, `${path}.tier`, "must be an integer from 1 through 7 for MASTER_ITEM");
  } else if (record.tier !== null) {
    issue(errors, `${path}.tier`, "must be null outside MASTER_ITEM");
  }
  if (!Array.isArray(record.occurrences) || record.occurrences.length === 0) {
    issue(errors, `${path}.occurrences`, "must retain at least one source occurrence");
    return true;
  }
  record.occurrences.forEach((occurrence, index) => {
    const at = `${path}.occurrences[${index}]`;
    if (!exactKeys(occurrence, OCCURRENCE_KEYS)) {
      issue(errors, at, "must contain exactly locator, scope, tier");
      return;
    }
    if (!nonempty(occurrence.locator) || !nonempty(occurrence.scope)) issue(errors, at, "requires locator and scope");
    if (record.legacyKind === "MASTER_ITEM" ? occurrence.tier !== record.tier : occurrence.tier !== null) {
      issue(errors, `${at}.tier`, "does not agree with its legacy-name record");
    }
  });
  return true;
}

function validateEntity(entity, path, errors) {
  if (!exactKeys(entity, ENTITY_KEYS)) {
    issue(errors, path, "must contain exactly the schemaVersion 2 entity fields");
    return false;
  }
  if (!nonempty(entity.stableId)) issue(errors, `${path}.stableId`, "must be a nonempty opaque string");
  if (!ENTITY_KINDS.has(entity.kind)) issue(errors, `${path}.kind`, "must be ITEM or ISLAND");
  if (!(entity.canonicalName === null || nonempty(entity.canonicalName))) issue(errors, `${path}.canonicalName`, "must be null or nonempty text");
  if (entity.status === "VERIFIED_CURATED" && !nonempty(entity.canonicalName)) issue(errors, `${path}.canonicalName`, "is required for VERIFIED_CURATED");
  if (entity.status === "VERIFIED_REFERENCE" && !nonempty(entity.canonicalName)) issue(errors, `${path}.canonicalName`, "is required for VERIFIED_REFERENCE");
  if (!STATUSES.has(entity.status)) issue(errors, `${path}.status`, "is unknown");
  if (!(entity.tier === null || (Number.isSafeInteger(entity.tier) && entity.tier >= 1 && entity.tier <= 7))) {
    issue(errors, `${path}.tier`, "must be null or an integer from 1 through 7");
  }
  if (entity.kind === "ISLAND" && entity.tier !== null) issue(errors, `${path}.tier`, "ISLAND cannot have an item tier");
  if (!(entity.category === null || nonempty(entity.category))) issue(errors, `${path}.category`, "must be null or nonempty text");
  if (entity.kind === "ISLAND" && entity.category !== null) issue(errors, `${path}.category`, "ISLAND cannot have an item category");
  validateNameEntries(entity.displayNames, `${path}.displayNames`, errors);
  validateNameEntries(entity.aliases, `${path}.aliases`, errors);
  if (!Array.isArray(entity.legacyNames)) {
    issue(errors, `${path}.legacyNames`, "must be an array");
  } else {
    entity.legacyNames.forEach((record, index) => validateLegacyName(record, `${path}.legacyNames[${index}]`, errors));
  }
  if (!isRecord(entity.provenance)) issue(errors, `${path}.provenance`, "must be a JSON object");
  else if (hasMachinePath(entity.provenance)) issue(errors, `${path}.provenance`, "cannot contain absolute filesystem paths");
  else if (entity.status === "VERIFIED_REFERENCE") validateReferenceProvenance(entity.provenance, `${path}.provenance`, errors);
  if (!(entity.replacedBy === null || nonempty(entity.replacedBy))) issue(errors, `${path}.replacedBy`, "must be null or a stableId");
  return true;
}

function validateBundleInternal(bundle) {
  const errors = [];
  const warnings = [];
  if (!exactKeys(bundle, TOP_KEYS)) {
    return { ok: false, errors: ["bundle must contain exactly the schemaVersion 2 canonical fields"], warnings };
  }
  if (bundle.schemaVersion !== SCHEMA_VERSION) issue(errors, "schemaVersion", "must equal 2");
  if (!nonempty(bundle.registryVersion) || !bundle.registryVersion.startsWith(REGISTRY_PREFIX)) issue(errors, "registryVersion", "must use registry-v2:<contentHash>");
  if (!nonempty(bundle.createdAt)) issue(errors, "createdAt", "must be supplied by the caller");
  if (bundle.hashBasis !== HASH_BASIS) issue(errors, "hashBasis", `must equal ${HASH_BASIS}`);
  if (!/^[a-f0-9]{64}$/.test(bundle.contentHash ?? "")) issue(errors, "contentHash", "must be lowercase SHA-256 hex");
  if (!Array.isArray(bundle.entities)) issue(errors, "entities", "must be an array");
  if (!Array.isArray(bundle.compatibilityMappings)) issue(errors, "compatibilityMappings", "must be an array");
  if (!Array.isArray(bundle.unresolvedLegacyNames)) issue(errors, "unresolvedLegacyNames", "must be an array");
  if (!Array.isArray(bundle.sourceRevisions)) issue(errors, "sourceRevisions", "must be an array");
  if (!isRecord(bundle.provenance)) issue(errors, "provenance", "must be a JSON object");
  else if (hasMachinePath(bundle.provenance)) issue(errors, "provenance", "cannot contain absolute filesystem paths");
  if (errors.length) return { ok: false, errors, warnings };

  const entitiesById = new Map();
  const legacyByKey = new Map();
  const locatorOwners = new Map();
  const entityNamesById = new Map();
  bundle.entities.forEach((entity, index) => {
    const path = `entities[${index}]`;
    if (!validateEntity(entity, path, errors)) return;
    if (entitiesById.has(entity.stableId)) issue(errors, `${path}.stableId`, "duplicates an entity stableId");
    else entitiesById.set(entity.stableId, entity);
    const entityKeys = new Set();
    entity.legacyNames.forEach((record, legacyIndex) => {
      if (!isRecord(record) || typeof record.legacyNameKey !== "string" || !record.legacyNameKey) return;
      if (entityKeys.has(record.legacyNameKey)) issue(errors, `${path}.legacyNames[${legacyIndex}]`, "duplicates a legacy-name key in one entity");
      entityKeys.add(record.legacyNameKey);
      if (legacyByKey.has(record.legacyNameKey)) issue(errors, `${path}.legacyNames[${legacyIndex}]`, "legacy-name key is assigned more than once");
      else legacyByKey.set(record.legacyNameKey, { record, stableId: entity.stableId, path: `${path}.legacyNames[${legacyIndex}]` });
      const expectedKind = record.legacyKind === "ISLAND" ? "ISLAND" : "ITEM";
      if (record.legacyKind && entity.kind !== expectedKind) issue(errors, `${path}.legacyNames[${legacyIndex}].legacyKind`, "does not match entity kind");
      if (record.legacyKind === "MASTER_ITEM" && entity.tier !== record.tier) issue(errors, `${path}.legacyNames[${legacyIndex}].tier`, "does not match entity tier");
      if (record.legacyKind === "SPECIAL_ITEM" && entity.category !== SPECIAL_CATEGORY) issue(errors, `${path}.category`, `must preserve ${SPECIAL_CATEGORY} source membership`);
      if (entity.kind === "ISLAND" && record.legacyKind !== "ISLAND") issue(errors, path, "ISLAND may only contain island source names");
      if (record.authorityStatus === "VERIFIED_CURATED" && entity.status !== "VERIFIED_CURATED") {
        issue(errors, `${path}.legacyNames[${legacyIndex}].authorityStatus`, "cannot exceed the owning entity authority");
      }
      if (record.authorityStatus === "VERIFIED_REFERENCE" && !["VERIFIED_REFERENCE", "VERIFIED_CURATED"].includes(entity.status)) {
        issue(errors, `${path}.legacyNames[${legacyIndex}].authorityStatus`, "cannot exceed the owning entity authority");
      }
      if (record.occurrences && Array.isArray(record.occurrences)) {
        for (const occurrence of record.occurrences) {
          if (!isRecord(occurrence) || typeof occurrence.locator !== "string") continue;
          if (locatorOwners.has(occurrence.locator)) issue(errors, `${path}.legacyNames[${legacyIndex}]`, `source locator ${occurrence.locator} is accounted more than once`);
          else locatorOwners.set(occurrence.locator, record.legacyNameKey);
        }
      }
    });
    entityNamesById.set(entity.stableId, entityKeys);
  });

  const unresolvedKeys = new Set();
  bundle.unresolvedLegacyNames.forEach((record, index) => {
    const path = `unresolvedLegacyNames[${index}]`;
    if (!exactKeys(record, UNRESOLVED_KEYS)) {
      issue(errors, path, "must contain exactly the unresolved legacy-name fields and reason");
      return;
    }
    const { reason: _reason, ...legacyFields } = record;
    validateLegacyName(legacyFields, path, errors);
    if (record.reason !== "NO_CURATED_IDENTITY") issue(errors, `${path}.reason`, "must equal NO_CURATED_IDENTITY");
    if (record.authorityStatus !== "LEGACY_UNVERIFIED") issue(errors, `${path}.authorityStatus`, "unresolved names must be LEGACY_UNVERIFIED");
    if (unresolvedKeys.has(record.legacyNameKey)) issue(errors, `${path}.legacyNameKey`, "duplicates an unresolved key");
    unresolvedKeys.add(record.legacyNameKey);
    if (legacyByKey.has(record.legacyNameKey)) issue(errors, `${path}.legacyNameKey`, "is also assigned to a resolved entity");
    else legacyByKey.set(record.legacyNameKey, { record, stableId: null, path });
    for (const occurrence of Array.isArray(record.occurrences) ? record.occurrences : []) {
      if (!isRecord(occurrence) || typeof occurrence.locator !== "string") continue;
      if (locatorOwners.has(occurrence.locator)) issue(errors, path, `source locator ${occurrence.locator} is accounted more than once`);
      else locatorOwners.set(occurrence.locator, record.legacyNameKey);
    }
  });

  for (const [stableId, entity] of entitiesById) {
    const next = entity.replacedBy;
    if (next !== null && !entitiesById.has(next)) issue(errors, `entities.${stableId}.replacedBy`, "references an unknown stableId");
    if (next === stableId) issue(errors, `entities.${stableId}.replacedBy`, "cannot reference itself");
    const visited = new Set([stableId]);
    let current = next;
    while (current !== null && entitiesById.has(current)) {
      if (visited.has(current)) {
        issue(errors, `entities.${stableId}.replacedBy`, "contains a replacement cycle");
        break;
      }
      visited.add(current);
      current = entitiesById.get(current).replacedBy;
    }
  }

  const mappedKeys = new Set();
  const mappedLocators = new Set();
  bundle.compatibilityMappings.forEach((mapping, index) => {
    const path = `compatibilityMappings[${index}]`;
    if (!exactKeys(mapping, COMPATIBILITY_KEYS)) {
      issue(errors, path, "must contain exactly stableId, legacyNameKeys, sourceLocators");
      return;
    }
    if (!entitiesById.has(mapping.stableId)) issue(errors, `${path}.stableId`, "references an unknown entity");
    if (!Array.isArray(mapping.legacyNameKeys) || mapping.legacyNameKeys.length === 0) issue(errors, `${path}.legacyNameKeys`, "must contain at least one source legacy-name key");
    if (!Array.isArray(mapping.sourceLocators)) issue(errors, `${path}.sourceLocators`, "must be an array");
    if (!Array.isArray(mapping.legacyNameKeys) || !Array.isArray(mapping.sourceLocators)) return;
    const expectedLocators = [];
    for (const key of mapping.legacyNameKeys) {
      if (mappedKeys.has(key)) issue(errors, `${path}.legacyNameKeys`, `maps ${key} more than once`);
      mappedKeys.add(key);
      const selected = legacyByKey.get(key);
      if (!selected || selected.stableId !== mapping.stableId) {
        issue(errors, `${path}.legacyNameKeys`, `does not agree with entity/source mapping for ${key}`);
      } else if (Array.isArray(selected.record.occurrences)) {
        expectedLocators.push(...selected.record.occurrences.map((occurrence) => occurrence.locator));
      }
    }
    const expected = expectedLocators.sort(compareOrdinal);
    const actual = [...mapping.sourceLocators].sort(compareOrdinal);
    if (actual.some((locator, itemIndex) => typeof locator !== "string" || (itemIndex > 0 && locator === actual[itemIndex - 1]))) {
      issue(errors, `${path}.sourceLocators`, "must contain unique string locators");
    }
    if (canonicalStringify(actual) !== canonicalStringify(expected)) issue(errors, `${path}.sourceLocators`, "does not enumerate exactly its mapped occurrences");
    for (const locator of mapping.sourceLocators) {
      if (mappedLocators.has(locator)) issue(errors, `${path}.sourceLocators`, `maps ${locator} more than once`);
      mappedLocators.add(locator);
    }
  });

  for (const [key, entry] of legacyByKey) {
    if (entry.stableId === null) {
      if (!unresolvedKeys.has(key)) issue(errors, entry.path, "unresolved source name is missing from unresolvedLegacyNames");
    } else {
      const entityKeys = entityNamesById.get(entry.stableId);
      if (!entityKeys?.has(key)) issue(errors, entry.path, "entity stableId does not own this legacy-name record");
      if (!mappedKeys.has(key)) issue(errors, entry.path, "resolved source name has no compatibility mapping");
    }
  }
  for (const [stableId, keys] of entityNamesById) {
    const mappingCount = bundle.compatibilityMappings.filter((mapping) => mapping?.stableId === stableId).length;
    if (keys.size > 0 && mappingCount !== 1) issue(errors, `entities.${stableId}`, "must have exactly one compatibility mapping for its legacy names");
    if (keys.size === 0 && mappingCount > 0) issue(errors, `entities.${stableId}`, "cannot have a source compatibility mapping without legacy names");
  }
  for (const [locator, key] of locatorOwners) {
    const owner = legacyByKey.get(key);
    if (!owner) issue(errors, `sourceLocator.${locator}`, "has no source name record");
    if (owner?.stableId !== null && !mappedLocators.has(locator)) issue(errors, `sourceLocator.${locator}`, "resolved source occurrence is absent from compatibility mappings");
  }

  bundle.sourceRevisions.forEach((source, index) => {
    const path = `sourceRevisions[${index}]`;
    if (!exactKeys(source, SOURCE_REVISION_KEYS)) {
      issue(errors, path, "must contain exactly sourceType, revision, sha256");
      return;
    }
    if (!nonempty(source.sourceType) || isAbsoluteFilesystemPath(source.sourceType ?? "")
      || !nonempty(source.revision) || isAbsoluteFilesystemPath(source.revision ?? "")) {
      issue(errors, path, "requires a portable sourceType and revision");
    }
    if (!/^[a-f0-9]{64}$/.test(source.sha256 ?? "")) issue(errors, `${path}.sha256`, "must be lowercase SHA-256 hex");
  });

  const itemTiersByEntity = new Map();
  for (const [key, { record, stableId }] of legacyByKey) {
    if (stableId === null || record.legacyKind !== "MASTER_ITEM") continue;
    const tiers = itemTiersByEntity.get(stableId) ?? new Set();
    tiers.add(record.tier);
    itemTiersByEntity.set(stableId, tiers);
  }
  for (const [stableId, tiers] of itemTiersByEntity) {
    if (tiers.size > 1) issue(errors, `entities.${stableId}.tier`, "one entity cannot combine legacy master items across tiers");
  }

  if (bundle.registryVersion !== `${REGISTRY_PREFIX}${bundle.contentHash}`) issue(errors, "registryVersion", "must equal registry-v2:<contentHash>");
  try {
    const expectedHash = hashPayload(bundle);
    if (bundle.contentHash !== expectedHash) issue(errors, "contentHash", "does not match semantic content");
  } catch (error) {
    issue(errors, "contentHash", error instanceof Error ? error.message : "cannot hash bundle");
  }
  return { ok: errors.length === 0, errors, warnings };
}

function remapLegacyStatus(status) {
  return status === "VERIFIED" ? "LEGACY_UNVERIFIED" : status;
}

function convertLegacyRecord(record, { unresolved = false } = {}) {
  return {
    legacyNameKey: record.legacyNameKey,
    legacyKind: record.kind,
    rawName: record.rawName,
    tier: record.tier,
    occurrences: record.occurrences.map((occurrence) => ({
      locator: occurrence.locator,
      scope: occurrence.scope,
      tier: occurrence.tier,
    })),
    authorityStatus: unresolved ? "LEGACY_UNVERIFIED" : remapLegacyStatus(record.authorityStatus),
  };
}

function withBundleHash(fields) {
  const draft = {
    schemaVersion: SCHEMA_VERSION,
    registryVersion: "",
    ...fields,
    hashBasis: HASH_BASIS,
    contentHash: "",
  };
  const contentHash = hashPayload(draft);
  draft.contentHash = contentHash;
  draft.registryVersion = `${REGISTRY_PREFIX}${contentHash}`;
  return draft;
}

export function masterBundleContentHash(bundle) {
  const cloned = cloneJson(bundle, "bundle");
  const validation = validateBundleInternal(cloned);
  if (!validation.ok) throw new TypeError(`invalid Master bundle: ${validation.errors.join("; ")}`);
  return hashPayload(cloned);
}

export function validateMasterBundleV2(bundle) {
  let cloned;
  try {
    cloned = cloneJson(bundle, "bundle");
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "bundle is not JSON data"], warnings: [] };
  }
  return validateBundleInternal(cloned);
}

export function createMasterBundleV2(input = {}) {
  if (!exactKeys(input, CREATE_INPUT_KEYS)) {
    throw new TypeError("Master bundle input must contain exactly createdAt, entities, compatibilityMappings, unresolvedLegacyNames, sourceRevisions, provenance");
  }
  const fields = cloneJson({
    createdAt: input.createdAt,
    entities: input.entities,
    compatibilityMappings: input.compatibilityMappings,
    unresolvedLegacyNames: input.unresolvedLegacyNames,
    sourceRevisions: input.sourceRevisions,
    provenance: input.provenance,
  }, "Master bundle input");
  const bundle = withBundleHash(fields);
  const validation = validateBundleInternal(bundle);
  if (!validation.ok) throw new TypeError(`invalid Master bundle input: ${validation.errors.join("; ")}`);
  return deepFreeze(bundle);
}

export function adaptRegistrySnapshotV1ToMasterBundleV2(snapshot, options = {}) {
  if (!exactKeys(options, ["createdAt"])) throw new TypeError("adapter options must contain exactly createdAt");
  const { createdAt } = options;
  const legacyValidation = validateRegistrySnapshot(snapshot);
  if (!legacyValidation.ok) throw new TypeError(`invalid registry snapshot v1: ${legacyValidation.errors.join("; ")}`);
  if (!nonempty(createdAt)) throw new TypeError("createdAt must be a nonempty caller-supplied string");

  const namesByKey = new Map(snapshot.legacyNames.map((record) => [record.legacyNameKey, record]));
  const unresolvedKeys = new Set(snapshot.unresolvedMappings.map((record) => record.legacyNameKey));
  const entities = snapshot.entities.map((entity) => {
    const legacyNames = entity.legacyNameKeys.map((key) => {
      const sourceRecord = namesByKey.get(key);
      if (!sourceRecord) throw new TypeError(`registry snapshot entity references missing legacy name ${key}`);
      return convertLegacyRecord(sourceRecord);
    });
    const legacyKinds = new Set(legacyNames.map((record) => record.legacyKind));
    if (legacyKinds.has("ISLAND") && legacyKinds.size > 1) throw new TypeError(`registry snapshot entity mixes island and item names: ${entity.stableId}`);
    const kind = legacyKinds.has("ISLAND") ? "ISLAND" : "ITEM";
    const itemTiers = new Set(legacyNames.filter((record) => record.legacyKind === "MASTER_ITEM").map((record) => record.tier));
    if (itemTiers.size > 1) throw new TypeError(`registry snapshot entity maps master items across tiers: ${entity.stableId}`);
    const hasSpecialItem = legacyKinds.has("SPECIAL_ITEM");
    return {
      stableId: entity.stableId,
      kind,
      canonicalName: entity.canonicalName,
      displayNames: entity.displayNames.map((entry) => ({ ...entry, status: remapLegacyStatus(entry.status) })),
      aliases: entity.aliases.map((entry) => ({ ...entry, status: remapLegacyStatus(entry.status) })),
      legacyNames,
      tier: kind === "ITEM" ? (itemTiers.size ? [...itemTiers][0] : null) : null,
      category: kind === "ITEM" && hasSpecialItem ? SPECIAL_CATEGORY : null,
      status: remapLegacyStatus(entity.status),
      provenance: cloneJson(entity.provenance, `entity ${entity.stableId} provenance`),
      replacedBy: entity.replacedBy,
    };
  });
  const unresolvedLegacyNames = snapshot.unresolvedMappings.map((unresolved) => {
    const record = namesByKey.get(unresolved.legacyNameKey);
    if (!record) throw new TypeError(`registry snapshot unresolved mapping references missing legacy name ${unresolved.legacyNameKey}`);
    if (!unresolvedKeys.has(record.legacyNameKey)) throw new TypeError(`invalid unresolved reference ${record.legacyNameKey}`);
    return { ...convertLegacyRecord(record, { unresolved: true }), reason: "NO_CURATED_IDENTITY" };
  });
  const compatibilityMappings = snapshot.compatibilityMappings.map((mapping) => ({
    stableId: mapping.stableId,
    legacyNameKeys: [...mapping.legacyNameKeys],
    sourceLocators: [...mapping.sourceLocators],
  }));
  const snapshotHash = registrySnapshotSha256(snapshot);
  return createMasterBundleV2({
    createdAt,
    entities,
    compatibilityMappings,
    unresolvedLegacyNames,
    sourceRevisions: [{
      sourceType: "TRADE_MASTER_REGISTRY_V1",
      revision: snapshot.source.revision,
      sha256: snapshot.source.sha256,
    }],
    provenance: {
      sourceFormat: "TRADE_MASTER_REGISTRY_V1",
      sourceRegistryVersion: snapshot.registryVersion,
      sourceSnapshotSha256: snapshotHash,
      curationRevision: snapshot.curation.revision,
    },
  });
}

export function validateTradeMasterReferenceManifest(manifest) {
  let cloned;
  try { cloned = cloneJson(manifest, "reference manifest"); }
  catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : "manifest is not JSON data"] }; }
  return validateReferenceManifestInternal(cloned);
}

export function applyTradeMasterReferenceManifestToBundleV2(baseBundle, manifest, options = {}) {
  if (!exactKeys(options, ["createdAt"])) throw new TypeError("reference bundle options must contain exactly createdAt");
  if (!nonempty(options.createdAt)) throw new TypeError("createdAt must be a nonempty caller-supplied string");
  const base = cloneJson(baseBundle, "base Master bundle");
  const baseValidation = validateBundleInternal(base);
  if (!baseValidation.ok) throw new TypeError(`invalid base Master bundle: ${baseValidation.errors.join("; ")}`);
  const source = validateTradeMasterReferenceManifest(manifest);
  if (!source.ok) throw new TypeError(`invalid reference manifest: ${source.errors.join("; ")}`);
  const catalogHash = manifest.scope.catalogSha256;
  if (!base.sourceRevisions.some((revision) => revision.sha256 === catalogHash)) {
    throw new TypeError("reference manifest catalog hash does not match the base bundle source revision");
  }

  const allRecords = [
    ...base.entities.flatMap((entity) => entity.legacyNames),
    ...base.unresolvedLegacyNames.map(({ reason: _reason, ...record }) => record),
  ];
  const sourceByKey = new Map(allRecords.map((record) => [record.legacyNameKey, record]));
  const occurrenceCount = allRecords.reduce((sum, record) => sum + record.occurrences.length, 0);
  if (sourceByKey.size !== manifest.scope.legacyGroupCount || occurrenceCount !== manifest.scope.sourceOccurrenceCount) {
    throw new TypeError("reference manifest scope does not match exact base source accounting");
  }
  const entities = cloneJson(base.entities, "base entities");
  const unresolvedByKey = new Map(base.unresolvedLegacyNames.map((record) => [record.legacyNameKey, cloneJson(record)]));
  const mappings = cloneJson(base.compatibilityMappings, "base compatibility mappings");
  const findings = [];
  const ids = new Map(entities.map((entity) => [entity.stableId, entity]));

  for (const claim of manifest.claims) {
    const record = sourceByKey.get(claim.legacyNameKey);
    if (!record) throw new TypeError(`reference claim references unknown legacyNameKey ${claim.legacyNameKey}`);
    if (record.rawName !== claim.canonicalName || record.legacyKind !== claim.legacyKind || record.tier !== claim.tier) {
      throw new TypeError(`reference claim disagrees with its exact legacy source group ${claim.legacyNameKey}`);
    }
    const existingOwner = entities.find((entity) => entity.legacyNames.some((name) => name.legacyNameKey === claim.legacyNameKey));
    if (existingOwner) {
      if (["VERIFIED_CURATED", "DISPUTED", "DEPRECATED"].includes(existingOwner.status)) continue;
      if (existingOwner.status === "VERIFIED_REFERENCE" && existingOwner.stableId === claim.stableId) continue;
      throw new TypeError(`reference claim cannot replace existing stable identity ${claim.legacyNameKey}`);
    }
    if (!unresolvedByKey.has(claim.legacyNameKey)) throw new TypeError(`reference claim source is not unresolved ${claim.legacyNameKey}`);
    if (ids.has(claim.stableId)) throw new TypeError(`reference stableId already belongs to another entity ${claim.stableId}`);
    const provenance = {
      authority: "VERIFIED_REFERENCE",
      referenceDecision: "MATCHED",
      referenceEvidence: cloneJson(claim.evidence, `claim ${claim.legacyNameKey} evidence`),
    };
    const mappedRecord = { ...cloneJson(record), authorityStatus: "VERIFIED_REFERENCE" };
    const entity = {
      stableId: claim.stableId,
      kind: claim.kind,
      canonicalName: claim.canonicalName,
      displayNames: [{ text: claim.displayName, status: "VERIFIED_REFERENCE", provenance: cloneJson(provenance) }],
      aliases: [],
      legacyNames: [mappedRecord],
      tier: claim.kind === "ITEM" ? claim.tier : null,
      category: claim.category,
      status: "VERIFIED_REFERENCE",
      provenance,
      replacedBy: null,
    };
    entities.push(entity);
    ids.set(entity.stableId, entity);
    const locators = mappedRecord.occurrences.map((occurrence) => occurrence.locator);
    mappings.push({ stableId: claim.stableId, legacyNameKeys: [claim.legacyNameKey], sourceLocators: locators });
    unresolvedByKey.delete(claim.legacyNameKey);
  }

  for (const item of manifest.unresolved) {
    if (!sourceByKey.has(item.legacyNameKey)) throw new TypeError(`unresolved reference result references unknown legacyNameKey ${item.legacyNameKey}`);
    if (!unresolvedByKey.has(item.legacyNameKey)) {
      const existing = entities.find((entity) => entity.legacyNames.some((name) => name.legacyNameKey === item.legacyNameKey));
      if (existing && ["VERIFIED_CURATED", "DISPUTED", "DEPRECATED"].includes(existing.status)) continue;
      if (existing) throw new TypeError(`unresolved finding conflicts with mapped entity ${item.legacyNameKey}`);
      throw new TypeError(`unresolved result is absent from base unresolved names ${item.legacyNameKey}`);
    }
    findings.push({ legacyNameKey: item.legacyNameKey, status: item.status,
      evidenceRefs: item.evidence.filter((entry) => typeof entry.sourceUrl === "string").map((entry) => entry.sourceUrl) });
  }

  const unresolvedLegacyNames = [...unresolvedByKey.values()];
  const provenance = { ...cloneJson(base.provenance),
    referenceAuditHash: manifest.referenceAuditHash,
    referencePolicyVersion: manifest.policyVersion,
    referenceFindings: findings,
  };
  return createMasterBundleV2({
    createdAt: options.createdAt,
    entities,
    compatibilityMappings: mappings,
    unresolvedLegacyNames,
    sourceRevisions: base.sourceRevisions,
    provenance,
  });
}
