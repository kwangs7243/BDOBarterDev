const TIERS = Object.freeze(["1", "2", "3", "4", "5", "6", "7"]);
const ENTITY_KINDS = new Set(["MASTER_ITEM", "SPECIAL_ITEM", "ISLAND"]);
const LIFECYCLE = new Set(["LEGACY_UNVERIFIED", "VERIFIED", "DISPUTED", "DEPRECATED"]);
const NAME_STATUS = new Set(["VERIFIED", "LEGACY_UNVERIFIED", "DISPUTED"]);
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

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  const input = new TextEncoder().encode(value);
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

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateCatalog(catalog) {
  if (!isRecord(catalog)) throw new TypeError("catalog must be an object");
  const expected = ["masterData", "specialItems", "islands", "t6Islands", "t7Islands"];
  if (Object.keys(catalog).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new TypeError("catalog must contain only masterData, specialItems, islands, t6Islands, and t7Islands");
  }
  if (!isRecord(catalog.masterData) || Object.keys(catalog.masterData).sort().join("\0") !== TIERS.join("\0")) {
    throw new TypeError("catalog.masterData must contain tiers 1 through 7");
  }
  const arrays = [
    ...TIERS.map((tier) => [`masterData/${tier}`, catalog.masterData[tier]]),
    ["specialItems", catalog.specialItems], ["islands", catalog.islands],
    ["t6Islands", catalog.t6Islands], ["t7Islands", catalog.t7Islands],
  ];
  for (const [label, values] of arrays) {
    if (!Array.isArray(values)) throw new TypeError(`catalog.${label} must be an array`);
    values.forEach((value, index) => {
      if (!nonempty(value)) throw new TypeError(`catalog.${label}[${index}] must be a nonempty string`);
    });
  }
}

function collectOccurrences(catalog) {
  const result = [];
  for (const tier of TIERS) {
    catalog.masterData[tier].forEach((raw, index) => result.push({
      locator: `/masterData/${tier}/${index}`, raw, kind: "MASTER_ITEM", scope: `MASTER_TIER_${tier}`, tier: Number(tier),
    }));
  }
  catalog.specialItems.forEach((raw, index) => result.push({
    locator: `/specialItems/${index}`, raw, kind: "SPECIAL_ITEM", scope: "SPECIAL_ITEMS", tier: null,
  }));
  for (const [field, scope] of [["islands", "GENERAL_ISLANDS"], ["t6Islands", "T6_ISLANDS"], ["t7Islands", "T7_ISLANDS"]]) {
    catalog[field].forEach((raw, index) => result.push({
      locator: `/${field}/${index}`, raw, kind: "ISLAND", scope, tier: null,
    }));
  }
  return result;
}

function groupingKey(occurrence) {
  // Master items are tier-scoped; islands may share an exact raw token across scopes.
  return stableStringify([occurrence.kind, occurrence.kind === "MASTER_ITEM" ? occurrence.tier : null, occurrence.raw]);
}

function normalizeProvenance(value, label) {
  if (!isRecord(value) || !Array.isArray(value.evidenceRefs) || !(value.note === null || typeof value.note === "string")) {
    throw new TypeError(`${label} provenance must contain evidenceRefs[] and note`);
  }
  if (!value.evidenceRefs.every(nonempty)) throw new TypeError(`${label} provenance evidenceRefs must be nonempty strings`);
  return { evidenceRefs: [...value.evidenceRefs], note: value.note };
}

function normalizeNames(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return values.map((entry, index) => {
    if (!isRecord(entry) || !nonempty(entry.text) || !NAME_STATUS.has(entry.status)) {
      throw new TypeError(`${label}[${index}] requires text and a supported status`);
    }
    return { text: entry.text, status: entry.status, provenance: normalizeProvenance(entry.provenance, `${label}[${index}]`) };
  });
}

