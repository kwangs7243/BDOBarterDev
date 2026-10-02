"""Dedicated immutable storage for owner-approved Master Bundle v2 snapshots."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .catalog_provenance import (
    CATALOG_PROVENANCE_HASH_BASIS,
    compute_catalog_provenance_v2,
)

MASTER_STORE_SCHEMA_VERSION = 1
MASTER_BUNDLE_SCHEMA_VERSION = 2
MASTER_HASH_BASIS = "MASTER_CANONICAL_JSON_V2"
REGISTRY_PREFIX = "registry-v2:"
MAX_SAFE_INTEGER = (1 << 53) - 1
HASH_RE = re.compile(r"^[a-f0-9]{64}$")
STATUSES = {"LEGACY_UNVERIFIED", "VERIFIED_REFERENCE", "VERIFIED_CURATED", "DISPUTED", "DEPRECATED"}
TOP_KEYS = {
    "schemaVersion", "registryVersion", "createdAt", "entities", "compatibilityMappings",
    "unresolvedLegacyNames", "sourceRevisions", "provenance", "hashBasis", "contentHash",
}
ENTITY_KEYS = {
    "stableId", "kind", "canonicalName", "displayNames", "aliases", "legacyNames", "tier",
    "category", "status", "provenance", "replacedBy",
}
LEGACY_KEYS = {"legacyNameKey", "legacyKind", "rawName", "tier", "occurrences", "authorityStatus"}


class MasterStoreError(RuntimeError):
    """Base error for invalid store state or operations."""


class FutureMasterSchemaError(MasterStoreError):
    pass


class MasterRevisionConflict(MasterStoreError):
    pass


class MasterMutationConflict(MasterStoreError):
    pass


class InvalidMasterBundle(MasterStoreError):
    pass


class _RejectNumber(ValueError):
    pass


def _valid_reference_evidence(entry: Any) -> bool:
    if not isinstance(entry, dict) or set(entry) != {"sourceKind", "sourceUrl", "checkedAt", "externalId", "verifiedProperties"}:
        return False
    if not isinstance(entry["sourceUrl"], str) or not isinstance(entry["checkedAt"], str):
        return False
    if entry["externalId"] is not None and (not isinstance(entry["externalId"], str) or not entry["externalId"].strip()):
        return False
    try:
        checked = datetime.fromisoformat(entry["checkedAt"].replace("Z", "+00:00"))
        if checked.tzinfo is None or checked.utcoffset() is None or not entry["checkedAt"].endswith("Z"):
            return False
        parsed = urlparse(entry["sourceUrl"])
    except (ValueError, TypeError):
        return False
    if parsed.scheme != "https" or parsed.username or parsed.password:
        return False
    if entry["sourceKind"] == "BDO_OFFICIAL_KR":
        if parsed.hostname not in {"kr.playblackdesert.com", "www.kr.playblackdesert.com"} or not parsed.path.startswith("/ko-KR/"):
            return False
    elif entry["sourceKind"] == "BDOCODEX_KR":
        if parsed.hostname != "bdocodex.com" or not parsed.path.startswith("/kr/"):
            return False
    else:
        return False
    allowed = {"canonicalName", "displayName", "tier", "category", "identity"}
    values = entry["verifiedProperties"]
    return (isinstance(values, list) and bool(values)
            and all(isinstance(value, str) for value in values)
            and len(set(values)) == len(values)
            and all(value in allowed for value in values))


def _validate_reference_provenance(provenance: Any, label: str) -> None:
    if (not isinstance(provenance, dict) or provenance.get("authority") != "VERIFIED_REFERENCE"
            or provenance.get("referenceDecision") != "MATCHED"
            or not isinstance(provenance.get("referenceEvidence"), list)
            or not provenance["referenceEvidence"]
            or not all(_valid_reference_evidence(item) for item in provenance["referenceEvidence"])):
        raise InvalidMasterBundle(f"{label} VERIFIED_REFERENCE provenance is invalid")


def validate_reference_manifest(manifest: Any, *, expected_catalog_sha256: str | None = None,
                                catalog_bytes: bytes | None = None) -> dict[str, Any]:
    """Validate the committed M4 reference manifest without trusting caller claims."""
    _json_safe(manifest, "referenceManifest")
    manifest = _object(manifest, "referenceManifest")
    version = manifest.get("schemaVersion")
    v2 = version == 2
    top_keys = ({"schemaVersion", "policyVersion", "scope", "migration", "claims", "unresolved", "referenceAuditHash"}
                if v2 else {"schemaVersion", "policyVersion", "scope", "claims", "unresolved", "referenceAuditHash"})
    expected_policy = "trade-master-reference-v2" if v2 else "trade-master-reference-v1"
    if set(manifest) != top_keys or version not in {1, 2} or manifest["policyVersion"] != expected_policy:
        raise InvalidMasterBundle("reference manifest has an unsupported schema or fields")
    scope = _object(manifest["scope"], "referenceManifest.scope")
    scope_keys = ({"originalHtmlSha256", "catalogDigest", "sourceOccurrenceCount", "legacyGroupCount"}
                  if v2 else {"originalHtmlSha256", "catalogSha256", "sourceOccurrenceCount", "legacyGroupCount"})
    if set(scope) != scope_keys:
        raise InvalidMasterBundle("reference manifest scope has invalid fields")
    if not isinstance(scope["originalHtmlSha256"], str) or not HASH_RE.fullmatch(scope["originalHtmlSha256"]):
        raise InvalidMasterBundle("reference manifest scope originalHtmlSha256 is invalid")
    if v2:
        digest = _object(scope["catalogDigest"], "referenceManifest.scope.catalogDigest")
        if (set(digest) != {"schemaVersion", "hashBasis", "sha256"} or digest["schemaVersion"] != 2
                or digest["hashBasis"] != CATALOG_PROVENANCE_HASH_BASIS
                or not isinstance(digest["sha256"], str) or not HASH_RE.fullmatch(digest["sha256"])):
            raise InvalidMasterBundle("reference manifest catalogDigest has invalid schema, basis, or hash")
        migration = _object(manifest["migration"], "referenceManifest.migration")
        if (set(migration) != {"fromManifestSchemaVersion", "fromReferenceAuditHash", "fromCatalogRawSha256"}
                or migration["fromManifestSchemaVersion"] != 1
                or migration["fromReferenceAuditHash"] != "46c10355ccf3b8b5aba08880cd5947408cc66720dafdccef4d9deeb12ab2df82"
                or migration["fromCatalogRawSha256"] != "8183b03e6aa0ee354142cf9720b401494bec365e528632f3c0c84ec11b46b4b3"):
            raise InvalidMasterBundle("reference manifest migration does not identify the approved v1 baseline")
        if expected_catalog_sha256 is not None:
            raise InvalidMasterBundle("v2 catalog validation requires source bytes, not a caller-provided hash")
        if catalog_bytes is not None:
            try:
                computed = compute_catalog_provenance_v2(catalog_bytes)
            except (TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise InvalidMasterBundle(f"bundled catalog provenance is invalid: {exc}") from exc
            if computed["sha256"] != digest["sha256"]:
                raise InvalidMasterBundle("reference manifest catalog digest does not match the bundled catalog")
    else:
        if not isinstance(scope["catalogSha256"], str) or not HASH_RE.fullmatch(scope["catalogSha256"]):
            raise InvalidMasterBundle("reference manifest scope catalogSha256 is invalid")
        if catalog_bytes is not None:
            raise InvalidMasterBundle("v1 catalog validation uses its existing raw-byte hash contract")
        if expected_catalog_sha256 is not None and scope["catalogSha256"] != expected_catalog_sha256:
            raise InvalidMasterBundle("reference manifest catalog hash does not match the bundled catalog")
    for key in ("sourceOccurrenceCount", "legacyGroupCount"):
        if isinstance(scope[key], bool) or not isinstance(scope[key], int) or scope[key] < 0:
            raise InvalidMasterBundle(f"reference manifest scope {key} is invalid")
    if not isinstance(manifest["claims"], list) or not isinstance(manifest["unresolved"], list):
        raise InvalidMasterBundle("reference manifest claims and unresolved must be arrays")
    accounted: set[str] = set()
    stable_ids: set[str] = set()
    claim_keys = {"legacyNameKey", "stableId", "kind", "legacyKind", "canonicalName", "displayName",
                  "tier", "category", "decision", "evidence"}
    for index, claim in enumerate(manifest["claims"]):
        label = f"referenceManifest.claims[{index}]"
        claim = _object(claim, label)
        if set(claim) != claim_keys:
            raise InvalidMasterBundle(f"{label} has invalid fields")
        key = _string(claim["legacyNameKey"], f"{label}.legacyNameKey")
        if key in accounted:
            raise InvalidMasterBundle("reference manifest accounts for a legacy name more than once")
        accounted.add(key)
        stable_id = _string(claim["stableId"], f"{label}.stableId")
        try:
            parsed_id = uuid.UUID(stable_id)
            if str(parsed_id) != stable_id or parsed_id.version != 4:
                raise ValueError
        except (ValueError, AttributeError) as exc:
            raise InvalidMasterBundle(f"{label}.stableId must be a pinned canonical UUID v4") from exc
        if stable_id in stable_ids:
            raise InvalidMasterBundle("reference manifest stableIds must be unique")
        stable_ids.add(stable_id)
        if claim["kind"] not in {"ITEM", "ISLAND"} or claim["legacyKind"] not in {"MASTER_ITEM", "SPECIAL_ITEM", "ISLAND"}:
            raise InvalidMasterBundle(f"{label} has invalid kind")
        if (claim["legacyKind"] == "ISLAND") != (claim["kind"] == "ISLAND"):
            raise InvalidMasterBundle(f"{label} kind disagrees with legacy kind")
        _string(claim["canonicalName"], f"{label}.canonicalName")
        _string(claim["displayName"], f"{label}.displayName")
        if claim["legacyKind"] == "MASTER_ITEM":
            if isinstance(claim["tier"], bool) or not isinstance(claim["tier"], int) or not 1 <= claim["tier"] <= 7:
                raise InvalidMasterBundle(f"{label}.tier must be 1..7")
        elif claim["tier"] is not None:
            raise InvalidMasterBundle(f"{label}.tier must be null")
        expected_category = "LEGACY_SPECIAL_ITEM" if claim["legacyKind"] == "SPECIAL_ITEM" else None
        if claim["category"] != expected_category or claim["decision"] != "VERIFIED_REFERENCE":
            raise InvalidMasterBundle(f"{label} category or decision is invalid")
        if not isinstance(claim["evidence"], list) or not claim["evidence"]:
            raise InvalidMasterBundle(f"{label}.evidence is required")
        for evidence in claim["evidence"]:
            if not _valid_reference_evidence(evidence):
                raise InvalidMasterBundle(f"{label} has invalid Korean reference evidence")
    for index, unresolved in enumerate(manifest["unresolved"]):
        label = f"referenceManifest.unresolved[{index}]"
        unresolved = _object(unresolved, label)
        if set(unresolved) != {"legacyNameKey", "status", "evidence", "note"}:
            raise InvalidMasterBundle(f"{label} has invalid fields")
        key = _string(unresolved["legacyNameKey"], f"{label}.legacyNameKey")
        if key in accounted:
            raise InvalidMasterBundle("reference manifest claim/unresolved overlap or duplicate")
        accounted.add(key)
        if unresolved["status"] not in {"SOURCE_CONFLICT", "TIER_CONFLICT", "NO_DIRECT_REFERENCE"}:
            raise InvalidMasterBundle(f"{label}.status is invalid")
        if not isinstance(unresolved["evidence"], list):
            raise InvalidMasterBundle(f"{label}.evidence must be an array")
        _string(unresolved["note"], f"{label}.note")
    if len(accounted) != scope["legacyGroupCount"]:
        raise InvalidMasterBundle("reference manifest legacy-group scope does not match accounted names")
    if v2 and (len(manifest["claims"]) != 87 or len(manifest["unresolved"]) != 143
               or scope["sourceOccurrenceCount"] != 241 or scope["legacyGroupCount"] != 230):
        raise InvalidMasterBundle("reference manifest does not match the frozen 87/143/241/230 baseline")
    semantic = {key: value for key, value in manifest.items() if key != "referenceAuditHash"}
    expected_hash = hashlib.sha256(_canonical_json(semantic).encode("utf-8", errors="strict")).hexdigest()
    if manifest["referenceAuditHash"] != expected_hash:
        raise InvalidMasterBundle("reference manifest hash does not match semantic content")
    return json.loads(_canonical_json(manifest))


def validate_reference_bundle_against_manifest(bundle: Any, manifest: Any) -> None:
    """Require all reference authority in a proposed bundle to match the approved manifest exactly."""
    bundle = validate_master_bundle(bundle)
    manifest = validate_reference_manifest(manifest)
    reference_entities = [entity for entity in bundle["entities"] if entity["status"] == "VERIFIED_REFERENCE"]
    if not reference_entities:
        return
    if bundle["provenance"].get("referenceAuditHash") != manifest["referenceAuditHash"]:
        raise InvalidMasterBundle("reference bundle is not bound to the approved reference manifest")
    if manifest["schemaVersion"] == 2:
        digest = manifest["scope"]["catalogDigest"]["sha256"]
        expected_source = {"sourceType": "TRADE_CATALOG_TEXT_V2",
                           "revision": f"catalog-provenance-v2:{digest}", "sha256": digest}
        expected_provenance = {"schemaVersion": 2, "hashBasis": CATALOG_PROVENANCE_HASH_BASIS, "sha256": digest}
        if (bundle["sourceRevisions"] != [expected_source]
                or bundle["provenance"].get("catalogProvenance") != expected_provenance):
            raise InvalidMasterBundle("reference bundle catalog provenance disagrees with the v2 manifest")
    claims = {claim["legacyNameKey"]: claim for claim in manifest["claims"]}
    bundle_reference_keys: set[str] = set()
    protected_owner_keys: set[str] = set()
    for entity in bundle["entities"]:
        for record in entity["legacyNames"]:
            key = record["legacyNameKey"]
            if entity["status"] != "VERIFIED_REFERENCE":
                if key in claims and entity["status"] in {"VERIFIED_CURATED", "DISPUTED", "DEPRECATED"}:
                    protected_owner_keys.add(key)
                continue
            claim = claims.get(key)
            if claim is None:
                raise InvalidMasterBundle("bundle contains a reference mapping absent from the approved manifest")
            if (entity["stableId"] != claim["stableId"] or entity["kind"] != claim["kind"]
                    or entity["canonicalName"] != claim["canonicalName"] or entity["tier"] != claim["tier"]
                    or entity["category"] != claim["category"] or record["legacyKind"] != claim["legacyKind"]
                    or record["rawName"] != claim["canonicalName"] or record["authorityStatus"] != "VERIFIED_REFERENCE"):
                raise InvalidMasterBundle("bundle reference mapping disagrees with the approved manifest")
            provenance = entity["provenance"]
            if provenance.get("referenceEvidence") != claim["evidence"]:
                raise InvalidMasterBundle("bundle reference evidence disagrees with the approved manifest")
            bundle_reference_keys.add(key)
    if bundle_reference_keys | protected_owner_keys != set(claims):
        raise InvalidMasterBundle("bundle reference mappings do not exactly account for manifest claims")


def default_master_database_path() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise MasterStoreError("LOCALAPPDATA is not configured")
    return Path(local_app_data) / "BDOBarter" / "master" / "master.sqlite3"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _json_safe(value: Any, path: str = "bundle", depth: int = 0, budget: list[int] | None = None) -> None:
    if budget is None:
        budget = [250_000]
    budget[0] -= 1
    if budget[0] < 0 or depth > 40:
        raise InvalidMasterBundle(f"{path} exceeds structural limits")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        try:
            value.encode("utf-8", errors="strict")
        except UnicodeEncodeError as exc:
            raise InvalidMasterBundle(f"{path} contains invalid Unicode") from exc
        return
    if isinstance(value, int):
        if value < -MAX_SAFE_INTEGER or value > MAX_SAFE_INTEGER:
            raise InvalidMasterBundle(f"{path} must contain only JavaScript safe integers")
        return
    if isinstance(value, float):
        raise InvalidMasterBundle(f"{path} must not contain floats, NaN, Infinity, or negative zero")
    if isinstance(value, list):
        for index, item in enumerate(value):
            _json_safe(item, f"{path}[{index}]", depth + 1, budget)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise InvalidMasterBundle(f"{path} object keys must be strings")
            _json_safe(key, f"{path} key", depth + 1, budget)
            _json_safe(item, f"{path}.{key}", depth + 1, budget)
        return
    raise InvalidMasterBundle(f"{path} is not JSON data")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def master_bundle_content_hash(bundle: dict[str, Any]) -> str:
    """Hash the exact M1 semantic content basis (excluding three audit/derived keys)."""
    _json_safe(bundle)
    semantic = {key: value for key, value in bundle.items()
                if key not in {"createdAt", "registryVersion", "contentHash"}}
    try:
        payload = _canonical_json(semantic).encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise InvalidMasterBundle(f"cannot canonicalize bundle: {exc}") from exc
    return hashlib.sha256(payload).hexdigest()


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise InvalidMasterBundle(f"{label} must be an object")
    return value


def _string(value: Any, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise InvalidMasterBundle(f"{label} must be a nonempty string")
    return value


def _has_machine_path(value: Any) -> bool:
    if isinstance(value, str):
        return bool(re.match(r"^(?:[a-z]:[\\/]|\\\\|/(?!/)|file://)", value, re.IGNORECASE))
    if isinstance(value, list):
        return any(_has_machine_path(item) for item in value)
    if isinstance(value, dict):
        return any(_has_machine_path(item) for item in value.values())
    return False


def validate_master_bundle(bundle: Any) -> dict[str, Any]:
    """Validate M1 v2 storage invariants and return a detached JSON copy."""
    _json_safe(bundle)
    bundle = _object(bundle, "bundle")
    if set(bundle) != TOP_KEYS:
        raise InvalidMasterBundle("bundle must contain exactly the Master Bundle v2 canonical fields")
    if bundle["schemaVersion"] != MASTER_BUNDLE_SCHEMA_VERSION:
        raise InvalidMasterBundle("schemaVersion must equal 2")
    if bundle["hashBasis"] != MASTER_HASH_BASIS:
        raise InvalidMasterBundle("hashBasis must equal MASTER_CANONICAL_JSON_V2")
    content_hash = bundle["contentHash"]
    if not isinstance(content_hash, str) or not HASH_RE.fullmatch(content_hash):
        raise InvalidMasterBundle("contentHash must be lowercase SHA-256 hex")
    if bundle["registryVersion"] != f"{REGISTRY_PREFIX}{content_hash}":
        raise InvalidMasterBundle("registryVersion must equal registry-v2:<contentHash>")
    _string(bundle["createdAt"], "createdAt")
    if master_bundle_content_hash(bundle) != content_hash:
        raise InvalidMasterBundle("contentHash does not match semantic content")
    for key in ("entities", "compatibilityMappings", "unresolvedLegacyNames", "sourceRevisions"):
        if not isinstance(bundle[key], list):
            raise InvalidMasterBundle(f"{key} must be an array")
    if _has_machine_path(_object(bundle["provenance"], "provenance")):
        raise InvalidMasterBundle("provenance cannot contain absolute filesystem paths")

    entities: dict[str, dict[str, Any]] = {}
    legacy_owner: dict[str, str | None] = {}
    locator_owner: dict[str, str] = {}
    for index, raw_entity in enumerate(bundle["entities"]):
        entity = _object(raw_entity, f"entities[{index}]")
        if set(entity) != ENTITY_KEYS:
            raise InvalidMasterBundle(f"entities[{index}] has invalid fields")
        stable_id = _string(entity["stableId"], f"entities[{index}].stableId")
        try:
            if str(uuid.UUID(stable_id)) != stable_id:
                raise ValueError
        except (ValueError, AttributeError) as exc:
            raise InvalidMasterBundle(f"entities[{index}].stableId must be a canonical UUID") from exc
        if stable_id in entities:
            raise InvalidMasterBundle(f"duplicate stableId: {stable_id}")
        entities[stable_id] = entity
        kind = entity["kind"]
        if kind not in {"ITEM", "ISLAND"}:
            raise InvalidMasterBundle(f"entities[{index}].kind must be ITEM or ISLAND")
        if entity["status"] not in STATUSES:
            raise InvalidMasterBundle(f"entities[{index}].status is unknown")
        canonical = entity["canonicalName"]
        if canonical is not None:
            _string(canonical, f"entities[{index}].canonicalName")
        if entity["status"] == "VERIFIED_CURATED" and canonical is None:
            raise InvalidMasterBundle(f"entities[{index}].canonicalName required for VERIFIED_CURATED")
        if entity["status"] == "VERIFIED_REFERENCE":
            if canonical is None:
                raise InvalidMasterBundle(f"entities[{index}].canonicalName required for VERIFIED_REFERENCE")
            _validate_reference_provenance(entity["provenance"], f"entities[{index}]")
        tier = entity["tier"]
        if tier is not None and (isinstance(tier, bool) or not isinstance(tier, int) or tier < 1 or tier > 7):
            raise InvalidMasterBundle(f"entities[{index}].tier must be null or 1..7")
        if kind == "ISLAND" and (tier is not None or entity["category"] is not None):
            raise InvalidMasterBundle(f"entities[{index}] island cannot have tier/category")
        if entity["category"] is not None:
            _string(entity["category"], f"entities[{index}].category")
        if _has_machine_path(_object(entity["provenance"], f"entities[{index}].provenance")):
            raise InvalidMasterBundle("entity provenance cannot contain absolute filesystem paths")
        for collection in ("displayNames", "aliases"):
            if not isinstance(entity[collection], list):
                raise InvalidMasterBundle(f"entities[{index}].{collection} must be an array")
            for entry in entity[collection]:
                entry = _object(entry, f"entities[{index}].{collection} entry")
                if set(entry) != {"text", "status", "provenance"}:
                    raise InvalidMasterBundle(f"entities[{index}].{collection} entry has invalid fields")
                _string(entry["text"], "name text")
                if entry["status"] not in STATUSES:
                    raise InvalidMasterBundle("name status is unknown")
                if _has_machine_path(_object(entry["provenance"], "name provenance")):
                    raise InvalidMasterBundle("name provenance cannot contain absolute filesystem paths")
                if entry["status"] == "VERIFIED_REFERENCE":
                    _validate_reference_provenance(entry["provenance"], "name entry")
        names = entity["legacyNames"]
        if not isinstance(names, list):
            raise InvalidMasterBundle("legacyNames must be an array")
        for record in names:
            record = _object(record, "legacy name")
            if set(record) != LEGACY_KEYS:
                raise InvalidMasterBundle("legacy name has invalid fields")
            key = _string(record["legacyNameKey"], "legacyNameKey")
            if key in legacy_owner:
                raise InvalidMasterBundle(f"legacy name is accounted more than once: {key}")
            legacy_owner[key] = stable_id
            if record["legacyKind"] not in {"MASTER_ITEM", "SPECIAL_ITEM", "ISLAND"}:
                raise InvalidMasterBundle("legacyKind is invalid")
            if (record["legacyKind"] == "ISLAND") != (kind == "ISLAND"):
                raise InvalidMasterBundle("legacy name kind does not match entity")
            if record["legacyKind"] == "MASTER_ITEM" and record["tier"] != tier:
                raise InvalidMasterBundle("legacy master item tier does not match entity")
            if record["authorityStatus"] not in STATUSES:
                raise InvalidMasterBundle("legacy authorityStatus is unknown")
            if record["authorityStatus"] == "VERIFIED_CURATED" and entity["status"] != "VERIFIED_CURATED":
                raise InvalidMasterBundle("curated legacy authority cannot exceed its entity")
            if record["authorityStatus"] == "VERIFIED_REFERENCE" and entity["status"] not in {"VERIFIED_REFERENCE", "VERIFIED_CURATED"}:
                raise InvalidMasterBundle("reference legacy authority cannot exceed its entity")
            if not isinstance(record["occurrences"], list):
                raise InvalidMasterBundle("legacy occurrences must be an array")
            for occurrence in record["occurrences"]:
                occurrence = _object(occurrence, "legacy occurrence")
                if set(occurrence) != {"locator", "scope", "tier"}:
                    raise InvalidMasterBundle("legacy occurrence has invalid fields")
                locator = _string(occurrence["locator"], "occurrence locator")
                _string(occurrence["scope"], "occurrence scope")
                if locator in locator_owner:
                    raise InvalidMasterBundle(f"source locator is accounted more than once: {locator}")
                locator_owner[locator] = key
        replaced_by = entity["replacedBy"]
        if replaced_by is not None:
            _string(replaced_by, "replacedBy")

    unresolved_keys: set[str] = set()
    for index, raw in enumerate(bundle["unresolvedLegacyNames"]):
        record = _object(raw, f"unresolvedLegacyNames[{index}]")
        if set(record) != LEGACY_KEYS | {"reason"}:
            raise InvalidMasterBundle("unresolved legacy record has invalid fields")
        key = _string(record["legacyNameKey"], "unresolved legacyNameKey")
        if key in legacy_owner or key in unresolved_keys:
            raise InvalidMasterBundle(f"legacy name is accounted more than once: {key}")
        if record["reason"] != "NO_CURATED_IDENTITY" or record["authorityStatus"] != "LEGACY_UNVERIFIED":
            raise InvalidMasterBundle("unresolved record has invalid authority/reason")
        if (record["legacyKind"] not in {"MASTER_ITEM", "SPECIAL_ITEM", "ISLAND"}
                or not isinstance(record["rawName"], str) or not record["rawName"].strip()
                or not isinstance(record["occurrences"], list) or not record["occurrences"]):
            raise InvalidMasterBundle("unresolved legacy record has invalid source data")
        if record["legacyKind"] == "MASTER_ITEM":
            if isinstance(record["tier"], bool) or not isinstance(record["tier"], int) or not 1 <= record["tier"] <= 7:
                raise InvalidMasterBundle("unresolved MASTER_ITEM requires tier 1..7")
        elif record["tier"] is not None:
            raise InvalidMasterBundle("unresolved non-MASTER_ITEM tier must be null")
        unresolved_keys.add(key)
        legacy_owner[key] = None
        for occurrence in record["occurrences"]:
            occurrence = _object(occurrence, "unresolved occurrence")
            if set(occurrence) != {"locator", "scope", "tier"}:
                raise InvalidMasterBundle("unresolved occurrence has invalid fields")
            locator = _string(occurrence.get("locator"), "occurrence locator")
            _string(occurrence.get("scope"), "occurrence scope")
            expected_tier = record["tier"] if record["legacyKind"] == "MASTER_ITEM" else None
            if occurrence["tier"] != expected_tier:
                raise InvalidMasterBundle("unresolved occurrence tier does not match legacy record")
            if locator in locator_owner:
                raise InvalidMasterBundle(f"source locator is accounted more than once: {locator}")
            locator_owner[locator] = key

    for stable_id, entity in entities.items():
        replacement = entity["replacedBy"]
        if replacement is not None and replacement not in entities:
            raise InvalidMasterBundle(f"unknown replacedBy target: {replacement}")
        seen = {stable_id}
        cursor = replacement
        while cursor is not None:
            if cursor in seen:
                raise InvalidMasterBundle("replacedBy contains a cycle")
            seen.add(cursor)
            cursor = entities[cursor]["replacedBy"]

    mapped_keys: set[str] = set()
    mapped_locators: set[str] = set()
    mappings_per_entity: dict[str, int] = {}
    for mapping in bundle["compatibilityMappings"]:
        mapping = _object(mapping, "compatibility mapping")
        if set(mapping) != {"stableId", "legacyNameKeys", "sourceLocators"}:
            raise InvalidMasterBundle("compatibility mapping has invalid fields")
        stable_id = _string(mapping["stableId"], "mapping stableId")
        if stable_id not in entities:
            raise InvalidMasterBundle("compatibility mapping references unknown entity")
        mappings_per_entity[stable_id] = mappings_per_entity.get(stable_id, 0) + 1
        if not isinstance(mapping["legacyNameKeys"], list) or not mapping["legacyNameKeys"] or not isinstance(mapping["sourceLocators"], list):
            raise InvalidMasterBundle("compatibility mapping requires name keys and locator arrays")
        expected_locators: list[str] = []
        for key in mapping["legacyNameKeys"]:
            if key in mapped_keys or legacy_owner.get(key) != stable_id:
                raise InvalidMasterBundle("compatibility mapping disagrees with legacy identity")
            mapped_keys.add(key)
            entity_record = next((r for r in entities[stable_id]["legacyNames"] if r["legacyNameKey"] == key), None)
            if entity_record is None:
                raise InvalidMasterBundle("compatibility mapping key is not owned by entity")
            expected_locators.extend(o["locator"] for o in entity_record["occurrences"])
        actual = mapping["sourceLocators"]
        if any(not isinstance(x, str) for x in actual) or len(set(actual)) != len(actual) or sorted(actual) != sorted(expected_locators):
            raise InvalidMasterBundle("compatibility sourceLocators do not enumerate mapped occurrences")
        if mapped_locators.intersection(actual):
            raise InvalidMasterBundle("source locator is mapped more than once")
        mapped_locators.update(actual)
    for stable_id, entity in entities.items():
        owned_keys = {r["legacyNameKey"] for r in entity["legacyNames"]}
        if owned_keys and mappings_per_entity.get(stable_id) != 1:
            raise InvalidMasterBundle("entity legacy names must have exactly one compatibility mapping")
        if not owned_keys and mappings_per_entity.get(stable_id, 0):
            raise InvalidMasterBundle("entity without legacy names cannot have a compatibility mapping")
        if any(r["legacyKind"] == "SPECIAL_ITEM" for r in entity["legacyNames"]) and entity["category"] != "LEGACY_SPECIAL_ITEM":
            raise InvalidMasterBundle("SPECIAL_ITEM source must preserve LEGACY_SPECIAL_ITEM category")
    for key, stable_id in legacy_owner.items():
        if stable_id is None:
            if key in mapped_keys:
                raise InvalidMasterBundle("unresolved legacy name is also mapped")
        elif key not in mapped_keys:
            raise InvalidMasterBundle("resolved legacy name has no compatibility mapping")
    for source in bundle["sourceRevisions"]:
        source = _object(source, "source revision")
        if (set(source) != {"sourceType", "revision", "sha256"}
                or not isinstance(source.get("sourceType"), str) or not source["sourceType"].strip()
                or not isinstance(source.get("revision"), str) or not source["revision"].strip()
                or _has_machine_path(source.get("sourceType")) or _has_machine_path(source.get("revision"))
                or not isinstance(source.get("sha256"), str) or not HASH_RE.fullmatch(source["sha256"])):
            raise InvalidMasterBundle("source revision has invalid fields/hash")

    # Validate durable identity continuity against the previous active bundle.
    return json.loads(_canonical_json(bundle))


def _connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path, timeout=10.0, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=10000")
    connection.execute("PRAGMA synchronous=FULL")
    return connection


class MasterStore:
    def __init__(self, path: str | os.PathLike[str] | None = None):
        self.path = Path(path) if path is not None else default_master_database_path()

    def _require_initialized(self, connection: sqlite3.Connection) -> None:
        row = connection.execute("SELECT schema_version FROM master_meta WHERE id=1").fetchone()
        if row is None:
            raise MasterStoreError("MasterStore is not initialized")
        if row[0] > MASTER_STORE_SCHEMA_VERSION:
            raise FutureMasterSchemaError(f"Master schema {row[0]} is newer than supported schema 1")
        if row[0] != MASTER_STORE_SCHEMA_VERSION:
            raise MasterStoreError("unsupported MasterStore schema")

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(_connect(self.path)) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                tables = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
                expected = {"master_meta", "master_bundle", "master_activation_history", "master_mutation_receipt"}
                if not tables:
                    for statement in ("""
                        CREATE TABLE master_meta(
                          id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL,
                          store_revision INTEGER NOT NULL CHECK(store_revision>=0),
                          active_registry_version TEXT NULL REFERENCES master_bundle(registry_version),
                          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                        );
                        CREATE TABLE master_bundle(
                          registry_version TEXT PRIMARY KEY, content_hash TEXT NOT NULL UNIQUE,
                          hash_basis TEXT NOT NULL, bundle_json TEXT NOT NULL,
                          created_at TEXT NOT NULL, first_persisted_at TEXT NOT NULL
                        );
                        CREATE TABLE master_activation_history(
                          store_revision INTEGER PRIMARY KEY, previous_registry_version TEXT NULL REFERENCES master_bundle(registry_version),
                          registry_version TEXT NOT NULL REFERENCES master_bundle(registry_version),
                          mutation_id TEXT NOT NULL UNIQUE, activated_at TEXT NOT NULL
                        );
                        CREATE TABLE master_mutation_receipt(
                          mutation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
                          response_json TEXT NOT NULL, created_at TEXT NOT NULL
                        );
                        CREATE TRIGGER master_bundle_no_update BEFORE UPDATE ON master_bundle BEGIN SELECT RAISE(ABORT, 'master bundles are immutable'); END;
                        CREATE TRIGGER master_bundle_no_delete BEFORE DELETE ON master_bundle BEGIN SELECT RAISE(ABORT, 'master bundles are immutable'); END;
                    """).split(";\n"):
                        if statement.strip():
                            connection.execute(statement)
                    now = _utc_now()
                    connection.execute("INSERT INTO master_meta VALUES (1, ?, 0, NULL, ?, ?)", (MASTER_STORE_SCHEMA_VERSION, now, now))
                else:
                    if "master_meta" not in tables:
                        raise MasterStoreError("refusing to initialize an unknown pre-existing database")
                    row = connection.execute("SELECT schema_version FROM master_meta WHERE id=1").fetchone()
                    if row is None:
                        raise MasterStoreError("MasterStore metadata is missing")
                    if row[0] > MASTER_STORE_SCHEMA_VERSION:
                        raise FutureMasterSchemaError(f"Master schema {row[0]} is newer than supported schema 1")
                    if not expected.issubset(tables):
                        raise MasterStoreError("MasterStore schema is incomplete")
                    if row[0] != MASTER_STORE_SCHEMA_VERSION or tables != expected:
                        raise MasterStoreError("unsupported or unknown MasterStore schema")
                    triggers = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
                    if not {"master_bundle_no_update", "master_bundle_no_delete"}.issubset(triggers):
                        raise MasterStoreError("MasterStore immutable bundle guards are missing")
                    # Validate required columns by preparing zero-row reads.
                    for table, columns in {
                        "master_meta": "id,schema_version,store_revision,active_registry_version,created_at,updated_at",
                        "master_bundle": "registry_version,content_hash,hash_basis,bundle_json,created_at,first_persisted_at",
                        "master_activation_history": "store_revision,previous_registry_version,registry_version,mutation_id,activated_at",
                        "master_mutation_receipt": "mutation_id,request_hash,response_json,created_at",
                    }.items():
                        connection.execute(f"SELECT {columns} FROM {table} LIMIT 0")
                    connection.execute("SELECT active_registry_version FROM master_meta WHERE id=1").fetchone()
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    def _meta(self, connection: sqlite3.Connection) -> sqlite3.Row:
        self._require_initialized(connection)
        return connection.execute("SELECT * FROM master_meta WHERE id=1").fetchone()

    def get_active_registry_version(self) -> str | None:
        with closing(_connect(self.path)) as connection:
            return self._meta(connection)["active_registry_version"]

    def store_revision(self) -> int:
        with closing(_connect(self.path)) as connection:
            return int(self._meta(connection)["store_revision"])

    def get_bundle(self, registry_version: str) -> dict[str, Any] | None:
        with closing(_connect(self.path)) as connection:
            self._meta(connection)
            row = connection.execute("SELECT registry_version,content_hash,hash_basis,bundle_json FROM master_bundle WHERE registry_version=?", (registry_version,)).fetchone()
            return self._decode_bundle_row(row) if row else None

    def get_active_bundle(self) -> dict[str, Any] | None:
        with closing(_connect(self.path)) as connection:
            meta = self._meta(connection)
            if meta["active_registry_version"] is None:
                return None
            row = connection.execute("SELECT registry_version,content_hash,hash_basis,bundle_json FROM master_bundle WHERE registry_version=?", (meta["active_registry_version"],)).fetchone()
            if row is None:
                raise MasterStoreError("active bundle pointer is dangling")
            return self._decode_bundle_row(row)

    @staticmethod
    def _decode_bundle_row(row: sqlite3.Row) -> dict[str, Any]:
        bundle = validate_master_bundle(json.loads(row["bundle_json"]))
        if (bundle["registryVersion"] != row["registry_version"]
                or bundle["contentHash"] != row["content_hash"]
                or bundle["hashBasis"] != row["hash_basis"]):
            raise MasterStoreError("persisted Master bundle metadata does not match its JSON")
        return bundle

    def _request_hash(self, operation: str, expected: str | None, approved: bool, payload: Any) -> str:
        body = {"operation": operation, "expectedRegistryVersion": expected, "ownerApproved": approved, "payload": payload}
        return hashlib.sha256(_canonical_json(body).encode("utf-8")).hexdigest()

    def _receipt_replay(self, connection: sqlite3.Connection, mutation_id: str, request_hash: str) -> dict[str, Any] | None:
        row = connection.execute("SELECT request_hash,response_json FROM master_mutation_receipt WHERE mutation_id=?", (mutation_id,)).fetchone()
        if row is None:
            return None
        if row["request_hash"] != request_hash:
            raise MasterMutationConflict("mutation_id was already used with a different request body")
        return json.loads(row["response_json"])

    def _check_cas(self, active: str | None, expected: str | None) -> None:
        if active != expected:
            raise MasterRevisionConflict(f"expected active registry {expected!r}, found {active!r}")

    def _check_continuity(self, prior: dict[str, Any], candidate: dict[str, Any]) -> None:
        old_entities = {item["stableId"]: item for item in prior["entities"]}
        new_entities = {item["stableId"]: item for item in candidate["entities"]}
        for stable_id, old in old_entities.items():
            new = new_entities.get(stable_id)
            if new is None:
                raise InvalidMasterBundle(f"durable stableId cannot be removed: {stable_id}")
            if new["kind"] != old["kind"]:
                raise InvalidMasterBundle(f"durable stableId kind cannot change: {stable_id}")
        old_map = {key: entity["stableId"] for entity in prior["entities"] for key in (record["legacyNameKey"] for record in entity["legacyNames"])}
        new_map = {key: entity["stableId"] for entity in candidate["entities"] for key in (record["legacyNameKey"] for record in entity["legacyNames"])}
        for key, stable_id in old_map.items():
            if new_map.get(key) != stable_id:
                raise InvalidMasterBundle(f"durable legacy mapping cannot be reassigned or removed: {key}")
        old_unresolved = {r["legacyNameKey"] for r in prior["unresolvedLegacyNames"]}
        new_unresolved = {r["legacyNameKey"] for r in candidate["unresolvedLegacyNames"]}
        for key in old_unresolved:
            if key not in new_unresolved and key not in new_map:
                raise InvalidMasterBundle(f"unresolved legacy name disappeared without resolution: {key}")
        prior_locators = {occurrence["locator"]: record["legacyNameKey"]
                          for entity in prior["entities"] for record in entity["legacyNames"]
                          for occurrence in record["occurrences"]}
        prior_locators.update({occurrence["locator"]: record["legacyNameKey"]
                               for record in prior["unresolvedLegacyNames"] for occurrence in record["occurrences"]})
        candidate_locators = {occurrence["locator"]: record["legacyNameKey"]
                              for entity in candidate["entities"] for record in entity["legacyNames"]
                              for occurrence in record["occurrences"]}
        candidate_locators.update({occurrence["locator"]: record["legacyNameKey"]
                                   for record in candidate["unresolvedLegacyNames"] for occurrence in record["occurrences"]})
        for locator, legacy_key in prior_locators.items():
            if candidate_locators.get(locator) != legacy_key:
                raise InvalidMasterBundle(f"durable source locator cannot be removed or reassigned: {locator}")

    def _activate(self, connection: sqlite3.Connection, *, registry_version: str, mutation_id: str,
                  previous: str | None, current_revision: int) -> tuple[int, bool]:
        if previous == registry_version:
            return current_revision, False
        revision = current_revision + 1
        now = _utc_now()
        connection.execute("UPDATE master_meta SET active_registry_version=?,store_revision=?,updated_at=? WHERE id=1",
                           (registry_version, revision, now))
        connection.execute("INSERT INTO master_activation_history VALUES (?, ?, ?, ?, ?)",
                           (revision, previous, registry_version, mutation_id, now))
        return revision, True

    def publish_bundle(self, bundle: dict[str, Any], *, mutation_id: str, expected_registry_version: str | None,
                       owner_approved: bool) -> dict[str, Any]:
        mutation_id = _string(mutation_id, "mutation_id")
        candidate = validate_master_bundle(bundle)
        request_hash = self._request_hash("publish", expected_registry_version, owner_approved is True, candidate)
        if owner_approved is not True:
            raise MasterStoreError("owner_approved must be exactly True")
        with closing(_connect(self.path)) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                meta = self._meta(connection)
                replay = self._receipt_replay(connection, mutation_id, request_hash)
                if replay is not None:
                    connection.commit()
                    return replay
                self._check_cas(meta["active_registry_version"], expected_registry_version)
                prior_rows = connection.execute("SELECT bundle_json FROM master_bundle").fetchall()
                for prior_row in prior_rows:
                    self._check_continuity(json.loads(prior_row[0]), candidate)
                version = candidate["registryVersion"]
                existing = connection.execute("SELECT bundle_json FROM master_bundle WHERE registry_version=?", (version,)).fetchone()
                if existing is not None:
                    stored = json.loads(existing[0])
                    if stored["contentHash"] != candidate["contentHash"]:
                        raise MasterStoreError("registry version collision")
                    semantic_duplicate = True
                else:
                    connection.execute("INSERT INTO master_bundle VALUES (?, ?, ?, ?, ?, ?)",
                                       (version, candidate["contentHash"], candidate["hashBasis"], _canonical_json(candidate), candidate["createdAt"], _utc_now()))
                    semantic_duplicate = False
                revision, changed = self._activate(connection, registry_version=version, mutation_id=mutation_id,
                                                   previous=meta["active_registry_version"], current_revision=meta["store_revision"])
                response = {"mutationId": mutation_id, "operation": "publish", "registryVersion": version,
                            "contentHash": candidate["contentHash"], "storeRevision": revision,
                            "previousRegistryVersion": meta["active_registry_version"], "activated": changed,
                            "semanticDuplicate": semantic_duplicate, "persistedAt": _utc_now()}
                connection.execute("INSERT INTO master_mutation_receipt VALUES (?, ?, ?, ?)",
                                   (mutation_id, request_hash, _canonical_json(response), response["persistedAt"]))
                connection.commit()
                return json.loads(_canonical_json(response))
            except Exception:
                connection.rollback()
                raise

    def activate_existing_bundle(self, registry_version: str, *, mutation_id: str,
                                 expected_registry_version: str | None, owner_approved: bool) -> dict[str, Any]:
        mutation_id = _string(mutation_id, "mutation_id")
        registry_version = _string(registry_version, "registry_version")
        payload = {"registryVersion": registry_version}
        request_hash = self._request_hash("activate_existing", expected_registry_version, owner_approved is True, payload)
        if owner_approved is not True:
            raise MasterStoreError("owner_approved must be exactly True")
        with closing(_connect(self.path)) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                meta = self._meta(connection)
                replay = self._receipt_replay(connection, mutation_id, request_hash)
                if replay is not None:
                    connection.commit()
                    return replay
                self._check_cas(meta["active_registry_version"], expected_registry_version)
                row = connection.execute("SELECT content_hash FROM master_bundle WHERE registry_version=?", (registry_version,)).fetchone()
                if row is None:
                    raise MasterStoreError("target Master bundle does not exist")
                revision, changed = self._activate(connection, registry_version=registry_version, mutation_id=mutation_id,
                                                   previous=meta["active_registry_version"], current_revision=meta["store_revision"])
                response = {"mutationId": mutation_id, "operation": "activate_existing", "registryVersion": registry_version,
                            "contentHash": row["content_hash"], "storeRevision": revision,
                            "previousRegistryVersion": meta["active_registry_version"], "activated": changed,
                            "semanticDuplicate": True, "persistedAt": _utc_now()}
                connection.execute("INSERT INTO master_mutation_receipt VALUES (?, ?, ?, ?)",
                                   (mutation_id, request_hash, _canonical_json(response), response["persistedAt"]))
                connection.commit()
                return json.loads(_canonical_json(response))
            except Exception:
                connection.rollback()
                raise

    def backup_to(self, destination_path: str | os.PathLike[str]) -> Path:
        destination = Path(destination_path)
        if self.path.resolve() == destination.resolve():
            raise MasterStoreError("backup destination must differ from source")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            raise FileExistsError(destination)
        with closing(_connect(self.path)) as source:
            self._meta(source)
            target = sqlite3.connect(destination)
            try:
                source.backup(target)
            except Exception:
                target.close()
                destination.unlink(missing_ok=True)
                raise
            else:
                target.close()
        # Independently verify the resulting SQLite snapshot before returning it.
        with closing(_connect(destination)) as check:
            self._meta(check)
            result = check.execute("PRAGMA integrity_check").fetchone()
            if result is None or result[0] != "ok" or check.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise MasterStoreError("backup integrity verification failed")
        return destination


__all__ = [
    "MASTER_STORE_SCHEMA_VERSION", "MasterStore", "MasterStoreError", "FutureMasterSchemaError",
    "MasterRevisionConflict", "MasterMutationConflict", "InvalidMasterBundle",
    "default_master_database_path", "master_bundle_content_hash", "validate_master_bundle",
]
