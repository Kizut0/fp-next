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
  completed: "released",
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

const DISPUTE_STAGE_SET = new Set(["intake", "evidence", "mediation", "decision", "resolved"]);
const EVIDENCE_TYPE_SET = new Set(["link", "file"]);
const DEFAULT_DISPUTE_SLA_HOURS = 72;
const MIN_DISPUTE_SLA_HOURS = 1;
const MAX_DISPUTE_SLA_HOURS = 24 * 30;

const LEDGER_ACCOUNT_MAP = {
  reserved: "escrow_reserved",
  in_review: "escrow_in_review",
  disputed: "escrow_disputed",
  released: "freelancer_available",
  withdrawn: "freelancer_withdrawn",
  refunded: "client_refunded",
  failed: "payment_failed",
};

let paymentIndexesReady = false;
let paymentLedgerIndexesReady = false;

function roundMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100) / 100;
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeText(value, maxLen = 1500) {
  return normalizeId(value).slice(0, maxLen);
}

function normalizeHttpUrl(value, maxLen = 1200) {
  const raw = normalizeText(value, maxLen);
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : "";
}

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

export function canReconcileProviderStatus(fromStatus, toStatus) {
  const current = normalizePaymentStatus(fromStatus);
  const next = normalizePaymentStatus(toStatus);
  if (!current || !next) return false;
  if (current === next) return true;
  if (canTransitionPaymentStatus(current, next)) return true;

  if (next === "failed" || next === "refunded") return true;
  if (next === "released") return ["reserved", "in_review", "disputed"].includes(current);
  if (next === "reserved") return ["failed"].includes(current);
  if (next === "in_review") return ["reserved", "failed"].includes(current);
  if (next === "withdrawn") return current === "released";
  if (next === "disputed") return ["reserved", "in_review", "released"].includes(current);
  return false;
}

export function normalizeDisputeStatus(value) {
  const status = normalizeId(value).toLowerCase();
  if (status === "open" || status === "resolved") return status;
  return "none";
}

export function normalizeDisputeStage(value, fallback = "intake") {
  const normalized = normalizeId(value).toLowerCase();
  if (DISPUTE_STAGE_SET.has(normalized)) return normalized;
  return DISPUTE_STAGE_SET.has(fallback) ? fallback : "intake";
}

export function resolveDisputeSlaHours(value) {
  const fallback = Number(process.env.DISPUTE_RESOLUTION_SLA_HOURS || DEFAULT_DISPUTE_SLA_HOURS);
  const hours = Number(value ?? fallback);
  if (!Number.isFinite(hours)) return DEFAULT_DISPUTE_SLA_HOURS;
  const rounded = Math.floor(hours);
  if (rounded < MIN_DISPUTE_SLA_HOURS || rounded > MAX_DISPUTE_SLA_HOURS) {
    return DEFAULT_DISPUTE_SLA_HOURS;
  }
  return rounded;
}

function buildDisputeSlaWindow({ openedAt, slaHours, now = new Date() } = {}) {
  const opened = toDateOrNull(openedAt) || now;
  const hours = resolveDisputeSlaHours(slaHours);
  const dueAt = new Date(opened.getTime() + hours * 60 * 60 * 1000);
  const overdueHours = Math.max(0, Math.ceil((now.getTime() - dueAt.getTime()) / (60 * 60 * 1000)));
  const isOverdue = overdueHours > 0;
  return {
    slaHours: hours,
    slaDueAt: dueAt,
    slaOverdueHours: overdueHours,
    slaIsOverdue: isOverdue,
    slaBreachedAt: isOverdue ? dueAt : null,
  };
}

function normalizeDisputeEvidenceType(value, fallback = "link") {
  const normalized = normalizeId(value).toLowerCase();
  if (EVIDENCE_TYPE_SET.has(normalized)) return normalized;
  return EVIDENCE_TYPE_SET.has(fallback) ? fallback : "link";
}