function prepareCuratedMappings(curatedMappings) {
  if (curatedMappings === null) return [];
  if (!isRecord(curatedMappings) || curatedMappings.schemaVersion !== 1 || !nonempty(curatedMappings.mappingRevision) || !Array.isArray(curatedMappings.entities)) {
    throw new TypeError("curatedMappings must be schemaVersion 1 with mappingRevision and entities[]");
  }
  const seenIds = new Set();
  return curatedMappings.entities.map((entity, index) => {
    if (!isRecord(entity) || !nonempty(entity.stableId) || !ENTITY_KINDS.has(entity.kind) || !LIFECYCLE.has(entity.status)) {
      throw new TypeError(`curatedMappings.entities[${index}] has invalid identity or lifecycle fields`);
    }
    if (seenIds.has(entity.stableId)) throw new TypeError(`duplicate stableId definition: ${entity.stableId}`);
    seenIds.add(entity.stableId);
    if (!(entity.canonicalName === null || nonempty(entity.canonicalName))) throw new TypeError(`entity ${entity.stableId} canonicalName must be null or nonempty`);
    if (entity.status === "VERIFIED" && entity.canonicalName === null) throw new TypeError(`verified entity ${entity.stableId} requires canonicalName`);
    if (!Array.isArray(entity.legacyNames)) throw new TypeError(`entity ${entity.stableId} legacyNames must be an array`);
    const refs = entity.legacyNames.map((ref, refIndex) => {
      if (!isRecord(ref) || !nonempty(ref.rawName) || !Array.isArray(ref.expectedLocators) || !ref.expectedLocators.length || !ref.expectedLocators.every(nonempty)) {
        throw new TypeError(`entity ${entity.stableId} legacyNames[${refIndex}] requires rawName and expectedLocators[]`);
      }
      if (new Set(ref.expectedLocators).size !== ref.expectedLocators.length) throw new TypeError(`entity ${entity.stableId} has duplicate expected locator`);
      return { rawName: ref.rawName, expectedLocators: [...ref.expectedLocators] };
    });
    return {
      stableId: entity.stableId,
      kind: entity.kind,
      canonicalName: entity.canonicalName,
      status: entity.status,
      legacyNames: refs,
      displayNames: normalizeNames(entity.displayNames ?? [], `entity ${entity.stableId} displayNames`),
      aliases: normalizeNames(entity.aliases ?? [], `entity ${entity.stableId} aliases`),
      provenance: normalizeProvenance(entity.provenance, `entity ${entity.stableId}`),
      replacedBy: entity.replacedBy ?? null,
    };
  });
}

