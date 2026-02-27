import { normalizeId, normalizeMilestoneKey } from "./payments";

const MILESTONE_STATUS_SET = new Set([
  "pending",
  "in_review",
  "released",
  "cancelled",
  "disputed",
]);

const COMPLETION_STATUS_SET = new Set([
  "not_submitted",
  "pending",
  "accepted",
  "rejected",
]);

const ESCALATION_STATUS_SET = new Set(["open", "resolved", "cancelled"]);
const ESCALATION_LEVEL_SET = new Set(["warning", "critical"]);

const MONEY_EPSILON = 0.01;
const DEFAULT_DUE_SOON_HOURS = 48;
const DEFAULT_ESCALATION_OVERDUE_HOURS = 72;

function roundMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100) / 100;
}

function sameMoney(left, right) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= MONEY_EPSILON;
}

function normalizeText(value, maxLen = 500) {
  return normalizeId(value).slice(0, maxLen);
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toPositiveInt(value, fallback, { min = 1, max = 10_000 } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.floor(num);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

function resolveSlaThresholds(options = {}) {
  const dueSoonHours = toPositiveInt(
    options?.dueSoonHours ?? process.env.MILESTONE_SLA_DUE_SOON_HOURS,
    DEFAULT_DUE_SOON_HOURS,
    { min: 1, max: 720 }
  );
  const escalationOverdueHours = toPositiveInt(
    options?.escalationOverdueHours ?? process.env.MILESTONE_SLA_ESCALATION_HOURS,
    DEFAULT_ESCALATION_OVERDUE_HOURS,
    { min: 1, max: 2160 }
  );

  return { dueSoonHours, escalationOverdueHours };
}

function normalizeCompletionStatus(value, fallback = "not_submitted") {
  const raw = normalizeId(value).toLowerCase();
  if (COMPLETION_STATUS_SET.has(raw)) return raw;
  return COMPLETION_STATUS_SET.has(fallback) ? fallback : "not_submitted";
}

function normalizeMilestoneStatus(value, fallback = "pending") {
  const raw = normalizeId(value).toLowerCase();
  if (MILESTONE_STATUS_SET.has(raw)) return raw;
  return MILESTONE_STATUS_SET.has(fallback) ? fallback : "pending";
}

function normalizeEscalationStatus(value, fallback = "open") {
  const raw = normalizeId(value).toLowerCase();
  if (ESCALATION_STATUS_SET.has(raw)) return raw;
  return ESCALATION_STATUS_SET.has(fallback) ? fallback : "open";
}

function normalizeEscalationLevel(value, fallback = "warning") {
  const raw = normalizeId(value).toLowerCase();
  if (ESCALATION_LEVEL_SET.has(raw)) return raw;
  return ESCALATION_LEVEL_SET.has(fallback) ? fallback : "warning";
}

function inferMilestoneStatus(rawStatus, completionStatus, fallback = "pending") {
  const explicit = normalizeMilestoneStatus(rawStatus, "");
  if (explicit) return explicit;

  const completion = normalizeCompletionStatus(completionStatus, "not_submitted");
  if (completion === "pending") return "in_review";
  if (completion === "accepted") return "released";

  return normalizeMilestoneStatus(fallback, "pending");
}

function ensureUniqueMilestoneKey(baseKey, usedKeys, fallbackIndex) {
  const seed = normalizeMilestoneKey(baseKey || `milestone-${fallbackIndex + 1}`);
  if (!usedKeys.has(seed)) {
    usedKeys.add(seed);
    return seed;
  }

  let suffix = 2;
  while (suffix < 1000) {
    const candidate = normalizeMilestoneKey(`${seed}-${suffix}`);
    if (!usedKeys.has(candidate)) {
      usedKeys.add(candidate);
      return candidate;
    }
    suffix += 1;
  }

  const fallback = normalizeMilestoneKey(`milestone-${fallbackIndex + 1}-${Date.now()}`);
  usedKeys.add(fallback);
  return fallback;
}

export function buildEmptyCompletionRequest() {
  return {
    status: "not_submitted",
    link: "",
    notes: "",
    attachment: null,
    submittedAt: null,
    submittedBy: "",
    decisionAt: null,
    decidedBy: "",
    clientFeedback: "",
  };
}

export function normalizeCompletionRequest(input = {}) {
  const fallback = buildEmptyCompletionRequest();
  const status = normalizeCompletionStatus(input?.status, fallback.status);

  return {
    status,
    link: normalizeText(input?.link, 1000),
    notes: normalizeText(input?.notes, 1500),
    attachment: input?.attachment || null,
    submittedAt: toDateOrNull(input?.submittedAt),
    submittedBy: normalizeText(input?.submittedBy, 80),
    decisionAt: toDateOrNull(input?.decisionAt),
    decidedBy: normalizeText(input?.decidedBy, 80),
    clientFeedback: normalizeText(input?.clientFeedback, 1500),
  };
}

export function sumMilestoneAmounts(milestones = []) {
  return Math.round(
    milestones.reduce((sum, item) => sum + roundMoney(item?.amount), 0) * 100
  ) / 100;
}

function buildSingleDefaultMilestone({
  amount = 0,
  title = "Project Delivery",
  legacyCompletionRequest = null,
  legacyStatus = "active",
} = {}) {
  const completionRequest = normalizeCompletionRequest(legacyCompletionRequest || {});
  const contractStatus = normalizeId(legacyStatus).toLowerCase();

  let status = "pending";
  if (contractStatus === "completed" || completionRequest.status === "accepted") {
    status = "released";
  } else if (completionRequest.status === "pending") {
    status = "in_review";
  } else if (contractStatus === "cancelled") {
    status = "cancelled";
  }

  return {
    key: "default",
    title: normalizeText(title, 120) || "Project Delivery",
    description: "",
    amount: roundMoney(amount),
    order: 1,
    dueDate: null,
    status,
    completionRequest,
  };
}

export function normalizeMilestonesForContract(
  rawMilestones,
  {
    totalAmount = 0,
    strictTotal = false,
    legacyCompletionRequest = null,
    legacyStatus = "active",
    defaultTitle = "Project Delivery",
  } = {}
) {
  const normalizedTotal = roundMoney(totalAmount);
  const usedKeys = new Set();

  if (Array.isArray(rawMilestones) && rawMilestones.length > 0) {
    const milestones = [];

    for (let index = 0; index < rawMilestones.length; index += 1) {
      const raw = rawMilestones[index] || {};
      const amount = roundMoney(raw.amount);
      if (amount <= 0) {
        return { error: `milestones[${index}].amount must be greater than 0` };
      }

      const keySeed =
        raw.key || raw.milestoneKey || raw.milestoneId || raw.id || `milestone-${index + 1}`;
      const key = ensureUniqueMilestoneKey(keySeed, usedKeys, index);
      const completionRequest = normalizeCompletionRequest(raw.completionRequest || {});

      milestones.push({
        key,
        title: normalizeText(raw.title, 120) || `Milestone ${index + 1}`,
        description: normalizeText(raw.description, 1500),
        amount,
        order: Number.isFinite(Number(raw.order))
          ? Math.max(1, Math.floor(Number(raw.order)))
          : index + 1,
        dueDate: toDateOrNull(raw.dueDate),
        status: inferMilestoneStatus(raw.status, completionRequest.status, "pending"),
        completionRequest,
      });
    }

    const calculatedTotal = sumMilestoneAmounts(milestones);
    if (strictTotal && normalizedTotal > 0 && !sameMoney(calculatedTotal, normalizedTotal)) {
      return {
        error: `Milestone total (${calculatedTotal}) must equal contract amount (${normalizedTotal})`,
      };
    }

    return {
      milestones,
      totalAmount: normalizedTotal > 0 ? normalizedTotal : calculatedTotal,
    };
  }

  const fallbackAmount = normalizedTotal;
  if (fallbackAmount <= 0) {
    return { error: "Contract amount must be greater than 0 when milestones are missing" };
  }

  const milestone = buildSingleDefaultMilestone({
    amount: fallbackAmount,
    title: defaultTitle,
    legacyCompletionRequest,
    legacyStatus,
  });

  return {
    milestones: [milestone],
    totalAmount: fallbackAmount,
  };
}

export function ensureContractMilestones(contract = {}) {
  const result = normalizeMilestonesForContract(contract?.milestones, {
    totalAmount: roundMoney(contract?.amount),
    strictTotal: false,
    legacyCompletionRequest: contract?.completionRequest,
    legacyStatus: contract?.status,
    defaultTitle: contract?.jobTitle || "Project Delivery",
  });

  if (result.error) {
    const fallback = buildSingleDefaultMilestone({
      amount: roundMoney(contract?.amount),
      title: contract?.jobTitle || "Project Delivery",
      legacyCompletionRequest: contract?.completionRequest,
      legacyStatus: contract?.status,
    });
    return [fallback];
  }

  return result.milestones || [];
}

export function findMilestoneByKey(milestones = [], key = "") {
  const targetKey = normalizeMilestoneKey(key);
  if (!targetKey) return null;

  const index = milestones.findIndex((item) => normalizeMilestoneKey(item?.key) === targetKey);
  if (index < 0) return null;

  return {
    index,
    milestone: milestones[index],
    key: targetKey,
  };
}

function findFirstByCompletionStatus(milestones = [], status = "") {
  const normalized = normalizeCompletionStatus(status, "");
  if (!normalized) return null;
  const index = milestones.findIndex(
    (item) => normalizeCompletionStatus(item?.completionRequest?.status) === normalized
  );
  if (index < 0) return null;
  return { index, milestone: milestones[index], key: normalizeMilestoneKey(milestones[index]?.key) };
}

function findFirstActionableMilestone(milestones = []) {
  const index = milestones.findIndex((item) => {
    const status = normalizeMilestoneStatus(item?.status, "pending");
    return status !== "released" && status !== "cancelled";
  });
  if (index < 0) return null;
  return { index, milestone: milestones[index], key: normalizeMilestoneKey(milestones[index]?.key) };
}

export function pickMilestoneForAction(milestones = [], action = "", requestedKey = "") {
  const explicit = findMilestoneByKey(milestones, requestedKey);
  if (explicit) return explicit;

  const normalizedAction = normalizeId(action).toLowerCase();
  if (normalizedAction === "accept" || normalizedAction === "reject") {
    return findFirstByCompletionStatus(milestones, "pending");
  }

  if (normalizedAction === "submit") {
    const index = milestones.findIndex((item) => {
      const status = normalizeMilestoneStatus(item?.status, "pending");
      const requestStatus = normalizeCompletionStatus(item?.completionRequest?.status);
      return status !== "released" && status !== "cancelled" && requestStatus !== "pending";
    });

    if (index >= 0) {
      return {
        index,
        milestone: milestones[index],
        key: normalizeMilestoneKey(milestones[index]?.key),
      };
    }

    return findFirstByCompletionStatus(milestones, "pending");
  }

  return findFirstActionableMilestone(milestones);
}

export function areAllMilestonesReleased(milestones = []) {
  if (!Array.isArray(milestones) || milestones.length === 0) return false;
  return milestones.every((item) => normalizeMilestoneStatus(item?.status) === "released");
}

function normalizeEscalationActor(value) {
  if (value && typeof value === "object") {
    return {
      id: normalizeText(value.id, 120),
      role: normalizeText(value.role, 40),
      email: normalizeText(value.email, 200),
      name: normalizeText(value.name, 120),
    };
  }
  return normalizeText(value, 120);
}

export function normalizeMilestoneEscalations(items = []) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => {
      const milestoneKey = normalizeMilestoneKey(item?.milestoneKey || item?.milestoneId || item?.key);
      if (!milestoneKey) return null;

      return {
        id: normalizeText(item?.id, 120),
        milestoneKey,
        status: normalizeEscalationStatus(item?.status, "open"),
        level: normalizeEscalationLevel(item?.level, "warning"),
        reason: normalizeText(item?.reason, 1500),
        resolutionNote: normalizeText(item?.resolutionNote || item?.decisionNote, 1500),
        openedBy: normalizeEscalationActor(item?.openedBy || item?.requestedBy),
        openedAt: toDateOrNull(item?.openedAt || item?.requestedAt || item?.createdAt),
        resolvedBy: normalizeEscalationActor(item?.resolvedBy || item?.decidedBy),
        resolvedAt: toDateOrNull(item?.resolvedAt || item?.decidedAt),
        updatedAt: toDateOrNull(item?.updatedAt || item?.openedAt || item?.requestedAt),
      };
    })
    .filter(Boolean);
}