function normalizeDisputeEvidenceItem(rawItem, { actorId = "", now = new Date(), fallbackIndex = 0 } = {}) {
  if (!rawItem) return null;

  const item = typeof rawItem === "string" ? { type: "link", url: rawItem } : rawItem;
  if (!item || typeof item !== "object") return null;

  const url = normalizeHttpUrl(item.url || item.link);
  const dataUrl = normalizeText(item.dataUrl, 2_500_000);
  const hasDataUrl = /^data:/i.test(dataUrl);
  const inferredType = hasDataUrl ? "file" : "link";
  const type = normalizeDisputeEvidenceType(item.type, inferredType);
  if (type === "link" && !url) return null;
  if (type === "file" && !url && !hasDataUrl) return null;

  const nowTag = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const generatedId = `evi_${nowTag}_${fallbackIndex + 1}`;

  return {
    id: normalizeText(item.id, 120) || generatedId,
    type,
    label: normalizeText(item.label || item.name || item.fileName, 200),
    url: url || "",
    dataUrl: hasDataUrl ? dataUrl : "",
    mimeType: normalizeText(item.mimeType || item.typeName || item.contentType, 120),
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : 0,
    addedBy: normalizeId(item.addedBy) || normalizeId(actorId),
    addedAt: toDateOrNull(item.addedAt) || now,
  };
}

export function normalizeDisputeEvidenceItems(input, options = {}) {
  const items = Array.isArray(input) ? input : input ? [input] : [];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const normalized = normalizeDisputeEvidenceItem(items[i], {
      ...options,
      fallbackIndex: i,
    });
    if (normalized) out.push(normalized);
  }
  return out;
}

export function buildDisputeMediationHistoryEntry({
  stage = "intake",
  note = "",
  actorId = "",
  at = new Date(),
} = {}) {
  return {
    stage: normalizeDisputeStage(stage, "intake"),
    note: normalizeText(note, 1500),
    actorId: normalizeId(actorId),
    at,
  };
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
    evidence: [],
    mediationStage: "intake",
    mediationHistory: [],
    slaHours: resolveDisputeSlaHours(),
    slaDueAt: null,
    slaIsOverdue: false,
    slaOverdueHours: 0,
    slaBreachedAt: null,
  };
}

export function normalizeDisputeState(dispute = {}, { now = new Date() } = {}) {
  const base = {
    ...buildDefaultDisputeState(),
    ...(dispute || {}),
  };
  const status = normalizeDisputeStatus(base.status);
  const openedAt = toDateOrNull(base.openedAt);
  const resolvedAt = toDateOrNull(base.resolvedAt);

  const stageFallback = status === "resolved" ? "resolved" : "intake";
  const mediationStage = normalizeDisputeStage(base.mediationStage, stageFallback);
  const evidence = normalizeDisputeEvidenceItems(base.evidence, {
    actorId: base.openedBy,
    now,
  }).slice(-40);

  const mediationHistoryRaw = Array.isArray(base.mediationHistory) ? base.mediationHistory : [];
  const mediationHistory = mediationHistoryRaw
    .map((item) => ({
      stage: normalizeDisputeStage(item?.stage, "intake"),
      note: normalizeText(item?.note, 1500),
      actorId: normalizeId(item?.actorId),
      at: toDateOrNull(item?.at) || now,
    }))
    .slice(-120);

  const slaHours = resolveDisputeSlaHours(base.slaHours);
  const windowBase = buildDisputeSlaWindow({
    openedAt: openedAt || now,
    slaHours,
    now,
  });
  const persistedDueAt = toDateOrNull(base.slaDueAt) || windowBase.slaDueAt;
  const overdueHours = Math.max(0, Math.ceil((now.getTime() - persistedDueAt.getTime()) / (60 * 60 * 1000)));
  const isOverdue = status === "open" ? overdueHours > 0 : false;

  return {
    ...base,
    status,
    openedAt,
    openedBy: normalizeId(base.openedBy),
    resolution: normalizeResolution(base.resolution) || normalizeId(base.resolution).toLowerCase(),
    resolutionNote: normalizeText(base.resolutionNote, 1500),
    resolvedAt,
    resolvedBy: normalizeId(base.resolvedBy),
    evidence,
    mediationStage: status === "resolved" ? "resolved" : mediationStage,
    mediationHistory,
    slaHours,
    slaDueAt: persistedDueAt,
    slaIsOverdue: isOverdue,
    slaOverdueHours: isOverdue ? overdueHours : 0,
    slaBreachedAt: isOverdue ? toDateOrNull(base.slaBreachedAt) || persistedDueAt : toDateOrNull(base.slaBreachedAt),
  };
}