function constructSnapshot(catalog, sourceRevision, sourceSha256, curatedMappings) {
  validateCatalog(catalog);
  if (!nonempty(sourceRevision)) throw new TypeError("sourceRevision must be a nonempty string");
  if (typeof sourceSha256 !== "string" || !/^[a-f\d]{64}$/i.test(sourceSha256)) throw new TypeError("sourceSha256 must be a 64-character SHA-256 hex string");
  const definitions = prepareCuratedMappings(curatedMappings);
  const occurrences = collectOccurrences(catalog);
  const groups = new Map();
  for (const occurrence of occurrences) {
    const key = groupingKey(occurrence);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(occurrence);
  }
  const legacyNames = [...groups.entries()].map(([group, items]) => {
    const first = items[0];
    const legacyNameKey = `legacy-name:v1:${sha256(group)}`; // NOT_STABLE_ID: grouping key only.
    return {
      legacyNameKey,
      kind: first.kind,
      rawName: first.raw,
      tier: first.kind === "MASTER_ITEM" ? first.tier : null,
      occurrences: items.map(({ locator, scope, tier }) => ({ locator, scope, tier })),
      stableId: null,
      authorityStatus: "LEGACY_UNVERIFIED",
    };
  }).sort((a, b) => a.legacyNameKey.localeCompare(b.legacyNameKey));
  const byGroup = new Map(legacyNames.map((name) => [groupingKey({ kind: name.kind, tier: name.tier, raw: name.rawName }), name]));
  const byLocator = new Map(occurrences.map((occurrence) => [occurrence.locator, occurrence]));
  const assigned = new Map();
  const entities = definitions.map((definition) => {
    const references = [];
    const itemTiers = new Set();
    for (const ref of definition.legacyNames) {
      const selected = ref.expectedLocators.map((locator) => {
        const source = byLocator.get(locator);
        if (!source) throw new TypeError(`mapping references nonexistent locator: ${locator}`);
        if (source.raw !== ref.rawName) throw new TypeError(`mapping rawName mismatch at ${locator}`);
        if (source.kind !== definition.kind) throw new TypeError(`mapping kind mismatch at ${locator}`);
        return source;
      });
      const name = byGroup.get(groupingKey(selected[0]));
      if (!name || selected.some((source) => groupingKey(source) !== groupingKey(selected[0]))) {
        throw new TypeError(`mapping locators do not identify one legacy name: ${ref.rawName}`);
      }
      const expected = [...name.occurrences.map((item) => item.locator)].sort();
      const actual = [...ref.expectedLocators].sort();
      if (stableStringify(expected) !== stableStringify(actual)) throw new TypeError(`mapping must enumerate every occurrence for ${ref.rawName}`);
      const prior = assigned.get(name.legacyNameKey);
      if (prior && prior !== definition.stableId) throw new TypeError(`conflicting stableId mapping for ${name.rawName}`);
      assigned.set(name.legacyNameKey, definition.stableId);
      references.push(name);
      if (definition.kind === "MASTER_ITEM") itemTiers.add(name.tier);
    }
    if (itemTiers.size > 1) throw new TypeError(`entity ${definition.stableId} maps master items across tiers`);
    return {
      stableId: definition.stableId,
      kind: definition.kind,
      canonicalName: definition.canonicalName,
      status: definition.status,
      displayNames: definition.displayNames,
      aliases: definition.aliases,
      provenance: definition.provenance,
      replacedBy: definition.replacedBy,
      legacyNameKeys: [...new Set(references.map((name) => name.legacyNameKey))].sort(),
    };
  }).sort((a, b) => a.stableId.localeCompare(b.stableId));
  const entityById = new Map(entities.map((entity) => [entity.stableId, entity]));
  for (const entity of entities) {
    if (entity.replacedBy !== null && !nonempty(entity.replacedBy)) throw new TypeError(`entity ${entity.stableId} replacedBy must be null or a stableId`);
    if (entity.replacedBy === entity.stableId) throw new TypeError(`entity ${entity.stableId} cannot replace itself`);
    if (entity.replacedBy !== null && !entityById.has(entity.replacedBy)) throw new TypeError(`entity ${entity.stableId} replacedBy target does not exist`);
  }
  for (const entity of entities) {
    const visited = new Set([entity.stableId]);
    let next = entity.replacedBy;
    while (next !== null) {
      if (visited.has(next)) throw new TypeError(`replacedBy cycle includes ${entity.stableId}`);
      visited.add(next);
      next = entityById.get(next).replacedBy;
    }
  }
  for (const name of legacyNames) {
    const stableId = assigned.get(name.legacyNameKey) ?? null;
    name.stableId = stableId;
    name.authorityStatus = stableId === null ? "LEGACY_UNVERIFIED" : entityById.get(stableId).status;
  }
  const unresolvedMappings = legacyNames.filter((name) => name.stableId === null).map((name) => ({
    legacyNameKey: name.legacyNameKey, kind: name.kind, rawName: name.rawName, tier: name.tier,
    occurrenceLocators: name.occurrences.map((item) => item.locator), reason: "NO_CURATED_MAPPING",
  }));
  const compatibilityMappings = entities.flatMap((entity) => entity.legacyNameKeys.length ? [{
    stableId: entity.stableId,
    legacyNameKeys: [...entity.legacyNameKeys],
    sourceLocators: entity.legacyNameKeys.flatMap((key) => legacyNames.find((name) => name.legacyNameKey === key).occurrences.map((item) => item.locator)).sort(),
  }] : []);
  const snapshot = {
    schemaVersion: 1,
    registryVersion: "",
    source: { revision: sourceRevision, sha256: sourceSha256.toLowerCase() },
    curation: { revision: curatedMappings?.mappingRevision ?? null },
    legacyNames,
    entities,
    unresolvedMappings,
    compatibilityMappings,
    findings: [],
  };
  // registryVersion hashes semantic payload without itself; the exported SHA-256 hashes the final snapshot.
  const { registryVersion: _omittedVersion, ...semanticPayload } = snapshot;
  snapshot.registryVersion = `registry-v1:${sha256(stableStringify(semanticPayload))}`;
  return deepFreeze(snapshot);
}