export function findOpenEscalationForMilestone(escalations = [], milestoneKey = "") {
  const key = normalizeMilestoneKey(milestoneKey);
  if (!key) return null;

  const normalized = normalizeMilestoneEscalations(escalations);
  let current = null;
  let currentTs = -1;

  for (const item of normalized) {
    if (item.milestoneKey !== key) continue;
    if (item.status !== "open") continue;

    const ts = new Date(item.updatedAt || item.openedAt || 0).getTime();
    if (!current || ts > currentTs) {
      current = item;
      currentTs = ts;
    }
  }

  return current;
}

export function buildMilestoneSla(
  milestone = {},
  { now = new Date(), dueSoonHours, escalationOverdueHours, escalation = null } = {}
) {
  const status = normalizeMilestoneStatus(milestone?.status, "pending");
  const dueDate = toDateOrNull(milestone?.dueDate);
  const nowDate = toDateOrNull(now) || new Date();
  const thresholds = resolveSlaThresholds({ dueSoonHours, escalationOverdueHours });
  const isClosed = status === "released" || status === "cancelled";
  const escalationOpen = normalizeEscalationStatus(escalation?.status, "cancelled") === "open";

  if (!dueDate) {
    return {
      dueDate: null,
      dueState: isClosed ? "closed" : "unscheduled",
      isDueSoon: false,
      isOverdue: false,
      dueInHours: 0,
      dueInDays: 0,
      overdueHours: 0,
      overdueDays: 0,
      breachLevel: "none",
      escalationEligible: false,
      escalationStatus: escalationOpen ? "open" : "none",
      escalationId: normalizeText(escalation?.id, 120),
      escalatedAt: toDateOrNull(escalation?.openedAt),
      thresholds,
    };
  }

  const deltaMs = dueDate.getTime() - nowDate.getTime();
  const dueInHours = Math.max(0, Math.ceil(deltaMs / (1000 * 60 * 60)));
  const dueInDays = Math.max(0, Math.ceil(deltaMs / (1000 * 60 * 60 * 24)));
  const overdueHours = Math.max(0, Math.ceil((nowDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60)));
  const overdueDays = Math.max(0, Math.ceil(overdueHours / 24));
  const isOverdue = !isClosed && deltaMs < 0;
  const isDueSoon = !isClosed && !isOverdue && deltaMs <= thresholds.dueSoonHours * 60 * 60 * 1000;
  const breachLevel = !isOverdue
    ? "none"
    : overdueHours >= thresholds.escalationOverdueHours
      ? "critical"
      : "warning";
  const escalationEligible = Boolean(
    isOverdue &&
    overdueHours >= thresholds.escalationOverdueHours &&
    !escalationOpen
  );

  let dueState = "on_track";
  if (isClosed) dueState = "closed";
  else if (escalationOpen) dueState = "escalated";
  else if (isOverdue) dueState = "overdue";
  else if (isDueSoon) dueState = "due_soon";

  return {
    dueDate,
    dueState,
    isDueSoon,
    isOverdue,
    dueInHours,
    dueInDays,
    overdueHours,
    overdueDays,
    breachLevel,
    escalationEligible,
    escalationStatus: escalationOpen ? "open" : "none",
    escalationId: normalizeText(escalation?.id, 120),
    escalatedAt: toDateOrNull(escalation?.openedAt),
    thresholds,
  };
}