export function buildDisputeOpenState({
  reason = "",
  openedBy = "",
  now = new Date(),
  evidence = [],
  stage = "evidence",
  note = "",
  slaHours = undefined,
} = {}) {
  const normalizedEvidence = normalizeDisputeEvidenceItems(evidence, {
    actorId: openedBy,
    now,
  }).slice(-40);
  const window = buildDisputeSlaWindow({
    openedAt: now,
    slaHours,
    now,
  });

  return {
    ...buildDefaultDisputeState(),
    status: "open",
    reason: normalizeText(reason, 1500),
    openedAt: now,
    openedBy: normalizeId(openedBy),
    resolution: "",
    resolutionNote: "",
    resolvedAt: null,
    resolvedBy: "",
    evidence: normalizedEvidence,
    mediationStage: normalizeDisputeStage(stage, "evidence"),
    mediationHistory: [
      buildDisputeMediationHistoryEntry({
        stage: normalizeDisputeStage(stage, "evidence"),
        note: normalizeText(note || "Dispute opened", 1500),
        actorId: normalizeId(openedBy),
        at: now,
      }),
    ],
    slaHours: window.slaHours,
    slaDueAt: window.slaDueAt,
    slaIsOverdue: false,
    slaOverdueHours: 0,
    slaBreachedAt: null,
  };
}

export function appendDisputeEvidence({
  previous = {},
  evidence = [],
  actorId = "",
  note = "",
  now = new Date(),
} = {}) {
  const normalized = normalizeDisputeState(previous, { now });
  const appended = normalizeDisputeEvidenceItems(evidence, {
    actorId,
    now,
  });
  if (!appended.length) {
    return normalized;
  }

  const nextStage = normalized.status === "open"
    ? normalizeDisputeStage(normalized.mediationStage, "evidence")
    : "resolved";

  return normalizeDisputeState(
    {
      ...normalized,
      evidence: [...normalized.evidence, ...appended].slice(-40),
      mediationStage: normalized.status === "open" ? nextStage : normalized.mediationStage,
      mediationHistory: [
        ...normalized.mediationHistory,
        buildDisputeMediationHistoryEntry({
          stage: normalized.status === "open" ? nextStage : "resolved",
          note: normalizeText(note || `Evidence added (${appended.length})`, 1500),
          actorId,
          at: now,
        }),
      ].slice(-120),
    },
    { now }
  );
}

export function buildDisputeMediationUpdate({
  previous = {},
  stage = "mediation",
  note = "",
  actorId = "",
  now = new Date(),
  slaHours = undefined,
} = {}) {
  const normalized = normalizeDisputeState(previous, { now });
  const nextSlaHours = slaHours === undefined ? normalized.slaHours : resolveDisputeSlaHours(slaHours);
  const nextStage = normalizeDisputeStage(stage, normalized.mediationStage);

  return normalizeDisputeState(
    {
      ...normalized,
      mediationStage: nextStage,
      mediationHistory: [
        ...normalized.mediationHistory,
        buildDisputeMediationHistoryEntry({
          stage: nextStage,
          note: normalizeText(note || `Stage set to ${nextStage}`, 1500),
          actorId,
          at: now,
        }),
      ].slice(-120),
      slaHours: nextSlaHours,
    },
    { now }
  );
}

