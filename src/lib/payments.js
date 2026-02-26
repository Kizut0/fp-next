import { toObjectId } from "./api";

export const PAYMENT_STATUSES = [
  "reserved",
  "in_review",
  "released",
  "withdrawn",
  "failed",
  "refunded",
  "disputed",
];

const PAYMENT_STATUS_SET = new Set(PAYMENT_STATUSES);
const PAYMENT_STATUS_ALIASES = {
  hold: "reserved",
  pending: "in_review",
  paid: "released",
};

export const ACTIVE_PAYMENT_STATUSES = new Set([
  "reserved",
  "in_review",
  "released",
  "disputed",
]);

export const PAYMENT_RESOLUTION_SET = new Set(["release", "refund"]);

const PAYMENT_TRANSITIONS = {
  reserved: new Set(["in_review", "failed", "refunded", "disputed"]),
  in_review: new Set(["released", "failed", "refunded", "disputed", "reserved"]),
  released: new Set(["withdrawn", "disputed", "refunded", "failed"]),
  disputed: new Set(["released", "refunded", "failed"]),
  failed: new Set(["reserved", "in_review"]),
  refunded: new Set([]),
  withdrawn: new Set([]),
};

let paymentIndexesReady = false;

export function normalizeId(value) {
  return String(value || "").trim();
}

export function normalizeMilestoneKey(value) {
  const normalized = normalizeId(value);
  return normalized ? normalized.slice(0, 120) : "default";
}

export function normalizePaymentStatus(value, fallback = "") {
  const raw = normalizeId(value).toLowerCase();
  const mapped = PAYMENT_STATUS_ALIASES[raw] || raw;
  if (PAYMENT_STATUS_SET.has(mapped)) return mapped;

  const fallbackRaw = normalizeId(fallback).toLowerCase();
  const fallbackMapped = PAYMENT_STATUS_ALIASES[fallbackRaw] || fallbackRaw;
  if (PAYMENT_STATUS_SET.has(fallbackMapped)) return fallbackMapped;

  return "";
}

export function normalizeResolution(value) {
  const normalized = normalizeId(value).toLowerCase();
  return PAYMENT_RESOLUTION_SET.has(normalized) ? normalized : "";
}

export function isActivePaymentStatus(status) {
  const normalized = normalizePaymentStatus(status);
  return ACTIVE_PAYMENT_STATUSES.has(normalized);
}

export function canTransitionPaymentStatus(fromStatus, toStatus) {
  const current = normalizePaymentStatus(fromStatus);
  const next = normalizePaymentStatus(toStatus);
  if (!current || !next) return false;
  if (current === next) return true;

  const allowed = PAYMENT_TRANSITIONS[current];
  return Boolean(allowed && allowed.has(next));
}

export function normalizeDisputeStatus(value) {
  const status = normalizeId(value).toLowerCase();
  if (status === "open" || status === "resolved") return status;
  return "none";
}

export function hasOpenDispute(payment) {
  if (normalizeDisputeStatus(payment?.dispute?.status) === "open") return true;
  return normalizePaymentStatus(payment?.status) === "disputed";
}

export function buildDefaultDisputeState() {
  return {
    status: "none",
    reason: "",
    openedAt: null,
    openedBy: "",
    resolution: "",
    resolutionNote: "",
    resolvedAt: null,
    resolvedBy: "",
  };
}

export function buildDisputeOpenState({ reason = "", openedBy = "", now = new Date() } = {}) {
  return {
    status: "open",
    reason: normalizeId(reason).slice(0, 1500),
    openedAt: now,
    openedBy: normalizeId(openedBy),
    resolution: "",
    resolutionNote: "",
    resolvedAt: null,
    resolvedBy: "",
  };
}

export function buildDisputeResolvedState({
  previous = {},
  resolution = "",
  resolutionNote = "",
  resolvedBy = "",
  now = new Date(),
} = {}) {
  return {
    ...buildDefaultDisputeState(),
    ...previous,
    status: "resolved",
    resolution: normalizeResolution(resolution) || normalizeId(resolution).toLowerCase(),
    resolutionNote: normalizeId(resolutionNote).slice(0, 1500),
    resolvedAt: now,
    resolvedBy: normalizeId(resolvedBy),
  };
}