export function adaptLegacyCatalog(catalog, { sourceRevision, sourceSha256, curatedMappings = null } = {}) {
  return constructSnapshot(catalog, sourceRevision, sourceSha256, curatedMappings);
}

export function registrySnapshotSha256(snapshot) {
  // This hash covers the complete immutable snapshot, including its non-recursive registryVersion label.
  return sha256(stableStringify(snapshot));
}

export function validateRegistrySnapshot(snapshot) {
  const errors = [];
  const warnings = [];
  const fail = (message) => errors.push(message);
  if (!isRecord(snapshot)) return { ok: false, errors: ["snapshot must be an object"], warnings };
  if (snapshot.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!nonempty(snapshot.registryVersion) || !snapshot.registryVersion.startsWith("registry-v1:")) fail("registryVersion must be a registry-v1 label");
  if (!isRecord(snapshot.source) || !nonempty(snapshot.source.revision) || typeof snapshot.source.sha256 !== "string" || !/^[a-f\d]{64}$/.test(snapshot.source.sha256)) fail("source revision and SHA-256 are required");
  if (!isRecord(snapshot.curation) || !(snapshot.curation.revision === null || nonempty(snapshot.curation.revision))) fail("curation revision must be null or a nonempty string");
  for (const key of ["legacyNames", "entities", "unresolvedMappings", "compatibilityMappings", "findings"]) if (!Array.isArray(snapshot[key])) fail(`${key} must be an array`);
  if (errors.length) return { ok: false, errors, warnings };
  const { registryVersion, ...semanticPayload } = snapshot;
  if (registryVersion !== `registry-v1:${sha256(stableStringify(semanticPayload))}`) fail("registryVersion does not match snapshot semantic content");
  const namesByKey = new Map();
  for (const name of snapshot.legacyNames) {
    if (!isRecord(name) || !nonempty(name.legacyNameKey) || !ENTITY_KINDS.has(name.kind) || !nonempty(name.rawName) || !Array.isArray(name.occurrences)) { fail("invalid legacyNames record"); continue; }
    if (namesByKey.has(name.legacyNameKey)) fail(`duplicate legacyNameKey ${name.legacyNameKey}`);
    namesByKey.set(name.legacyNameKey, name);
    if (name.kind === "MASTER_ITEM" ? !Number.isInteger(name.tier) || name.tier < 1 || name.tier > 7 : name.tier !== null) fail(`invalid tier for ${name.legacyNameKey}`);
    if (!(name.stableId === null || nonempty(name.stableId))) fail(`invalid stableId for ${name.legacyNameKey}`);
    if (!LIFECYCLE.has(name.authorityStatus)) fail(`invalid authorityStatus for ${name.legacyNameKey}`);
    if (name.stableId === null && name.authorityStatus !== "LEGACY_UNVERIFIED") fail(`unmapped name must be LEGACY_UNVERIFIED: ${name.legacyNameKey}`);
    for (const occurrence of name.occurrences) if (!isRecord(occurrence) || !nonempty(occurrence.locator) || !nonempty(occurrence.scope)) fail(`invalid occurrence for ${name.legacyNameKey}`);
  }
  const entitiesById = new Map();
  for (const entity of snapshot.entities) {
    if (!isRecord(entity) || !nonempty(entity.stableId) || !ENTITY_KINDS.has(entity.kind) || !LIFECYCLE.has(entity.status) || !Array.isArray(entity.legacyNameKeys)) { fail("invalid entity record"); continue; }
    if (entitiesById.has(entity.stableId)) fail(`duplicate stableId ${entity.stableId}`);
    entitiesById.set(entity.stableId, entity);
    if (!(entity.canonicalName === null || nonempty(entity.canonicalName))) fail(`invalid canonicalName for ${entity.stableId}`);
    if (entity.status === "VERIFIED" && entity.canonicalName === null) fail(`verified entity lacks canonicalName: ${entity.stableId}`);
    const tiers = new Set();
    for (const key of entity.legacyNameKeys) {
      const name = namesByKey.get(key);
      if (!name) { fail(`entity references unknown legacyNameKey ${key}`); continue; }
      if (name.kind !== entity.kind) fail(`entity kind mismatch for ${key}`);
      if (name.stableId !== entity.stableId) fail(`legacy name stableId mismatch for ${key}`);
      if (name.kind === "MASTER_ITEM") tiers.add(name.tier);
    }
    if (tiers.size > 1) fail(`entity maps master items across tiers: ${entity.stableId}`);
    for (const listName of ["displayNames", "aliases"]) {
      if (!Array.isArray(entity[listName])) { fail(`${listName} must be an array for ${entity.stableId}`); continue; }
      for (const entry of entity[listName]) if (!isRecord(entry) || !nonempty(entry.text) || !NAME_STATUS.has(entry.status) || !isRecord(entry.provenance)) fail(`invalid ${listName} entry for ${entity.stableId}`);
    }
  }
  for (const name of namesByKey.values()) if (name.stableId !== null && !entitiesById.has(name.stableId)) fail(`legacy name references unknown stableId ${name.stableId}`);
  for (const entity of entitiesById.values()) {
    if (entity.replacedBy !== null && entity.replacedBy !== undefined && !entitiesById.has(entity.replacedBy)) fail(`unknown replacedBy target for ${entity.stableId}`);
    if (entity.replacedBy === entity.stableId) fail(`self replacedBy for ${entity.stableId}`);
    const visited = new Set([entity.stableId]);
    let next = entity.replacedBy ?? null;
    while (next !== null && entitiesById.has(next)) {
      if (visited.has(next)) { fail(`replacedBy cycle includes ${entity.stableId}`); break; }
      visited.add(next);
      next = entitiesById.get(next).replacedBy ?? null;
    }
  }
  const unresolvedKeys = new Set();
  for (const unresolved of snapshot.unresolvedMappings) {
    if (!isRecord(unresolved) || !namesByKey.has(unresolved.legacyNameKey) || unresolved.reason !== "NO_CURATED_MAPPING") { fail("invalid unresolved mapping"); continue; }
    if (unresolvedKeys.has(unresolved.legacyNameKey)) fail(`duplicate unresolved mapping ${unresolved.legacyNameKey}`);
    unresolvedKeys.add(unresolved.legacyNameKey);
    if (namesByKey.get(unresolved.legacyNameKey).stableId !== null) fail(`mapped name listed unresolved: ${unresolved.legacyNameKey}`);
  }
  for (const name of namesByKey.values()) if ((name.stableId === null) !== unresolvedKeys.has(name.legacyNameKey)) fail(`unresolved coverage mismatch: ${name.legacyNameKey}`);
  for (const mapping of snapshot.compatibilityMappings) {
    if (!isRecord(mapping) || !entitiesById.has(mapping.stableId) || !Array.isArray(mapping.legacyNameKeys) || !Array.isArray(mapping.sourceLocators)) { fail("invalid compatibility mapping"); continue; }
    for (const key of mapping.legacyNameKeys) if (namesByKey.get(key)?.stableId !== mapping.stableId) fail(`compatibility mapping mismatch for ${key}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}
