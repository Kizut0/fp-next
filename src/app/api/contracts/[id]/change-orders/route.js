import { getDb } from "../../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../../lib/api";
import {
  buildContractCompletionRequest,
  buildMilestoneSummary,
  ensureContractMilestones,
  findMilestoneByKey,
} from "../../../../../lib/contractMilestones";
import {
  buildPaymentContractQuery,
  buildPaymentStatusHistoryEntry,
  ensurePaymentIndexes,
  normalizeId,
  normalizeMilestoneKey,
  normalizePaymentStatus,
} from "../../../../../lib/payments";

export const dynamic = "force-dynamic";

const CHANGE_ORDER_ACTIONS = new Set(["request", "approve", "reject", "cancel"]);
const CHANGE_ORDER_STATUSES = new Set(["pending", "approved", "rejected", "cancelled"]);

function normalizeContractQuery(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { contractId: id }] };
  return { $or: [{ _id: id }, { contractId: id }] };
}

function normalizeText(value, maxLen = 500) {
  return String(value || "").trim().slice(0, maxLen);
}

function normalizeActor(authUser = {}) {
  return {
    id: normalizeId(authUser.id),
    role: String(authUser.role || "").trim() || "Unknown",
    email: normalizeText(authUser.email, 160).toLowerCase(),
    name: normalizeText(authUser.name, 120),
  };
}

function sameDate(left, right) {
  const l = left ? new Date(left).getTime() : 0;
  const r = right ? new Date(right).getTime() : 0;
  if (!Number.isFinite(l) && !Number.isFinite(r)) return true;
  return l === r;
}

function parseDateOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function buildMilestoneSnapshot(milestone = {}) {
  return {
    title: normalizeText(milestone.title, 120),
    description: normalizeText(milestone.description, 1500),
    amount: Number(milestone.amount || 0),
    dueDate: parseDateOrNull(milestone.dueDate),
  };
}

function canAccessContract(authUser, contract) {
  if (authUser.role === "Admin") return true;

  const userId = normalizeId(authUser.id);
  if (!userId) return false;

  const participantIds = [
    contract.clientId,
    contract.userId,
    contract.ownerId,
    contract.createdBy,
    contract.freelancerId,
  ]
    .map((value) => normalizeId(value))
    .filter(Boolean);

  return participantIds.includes(userId);
}

function isClientOwner(authUser, contract) {
  if (authUser.role === "Admin") return true;
  if (authUser.role !== "Client") return false;

  const userId = normalizeId(authUser.id);
  if (!userId) return false;

  const clientIds = [contract.clientId, contract.userId, contract.ownerId, contract.createdBy]
    .map((value) => normalizeId(value))
    .filter(Boolean);
  return clientIds.includes(userId);
}

function isFreelancerOwner(authUser, contract) {
  if (authUser.role !== "Freelancer") return false;
  const userId = normalizeId(authUser.id);
  const freelancerId = normalizeId(contract.freelancerId);
  return Boolean(userId && freelancerId && userId === freelancerId);
}

function normalizeChangeOrderStatus(value, fallback = "pending") {
  const normalized = String(value || "").trim().toLowerCase();
  if (CHANGE_ORDER_STATUSES.has(normalized)) return normalized;
  return CHANGE_ORDER_STATUSES.has(fallback) ? fallback : "pending";
}

function normalizeStoredChangeOrders(changeOrders = []) {
  if (!Array.isArray(changeOrders)) return [];
  return changeOrders.map((item) => ({
    id: normalizeText(item?.id, 120),
    milestoneKey: normalizeMilestoneKey(item?.milestoneKey),
    status: normalizeChangeOrderStatus(item?.status, "pending"),
    reason: normalizeText(item?.reason, 1500),
    decisionNote: normalizeText(item?.decisionNote, 1500),
    requestedBy: item?.requestedBy || {},
    requestedAt: item?.requestedAt || null,
    decidedBy: item?.decidedBy || null,
    decidedAt: item?.decidedAt || null,
    before: item?.before || {},
    requestedChanges: item?.requestedChanges || {},
    after: item?.after || {},
    updatedAt: item?.updatedAt || null,
  }));
}