export function hydrateMilestonesWithSla(milestones = [], { escalations = [], now, ...options } = {}) {
  const nowDate = toDateOrNull(now) || new Date();
  const normalizedEscalations = normalizeMilestoneEscalations(escalations);
  const thresholds = resolveSlaThresholds(options);

  return milestones.map((item) => {
    const milestoneKey = normalizeMilestoneKey(item?.key);
    const openEscalation = findOpenEscalationForMilestone(normalizedEscalations, milestoneKey);
    return {
      ...item,
      sla: buildMilestoneSla(item, {
        now: nowDate,
        dueSoonHours: thresholds.dueSoonHours,
        escalationOverdueHours: thresholds.escalationOverdueHours,
        escalation: openEscalation,
      }),
    };
  });
}

export function buildMilestoneSummary(milestones = [], options = {}) {
  const nowDate = toDateOrNull(options?.now) || new Date();
  const escalations = normalizeMilestoneEscalations(options?.escalations);
  const thresholds = resolveSlaThresholds(options);
  const withSla = hydrateMilestonesWithSla(milestones, {
    escalations,
    now: nowDate,
    dueSoonHours: thresholds.dueSoonHours,
    escalationOverdueHours: thresholds.escalationOverdueHours,
  });

  const summary = {
    total: milestones.length,
    pending: 0,
    inReview: 0,
    released: 0,
    disputed: 0,
    cancelled: 0,
    totalAmount: sumMilestoneAmounts(milestones),
    releasedAmount: 0,
    nextMilestoneKey: "",
    nextDueMilestoneKey: "",
    nextDueAt: null,
    overdue: 0,
    dueSoon: 0,
    escalated: 0,
    escalationRequired: false,
    maxOverdueHours: 0,
    thresholds,
  };

  let nextDueMs = Number.POSITIVE_INFINITY;

  for (const item of withSla) {
    const status = normalizeMilestoneStatus(item?.status, "pending");
    if (status === "pending") summary.pending += 1;
    if (status === "in_review") summary.inReview += 1;
    if (status === "released") {
      summary.released += 1;
      summary.releasedAmount += roundMoney(item?.amount);
    }
    if (status === "disputed") summary.disputed += 1;
    if (status === "cancelled") summary.cancelled += 1;

    const dueDate = toDateOrNull(item?.dueDate);
    if (dueDate && status !== "released" && status !== "cancelled") {
      const dueTs = dueDate.getTime();
      if (dueTs < nextDueMs) {
        nextDueMs = dueTs;
        summary.nextDueMilestoneKey = normalizeMilestoneKey(item?.key);
        summary.nextDueAt = dueDate;
      }
    }

    const sla = item?.sla || {};
    if (sla.isOverdue) {
      summary.overdue += 1;
      summary.maxOverdueHours = Math.max(summary.maxOverdueHours, Number(sla.overdueHours || 0));
    }
    if (sla.isDueSoon) summary.dueSoon += 1;
    if (sla.escalationStatus === "open") summary.escalated += 1;
  }

  const next = findFirstActionableMilestone(milestones);
  summary.nextMilestoneKey = next?.key || "";
  summary.releasedAmount = Math.round(summary.releasedAmount * 100) / 100;
  summary.escalationRequired = summary.overdue > 0;
  return summary;
}

export function buildContractCompletionRequest(milestones = [], preferredKey = "") {
  const preferred = findMilestoneByKey(milestones, preferredKey);
  const pending = findFirstByCompletionStatus(milestones, "pending");
  const fallback = findFirstActionableMilestone(milestones);
  const selected = pending || preferred || fallback;

  if (!selected?.milestone) {
    return buildEmptyCompletionRequest();
  }

  return {
    ...normalizeCompletionRequest(selected.milestone.completionRequest || {}),
    milestoneKey: selected.key,
    milestoneTitle: normalizeText(selected.milestone.title, 120),
    milestoneAmount: roundMoney(selected.milestone.amount),
    milestoneStatus: normalizeMilestoneStatus(selected.milestone.status),
  };
}
