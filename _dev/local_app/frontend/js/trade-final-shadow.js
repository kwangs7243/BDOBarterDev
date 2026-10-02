import { recognizeTradeBatchV2 as defaultRecognizeTradeBatchV2 } from "./trade-recognition-client.js";
import { createTradeSourceEvidenceCache as defaultCreateSourceEvidenceCache } from "./trade-source-evidence.js";
import { mountTradeFinalReview as defaultMountTradeFinalReview } from "./trade-final-review.js";
import { buildTradeFinalShadowPipeline } from "./domain/trade-final-pipeline.js";

function fail(message) { throw new TypeError(message); }
function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("shadow input is required");
  const { captures, masterBundle, root, reviewRevision, correctionPolicy, getConfirmedAt, onConfirm, onClose, adapters = {} } = input;
  if (!Array.isArray(captures) || captures.length < 1) fail("captures must be a nonempty array");
  if (!masterBundle || typeof masterBundle !== "object" || Array.isArray(masterBundle)) fail("masterBundle is required");
  if (!(root instanceof Element)) fail("root must be an Element");
  if (!Number.isSafeInteger(reviewRevision) || reviewRevision < 0) fail("reviewRevision must be a safe integer >= 0");
  if (!correctionPolicy || typeof correctionPolicy !== "object" || Array.isArray(correctionPolicy)
      || typeof correctionPolicy.policyVersion !== "string" || !correctionPolicy.policyVersion.trim()) fail("correctionPolicy is required");
  if (typeof getConfirmedAt !== "function" || typeof onConfirm !== "function") fail("getConfirmedAt and onConfirm are required");
  if (onClose !== undefined && typeof onClose !== "function") fail("onClose must be a function");
  if (!adapters || typeof adapters !== "object" || Array.isArray(adapters)) fail("adapters must be an object");
  const recognize = adapters.recognizeTradeBatchV2 ?? defaultRecognizeTradeBatchV2;
  const createCache = adapters.createSourceEvidenceCache ?? defaultCreateSourceEvidenceCache;
  const mountReview = adapters.mountTradeFinalReview ?? defaultMountTradeFinalReview;
  if ([recognize, createCache, mountReview].some((value) => typeof value !== "function")) fail("shadow adapters must be functions");
  return { captures, masterBundle, root, reviewRevision, correctionPolicy, getConfirmedAt, onConfirm, onClose, recognize, createCache, mountReview };
}

export async function runTradeFinalShadow(input = {}) {
  const args = validateInput(input);
  const { captures, masterBundle, root, reviewRevision, correctionPolicy, getConfirmedAt, onConfirm, onClose,
    recognize, createCache, mountReview } = args;
  const sourceEvidence = createCache();
  if (!sourceEvidence || typeof sourceEvidence.retainCaptures !== "function"
      || typeof sourceEvidence.buildPixelAvailability !== "function" || typeof sourceEvidence.clear !== "function") {
    fail("source evidence cache API is incomplete");
  }
  let reviewController = null;
  let destroyed = false;
  const cleanup = () => {
    if (destroyed) return;
    destroyed = true;
    try { reviewController?.destroy?.(); } finally { sourceEvidence.clear(); }
  };
  try {
    sourceEvidence.retainCaptures(captures);
    const result = await recognize(captures);
    if (!result || typeof result !== "object" || result.version !== 2 || result.status !== "RAW_EVIDENCE_ONLY"
        || !result.rawEvidence || result.batchId !== result.rawEvidence.recognitionBatchId) fail("recognition adapter returned an invalid RawEvidenceSnapshot2 result");
    const rawEvidence = result.rawEvidence;
    const pixelAvailability = await sourceEvidence.buildPixelAvailability(rawEvidence);
    if (!Array.isArray(pixelAvailability)) fail("pixel availability verification did not return a list");
    const pipeline = buildTradeFinalShadowPipeline({ rawEvidence, masterBundle, pixelAvailability, correctionPolicy });
    reviewController = await mountReview({
      root,
      projection: pipeline.projection,
      rawEvidence,
      sourceEvidence,
      reviewRevision,
      getCurrentProjectionHash: () => pipeline.projection.projectionHash,
      getCurrentPixelAvailability: () => sourceEvidence.buildPixelAvailability(rawEvidence),
      getConfirmedAt,
      onConfirm,
      onClose,
    });
    if (!reviewController || typeof reviewController.destroy !== "function") fail("review mount did not return a controller");
    return { result, rawEvidence, sourceEvidence, pipeline, reviewController, destroy: cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