export function buildDisputeResolvedState({
  previous = {},
  resolution = "",
  resolutionNote = "",
  resolvedBy = "",
  now = new Date(),
} = {}) {
  const normalized = normalizeDisputeState(previous, { now });
  return normalizeDisputeState(
    {
      ...normalized,
      status: "resolved",
      resolution: normalizeResolution(resolution) || normalizeId(resolution).toLowerCase(),
      resolutionNote: normalizeText(resolutionNote, 1500),
      resolvedAt: now,
      resolvedBy: normalizeId(resolvedBy),
      mediationStage: "resolved",
      mediationHistory: [
        ...normalized.mediationHistory,
        buildDisputeMediationHistoryEntry({
          stage: "resolved",
          note: normalizeText(resolutionNote || `Resolved: ${resolution}`, 1500),
          actorId: normalizeId(resolvedBy),
          at: now,
        }),
      ].slice(-120),
      slaIsOverdue: false,
    },
    { now }
  );
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
    reason: normalizeText(reason, 1500),
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

function statusToLedgerAccount(status) {
  const normalized = normalizePaymentStatus(status, "");
  return LEDGER_ACCOUNT_MAP[normalized] || "external";
}

function deriveLedgerEntryType(fromStatus, toStatus) {
  const from = normalizePaymentStatus(fromStatus, "");
  const to = normalizePaymentStatus(toStatus, "");
  if (!from) {
    if (to === "reserved") return "fund_reserve";
    if (to === "in_review") return "fund_direct_review";
    if (to === "released") return "direct_release";
  }

  if (to === "in_review") return "review_hold";
  if (to === "released") return "release_funds";
  if (to === "withdrawn") return "withdraw_payout";
  if (to === "refunded") return "refund_client";
  if (to === "failed") return "payment_failure";
  if (to === "disputed") return "dispute_hold";
  if (to === "reserved") return "re_reserve";
  return "status_transition";
}

export function buildEscrowLedgerEntry({
  payment = {},
  fromStatus = "",
  toStatus = "",
  action = "transition",
  reason = "",
  actorId = "",
  actorRole = "",
  source = "internal",
  idempotencyKey = "",
  eventId = "",
  provider = {},
  at = new Date(),
} = {}) {
  const normalizedFrom = normalizePaymentStatus(fromStatus, "") || normalizeId(fromStatus).toLowerCase();
  const normalizedTo = normalizePaymentStatus(toStatus, "") || normalizeId(toStatus).toLowerCase();

  return {
    paymentId: normalizeId(payment?._id || payment?.paymentId),
    contractId: normalizeId(payment?.contractId),
    milestoneKey: normalizeMilestoneKey(payment?.milestoneKey),
    clientId: normalizeId(payment?.clientId),
    freelancerId: normalizeId(payment?.freelancerId),
    amount: roundMoney(payment?.amount),
    currency: normalizeText(payment?.currency || "THB", 16).toUpperCase() || "THB",
    action: normalizeText(action, 80) || "transition",
    reason: normalizeText(reason, 1500),
    source: normalizeText(source, 80) || "internal",
    fromStatus: normalizedFrom,
    toStatus: normalizedTo,
    fromAccount: normalizedFrom ? statusToLedgerAccount(normalizedFrom) : "external_funding",
    toAccount: statusToLedgerAccount(normalizedTo),
    entryType: deriveLedgerEntryType(normalizedFrom, normalizedTo),
    actorId: normalizeId(actorId),
    actorRole: normalizeText(actorRole, 40),
    idempotencyKey: normalizeIdempotencyKey(idempotencyKey),
    eventId: normalizeText(eventId, 180),
    provider: {
      name: normalizeText(provider?.name || provider?.provider, 120),
      paymentId: normalizeText(provider?.paymentId || provider?.providerPaymentId, 180),
      eventType: normalizeText(provider?.eventType || provider?.type, 120),
      rawStatus: normalizeText(provider?.rawStatus || provider?.status, 80),
      reference: normalizeText(provider?.reference, 180),
    },
    createdAt: at,
  };
}

export async function appendEscrowLedgerEntry(ledgerCollection, options = {}) {
  if (!ledgerCollection) return null;
  const entry = buildEscrowLedgerEntry(options);
  if (!entry.paymentId || !entry.toStatus) return null;

  const duplicateQuery = entry.eventId
    ? { source: entry.source, eventId: entry.eventId, paymentId: entry.paymentId }
    : entry.idempotencyKey
      ? {
        paymentId: entry.paymentId,
        idempotencyKey: entry.idempotencyKey,
        action: entry.action,
        toStatus: entry.toStatus,
      }
      : null;

  if (duplicateQuery) {
    const existing = await ledgerCollection.findOne(duplicateQuery, {
      projection: { _id: 1 },
    });
    if (existing) return existing;
  }

  try {
    await ledgerCollection.insertOne(entry);
    return entry;
  } catch (error) {
    if (!isIgnorableIndexError(error)) throw error;
    return null;
  }
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
    payments.createIndex(
      { "provider.paymentId": 1, contractId: 1, milestoneKey: 1 },
      { name: "idx_payment_provider_payment", sparse: true }
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

export async function ensurePaymentLedgerIndexes(ledgerCollection) {
  if (paymentLedgerIndexesReady) return;

  const operations = [
    ledgerCollection.createIndex(
      { paymentId: 1, createdAt: -1 },
      { name: "idx_ledger_payment_time" }
    ),
    ledgerCollection.createIndex(
      { contractId: 1, milestoneKey: 1, createdAt: -1 },
      { name: "idx_ledger_contract_milestone_time" }
    ),
    ledgerCollection.createIndex(
      { source: 1, eventId: 1, paymentId: 1 },
      {
        name: "uniq_ledger_source_event_payment",
        unique: true,
        partialFilterExpression: { eventId: { $exists: true, $ne: "" } },
      }
    ),
    ledgerCollection.createIndex(
      { paymentId: 1, idempotencyKey: 1, action: 1, toStatus: 1 },
      {
        name: "uniq_ledger_payment_idempotency",
        unique: true,
        partialFilterExpression: { idempotencyKey: { $exists: true, $ne: "" } },
      }
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

  paymentLedgerIndexesReady = true;
}