export function buildPaymentStatusHistoryEntry({
  action = "transition",
  fromStatus = "",
  toStatus = "",
  reason = "",
  actorId = "",
  at = new Date(),
} = {}) {
  return {
    action: normalizeId(action) || "transition",
    fromStatus: normalizePaymentStatus(fromStatus, "") || normalizeId(fromStatus).toLowerCase(),
    toStatus: normalizePaymentStatus(toStatus, "") || normalizeId(toStatus).toLowerCase(),
    reason: normalizeId(reason).slice(0, 1500),
    actorId: normalizeId(actorId),
    at,
  };
}

export function normalizeContractIdVariants(rawContractId) {
  const id = normalizeId(rawContractId);
  if (!id) return [];

  const objectId = toObjectId(id);
  return objectId ? [id, objectId] : [id];
}

function buildMilestoneQuery(milestoneKey) {
  const key = normalizeMilestoneKey(milestoneKey);
  if (key !== "default") {
    return { milestoneKey: key };
  }

  return {
    $or: [
      { milestoneKey: "default" },
      { milestoneKey: { $exists: false } },
      { milestoneKey: null },
      { milestoneKey: "" },
    ],
  };
}

export function buildPaymentContractQuery(rawContractId, milestoneKey = "default") {
  const variants = normalizeContractIdVariants(rawContractId);
  if (!variants.length) return null;

  return {
    contractId: { $in: variants },
    ...buildMilestoneQuery(milestoneKey),
  };
}

export function normalizeCanonicalContractId(contract, fallback = "") {
  return (
    normalizeId(contract?._id) ||
    normalizeId(contract?.contractId) ||
    normalizeId(fallback)
  );
}

export function normalizeIdempotencyKey(value) {
  const normalized = normalizeId(value);
  return normalized ? normalized.slice(0, 140) : "";
}

export function buildIdempotencyEntry({
  key = "",
  action = "",
  fromStatus = "",
  toStatus = "",
  actorId = "",
  at = new Date(),
} = {}) {
  return {
    key: normalizeIdempotencyKey(key),
    action: normalizeId(action),
    fromStatus: normalizePaymentStatus(fromStatus, "") || normalizeId(fromStatus).toLowerCase(),
    toStatus: normalizePaymentStatus(toStatus, "") || normalizeId(toStatus).toLowerCase(),
    actorId: normalizeId(actorId),
    at,
  };
}

export function hasIdempotencyKey(payment, key) {
  const normalizedKey = normalizeIdempotencyKey(key);
  if (!normalizedKey) return false;
  const logItems = Array.isArray(payment?.idempotencyLog) ? payment.idempotencyLog : [];
  return logItems.some((item) => normalizeIdempotencyKey(item?.key) === normalizedKey);
}

function isIgnorableIndexError(error) {
  const code = Number(error?.code || 0);
  const codeName = normalizeId(error?.codeName);
  return (
    code === 85 ||
    code === 86 ||
    code === 11000 ||
    codeName === "IndexOptionsConflict" ||
    codeName === "IndexKeySpecsConflict"
  );
}

export async function ensurePaymentIndexes(payments) {
  if (paymentIndexesReady) return;

  const operations = [
    payments.createIndex(
      { contractId: 1, milestoneKey: 1, isActive: 1 },
      {
        name: "uniq_active_payment_per_contract_milestone",
        unique: true,
        partialFilterExpression: { isActive: true },
      }
    ),
    payments.createIndex(
      { contractId: 1, milestoneKey: 1, updatedAt: -1 },
      { name: "idx_payment_contract_milestone_updated" }
    ),
    payments.createIndex(
      { "idempotencyLog.key": 1 },
      { name: "idx_payment_idempotency_key", sparse: true }
    ),
  ];

  await Promise.all(
    operations.map(async (operation) => {
      try {
        await operation;
      } catch (error) {
        if (!isIgnorableIndexError(error)) throw error;
      }
    })
  );

  paymentIndexesReady = true;
}