function normalizeContractForResponse(contract) {
  const milestones = ensureContractMilestones(contract);
  return {
    ...contract,
    milestones,
    milestoneSummary: buildMilestoneSummary(milestones),
    completionRequest: buildContractCompletionRequest(
      milestones,
      contract?.completionRequest?.milestoneKey
    ),
    changeOrders: normalizeStoredChangeOrders(contract?.changeOrders),
  };
}

function createChangeOrderId() {
  return `co_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseRequestedChanges(payload = {}, milestone = {}) {
  const source = payload?.changes && typeof payload.changes === "object" ? payload.changes : payload;
  const before = buildMilestoneSnapshot(milestone);
  const requestedChanges = {};
  const after = { ...before };

  if (Object.prototype.hasOwnProperty.call(source, "title")) {
    const title = normalizeText(source.title, 120);
    if (!title) return { error: "title cannot be empty" };
    if (title !== before.title) {
      requestedChanges.title = title;
      after.title = title;
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, "description")) {
    const description = normalizeText(source.description, 1500);
    if (description !== before.description) {
      requestedChanges.description = description;
      after.description = description;
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, "amount")) {
    const amount = Number(source.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { error: "amount must be greater than 0 when provided" };
    }
    const roundedAmount = Math.round(amount * 100) / 100;
    if (roundedAmount !== before.amount) {
      requestedChanges.amount = roundedAmount;
      after.amount = roundedAmount;
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, "dueDate")) {
    const dueDateRaw = source.dueDate;
    if (dueDateRaw === null || dueDateRaw === undefined || String(dueDateRaw).trim() === "") {
      if (before.dueDate !== null) {
        requestedChanges.dueDate = null;
        after.dueDate = null;
      }
    } else {
      const dueDate = parseDateOrNull(dueDateRaw);
      if (!dueDate) return { error: "dueDate must be a valid date when provided" };
      if (!sameDate(dueDate, before.dueDate)) {
        requestedChanges.dueDate = dueDate;
        after.dueDate = dueDate;
      }
    }
  }

  if (!Object.keys(requestedChanges).length) {
    return { error: "Provide at least one changed field (title, description, amount, dueDate)" };
  }

  return { before, requestedChanges, after };
}

function applyChangeOrderToMilestone(milestone = {}, changeOrder = {}) {
  const next = { ...milestone };
  const requestedChanges = changeOrder?.requestedChanges || {};

  if (Object.prototype.hasOwnProperty.call(requestedChanges, "title")) {
    next.title = normalizeText(requestedChanges.title, 120) || next.title;
  }
  if (Object.prototype.hasOwnProperty.call(requestedChanges, "description")) {
    next.description = normalizeText(requestedChanges.description, 1500);
  }
  if (Object.prototype.hasOwnProperty.call(requestedChanges, "amount")) {
    next.amount = Number(requestedChanges.amount);
  }
  if (Object.prototype.hasOwnProperty.call(requestedChanges, "dueDate")) {
    next.dueDate = parseDateOrNull(requestedChanges.dueDate);
  }

  return next;
}

async function syncPendingPaymentAmount({ db, contract, milestoneKey, nextAmount, actorId, now }) {
  const payments = db.collection("payments");
  await ensurePaymentIndexes(payments);

  const contractId = normalizeId(contract._id || contract.contractId);
  const paymentQuery = buildPaymentContractQuery(contractId, milestoneKey);
  if (!paymentQuery) return;

  const records = await payments.find(paymentQuery).toArray();
  if (!records.length) return;

  for (const record of records) {
    const status = normalizePaymentStatus(record.status, "");
    if (!["reserved", "in_review", "disputed"].includes(status)) continue;
    const currentAmount = Number(record.amount || 0);
    if (!Number.isFinite(currentAmount) || currentAmount === nextAmount) continue;

    await payments.updateOne(
      { _id: record._id },
      {
        $set: {
          amount: nextAmount,
          updatedAt: now,
        },
        $push: {
          statusHistory: {
            $each: [
              buildPaymentStatusHistoryEntry({
                action: "change_order_adjust_amount",
                fromStatus: status,
                toStatus: status,
                reason: `Approved change order updated milestone amount to ${nextAmount}`,
                actorId,
                at: now,
              }),
            ],
            $slice: -120,
          },
        },
      }
    );
  }
}

async function getParamId(params) {
  const resolved = await params;
  return String(resolved?.id || "").trim();
}

export async function OPTIONS(req) {
  return options(req);
}

export async function PATCH(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const rawId = await getParamId(params);
    const query = normalizeContractQuery(rawId);
    if (!query) return json({ message: "Invalid contract id" }, 400, req);

    const payload = await req.json();
    const action = String(payload?.action || "").trim().toLowerCase();
    if (!CHANGE_ORDER_ACTIONS.has(action)) {
      return json({ message: "Invalid action. Use request, approve, reject, or cancel." }, 400, req);
    }

    const db = await getDb();
    const contracts = db.collection("contracts");
    const contract = await contracts.findOne(query);
    if (!contract) return json({ message: "Contract not found" }, 404, req);
    if (!canAccessContract(auth.user, contract)) return json({ message: "Forbidden" }, 403, req);

    const contractStatus = String(contract.status || "active").toLowerCase();
    const now = new Date();
    const actor = normalizeActor(auth.user);
    const actorId = normalizeId(actor.id);
    const milestones = ensureContractMilestones(contract);
    const changeOrders = normalizeStoredChangeOrders(contract.changeOrders);

    if (action === "request") {
      if (contractStatus !== "active") {
        return json({ message: "Change orders can only be requested on active contracts" }, 409, req);
      }
      if (!isFreelancerOwner(auth.user, contract) && !isClientOwner(auth.user, contract) && auth.user.role !== "Admin") {
        return json({ message: "Only assigned freelancer/client/admin can request change orders" }, 403, req);
      }

      const milestoneKey = normalizeMilestoneKey(payload?.milestoneKey || payload?.milestoneId);
      const selected = findMilestoneByKey(milestones, milestoneKey);
      if (!selected?.milestone) return json({ message: `Milestone not found: ${milestoneKey}` }, 404, req);

      const currentMilestone = selected.milestone;
      const milestoneStatus = String(currentMilestone.status || "pending").toLowerCase();
      const requestStatus = String(currentMilestone?.completionRequest?.status || "not_submitted").toLowerCase();
      if (milestoneStatus === "released" || milestoneStatus === "cancelled") {
        return json({ message: "Cannot request change order for released/cancelled milestone" }, 409, req);
      }
      if (requestStatus === "pending") {
        return json({ message: "Cannot request change order while milestone submission is pending review" }, 409, req);
      }

      const hasPending = changeOrders.some(
        (item) =>
          normalizeChangeOrderStatus(item.status, "pending") === "pending" &&
          normalizeMilestoneKey(item.milestoneKey) === milestoneKey
      );
      if (hasPending) {
        return json({ message: "A pending change order already exists for this milestone" }, 409, req);
      }

      const reason = normalizeText(payload?.reason, 1500);
      if (reason.length < 10) {
        return json({ message: "reason must be at least 10 characters" }, 400, req);
      }

      const parsed = parseRequestedChanges(payload, currentMilestone);
      if (parsed.error) return json({ message: parsed.error }, 400, req);

      const created = {
        id: createChangeOrderId(),
        milestoneKey,
        status: "pending",
        reason,
        decisionNote: "",
        requestedBy: actor,
        requestedAt: now,
        decidedBy: null,
        decidedAt: null,
        before: parsed.before,
        requestedChanges: parsed.requestedChanges,
        after: parsed.after,
        updatedAt: now,
      };

      const nextChangeOrders = [...changeOrders, created];
      await contracts.updateOne(
        { _id: contract._id },
        {
          $set: {
            changeOrders: nextChangeOrders,
            updatedAt: now,
          },
        }
      );

      const updated = await contracts.findOne({ _id: contract._id });
      return json(cleanDoc(normalizeContractForResponse(updated)), 200, req);
    }

    const changeOrderId = normalizeText(payload?.changeOrderId || payload?.id, 120);
    if (!changeOrderId) return json({ message: "changeOrderId is required" }, 400, req);

    const changeOrderIndex = changeOrders.findIndex((item) => normalizeText(item.id, 120) === changeOrderId);
    if (changeOrderIndex < 0) return json({ message: "Change order not found" }, 404, req);

    const currentChangeOrder = changeOrders[changeOrderIndex];
    if (normalizeChangeOrderStatus(currentChangeOrder.status, "pending") !== "pending") {
      return json({ message: "Only pending change orders can be processed" }, 409, req);
    }

    const milestoneKey = normalizeMilestoneKey(currentChangeOrder.milestoneKey);
    const selected = findMilestoneByKey(milestones, milestoneKey);
    if (!selected?.milestone) return json({ message: `Milestone not found: ${milestoneKey}` }, 404, req);

    if (action === "approve" || action === "reject") {
      if (!isClientOwner(auth.user, contract)) {
        return json({ message: "Only contract owner/admin can approve or reject change orders" }, 403, req);
      }
    }

    if (action === "cancel") {
      const requesterId = normalizeId(currentChangeOrder?.requestedBy?.id);
      const canCancel =
        auth.user.role === "Admin" ||
        isClientOwner(auth.user, contract) ||
        (Boolean(requesterId) && requesterId === normalizeId(auth.user.id));
      if (!canCancel) {
        return json({ message: "Only requester/client/admin can cancel this change order" }, 403, req);
      }
    }

    const decisionNote = normalizeText(payload?.decisionNote || payload?.note, 1500);
    const nextChangeOrders = [...changeOrders];
    let nextMilestones = [...milestones];
    const nextChangeOrderStatus =
      action === "approve" ? "approved" : action === "reject" ? "rejected" : "cancelled";

    if (action === "approve") {
      if (contractStatus !== "active") {
        return json({ message: "Only active contracts can approve change orders" }, 409, req);
      }

      const milestoneStatus = String(selected.milestone.status || "pending").toLowerCase();
      if (milestoneStatus === "released" || milestoneStatus === "cancelled") {
        return json({ message: "Cannot approve change order for released/cancelled milestone" }, 409, req);
      }

      const nextMilestone = applyChangeOrderToMilestone(selected.milestone, currentChangeOrder);
      nextMilestones = milestones.map((item, index) => (index === selected.index ? nextMilestone : item));

      const previousAmount = Number(selected.milestone.amount || 0);
      const nextAmount = Number(nextMilestone.amount || 0);
      if (Number.isFinite(nextAmount) && nextAmount > 0 && nextAmount !== previousAmount) {
        await syncPendingPaymentAmount({
          db,
          contract,
          milestoneKey,
          nextAmount,
          actorId,
          now,
        });
      }
    }

    nextChangeOrders[changeOrderIndex] = {
      ...currentChangeOrder,
      status: nextChangeOrderStatus,
      decisionNote,
      decidedBy: actor,
      decidedAt: now,
      updatedAt: now,
    };

    const nextSummary = buildMilestoneSummary(nextMilestones);
    await contracts.updateOne(
      { _id: contract._id },
      {
        $set: {
          milestones: nextMilestones,
          amount: Number(nextSummary.totalAmount || contract.amount || 0),
          milestoneSummary: nextSummary,
          completionRequest: buildContractCompletionRequest(
            nextMilestones,
            contract?.completionRequest?.milestoneKey
          ),
          changeOrders: nextChangeOrders,
          updatedAt: now,
        },
      }
    );

    const updated = await contracts.findOne({ _id: contract._id });
    return json(cleanDoc(normalizeContractForResponse(updated)), 200, req);
  } catch (error) {
    return json({ message: "Failed to process change order action", error: error.message }, 500, req);
  }
}
