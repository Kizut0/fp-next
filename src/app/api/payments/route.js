import { getDb } from "../../../lib/mongodb";
import { cleanDoc, cleanDocs, json, options, requireAuth, toObjectId } from "../../../lib/api";
import { ensureContractMilestones, findMilestoneByKey } from "../../../lib/contractMilestones";
import {
  ACTIVE_PAYMENT_STATUSES,
  appendDisputeEvidence,
  appendEscrowLedgerEntry,
  buildDisputeMediationUpdate,
  buildDefaultDisputeState,
  buildDisputeOpenState,
  buildDisputeResolvedState,
  buildIdempotencyEntry,
  buildPaymentContractQuery,
  buildPaymentStatusHistoryEntry,
  canReconcileProviderStatus,
  canTransitionPaymentStatus,
  ensurePaymentLedgerIndexes,
  ensurePaymentIndexes,
  hasIdempotencyKey,
  hasOpenDispute,
  isActivePaymentStatus,
  normalizeCanonicalContractId,
  normalizeDisputeStage,
  normalizeDisputeState,
  normalizeId,
  normalizeIdempotencyKey,
  normalizeMilestoneKey,
  normalizePaymentStatus,
  normalizeResolution,
  resolveDisputeSlaHours,
} from "../../../lib/payments";

export const dynamic = "force-dynamic";

const CLIENT_ALLOWED_CREATE_STATUSES = new Set(["reserved", "in_review"]);
const MUTATION_ACTIONS = new Set(["transition", "dispute", "resolve", "withdraw", "evidence", "mediate"]);
const MEDIATION_STAGE_ACTIONS = new Set(["evidence", "mediation", "decision"]);

function normalizeContractQuery(rawId) {
  const id = normalizeId(rawId);
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { contractId: id }] };
  return { $or: [{ _id: id }, { contractId: id }] };
}

function normalizePaymentQuery(rawId) {
  const id = normalizeId(rawId);
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { paymentId: id }] };
  return { $or: [{ _id: id }, { paymentId: id }] };
}

function resolveUserQuery(rawUserId) {
  const userId = normalizeId(rawUserId);
  if (!userId) return null;

  const objectId = toObjectId(userId);
  if (objectId) {
    return { $or: [{ _id: objectId }, { _id: userId }, { userId }] };
  }

  return { $or: [{ _id: userId }, { userId }] };
}

async function recordWithdrawAttempt(users, freelancerId, now) {
  const userQuery = resolveUserQuery(freelancerId);
  if (!userQuery) return;

  await users.updateOne(userQuery, { $inc: { withdrawCount: 1 }, $set: { updatedAt: now } });

  const user = await users.findOne(userQuery, {
    projection: { withdrawCount: 1, status: 1 },
  });

  const withdrawCount = Number(user?.withdrawCount || 0);
  const status = String(user?.status || "active").trim().toLowerCase();
  if (withdrawCount >= 10 && status !== "deactive") {
    await users.updateOne(userQuery, { $set: { status: "deactive", updatedAt: now } });
  }
}

function resolveContractClientId(contract) {
  return (
    normalizeId(contract.clientId) ||
    normalizeId(contract.userId) ||
    normalizeId(contract.ownerId) ||
    normalizeId(contract.createdBy)
  );
}

function canCreatePayment(authUser, contract) {
  if (authUser.role === "Admin") return true;

  const actorId = normalizeId(authUser.id);
  if (!actorId) return false;

  const ownerIds = [
    contract.clientId,
    contract.userId,
    contract.ownerId,
    contract.createdBy,
  ]
    .map(normalizeId)
    .filter(Boolean);

  return ownerIds.includes(actorId);
}

function canDisputePayment(authUser, payment) {
  if (authUser.role === "Admin") return true;
  if (authUser.role !== "Client") return false;

  const actorId = normalizeId(authUser.id);
  if (!actorId) return false;
  return normalizeId(payment?.clientId) === actorId;
}

function canWithdrawPayment(authUser, payment) {
  if (authUser.role === "Admin") return true;
  if (authUser.role !== "Freelancer") return false;

  const actorId = normalizeId(authUser.id);
  if (!actorId) return false;
  return normalizeId(payment?.freelancerId) === actorId;
}

function canContributeDisputeEvidence(authUser, payment) {
  if (authUser.role === "Admin") return true;
  const actorId = normalizeId(authUser.id);
  if (!actorId) return false;
  return normalizeId(payment?.clientId) === actorId || normalizeId(payment?.freelancerId) === actorId;
}

function normalizeMutationAction(payload = {}) {
  const raw = normalizeId(payload.action).toLowerCase();
  if (raw) return raw;
  if (payload.status !== undefined || payload.toStatus !== undefined) return "transition";
  return "";
}

function normalizeNote(value, maxLen = 1500) {
  return normalizeId(value).slice(0, maxLen);
}

function normalizeProviderName(value) {
  return normalizeId(value).slice(0, 120);
}

function normalizeProviderPaymentId(value) {
  return normalizeId(value).slice(0, 180);
}

function normalizeProviderEventType(value) {
  return normalizeId(value).slice(0, 120);
}

function normalizeProviderRawStatus(value) {
  return normalizeId(value).slice(0, 80);
}

function resolveEvidencePayload(payload = {}) {
  const direct = payload.evidence || payload.evidenceItems || payload.files || payload.links;
  if (Array.isArray(direct)) return direct;
  if (direct && typeof direct === "object") return [direct];

  const fallback = [];
  const link = normalizeId(payload.evidenceLink || payload.link || payload.url);
  if (link) fallback.push({ type: "link", url: link });

  const fileData = payload.evidenceFile || payload.file || payload.attachment;
  if (fileData && typeof fileData === "object") fallback.push(fileData);
  return fallback;
}

function resolveIdempotencyKey(req, payload = {}) {
  return normalizeIdempotencyKey(
    payload.idempotencyKey ||
    req.headers.get("x-idempotency-key") ||
    req.headers.get("idempotency-key")
  );
}

function isDuplicateKeyError(error) {
  return Number(error?.code || 0) === 11000;
}

function buildStatusFilterQuery(status) {
  if (!status) return null;
  if (status === "reserved") return { $in: ["reserved", "hold"] };
  if (status === "in_review") return { $in: ["in_review", "pending"] };
  if (status === "released") return { $in: ["released", "paid"] };
  return status;
}

function normalizePaymentForResponse(payment) {
  const normalizedStatus = normalizePaymentStatus(payment?.status, "");
  const status = normalizedStatus || normalizeId(payment?.status).toLowerCase();
  return {
    ...payment,
    status,
    milestoneKey: normalizeMilestoneKey(payment?.milestoneKey),
    dispute: normalizeDisputeState(payment?.dispute || {}, { now: new Date() }),
    isActive:
      typeof payment?.isActive === "boolean"
        ? payment.isActive
        : isActivePaymentStatus(status),
  };
}

function buildMilestoneMatchQuery(milestoneKey) {
  if (milestoneKey !== "default") {
    return { milestoneKey };
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

function normalizeContractIds(values = []) {
  const ids = [];
  const seen = new Set();

  for (const value of values) {
    const normalized = normalizeId(value);
    if (!normalized) continue;

    const stringKey = `s:${normalized}`;
    if (!seen.has(stringKey)) {
      seen.add(stringKey);
      ids.push(normalized);
    }

    const objectId = toObjectId(normalized);
    if (!objectId) continue;

    const objectIdKey = `o:${String(objectId)}`;
    if (!seen.has(objectIdKey)) {
      seen.add(objectIdKey);
      ids.push(objectId);
    }
  }

  return ids;
}

function buildActiveStatusQuery() {
  return {
    $in: [...ACTIVE_PAYMENT_STATUSES, "hold", "pending", "paid", "disputed"],
  };
}

async function findActiveConflict(payments, { contractIds = [], milestoneKey, excludeId = null }) {
  const ids = normalizeContractIds(contractIds);
  if (!ids.length) return null;

  const query = {
    contractId: { $in: ids },
    ...buildMilestoneMatchQuery(milestoneKey),
    $or: [{ isActive: true }, { status: buildActiveStatusQuery() }],
  };

  if (excludeId) query._id = { $ne: excludeId };

  return payments.findOne(query, {
    projection: { _id: 1, contractId: 1, milestoneKey: 1, status: 1 },
  });
}

async function resolvePaymentFromPayload(payments, payload = {}) {
  const paymentId = normalizeId(payload.paymentId || payload.id || payload._id);
  if (paymentId) {
    const query = normalizePaymentQuery(paymentId);
    if (!query) return null;
    return payments.findOne(query);
  }

  const milestoneKey = normalizeMilestoneKey(payload.milestoneKey || payload.milestoneId);
  const contractQuery = buildPaymentContractQuery(payload.contractId, milestoneKey);
  if (!contractQuery) return null;

  return payments.findOne(contractQuery, {
    sort: { isActive: -1, updatedAt: -1, createdAt: -1 },
  });
}

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { searchParams } = new URL(req.url);
    const statusFilter = normalizePaymentStatus(searchParams.get("status"), "");
    const milestoneFilter = normalizeId(searchParams.get("milestoneKey") || searchParams.get("milestoneId"));

    const query = {};
    if (auth.user.role === "Client") query.clientId = auth.user.id;
    if (auth.user.role === "Freelancer") query.freelancerId = auth.user.id;
    if (statusFilter) query.status = buildStatusFilterQuery(statusFilter);
    if (milestoneFilter) query.milestoneKey = normalizeMilestoneKey(milestoneFilter);

    const db = await getDb();
    const payments = db.collection("payments");
    await ensurePaymentIndexes(payments);

    const items = await payments.find(query).sort({ createdAt: -1 }).toArray();
    const normalized = items.map(normalizePaymentForResponse);
    return json(cleanDocs(normalized), 200, req);
  } catch (error) {
    return json({ message: "Failed to load payments", error: error.message }, 500, req);
  }
}

export async function POST(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  if (!["Client", "Admin"].includes(auth.user.role)) {
    return json({ message: "Only clients/admins can create payments" }, 403, req);
  }

  try {
    const payload = await req.json();
    const contractIdInput = normalizeId(payload.contractId);
    const milestoneInput = normalizeId(payload.milestoneKey || payload.milestoneId);
    let milestoneKey = milestoneInput ? normalizeMilestoneKey(milestoneInput) : "";
    const amountInput = payload.amount;
    const status = normalizePaymentStatus(payload.status, "reserved");
    const note = normalizeNote(payload.note);
    const currency = normalizeNote(payload.currency || "THB", 16).toUpperCase() || "THB";
    const providerName = normalizeProviderName(payload.provider || payload.providerName);
    const providerPaymentId = normalizeProviderPaymentId(
      payload.providerPaymentId || payload.externalPaymentId || payload.processorPaymentId
    );
    const providerEventType = normalizeProviderEventType(payload.providerEventType || payload.eventType);
    const providerRawStatus = normalizeProviderRawStatus(payload.providerStatus || payload.rawStatus);
    const idempotencyKey = resolveIdempotencyKey(req, payload);

    if (!contractIdInput) {
      return json({ message: "contractId is required" }, 400, req);
    }

    if (!status) {
      return json(
        { message: "status must be one of: reserved, in_review, released, withdrawn, failed, refunded, disputed" },
        400,
        req
      );
    }

    if (auth.user.role !== "Admin" && !CLIENT_ALLOWED_CREATE_STATUSES.has(status)) {
      return json({ message: "Client can only create reserved/in_review payments" }, 403, req);
    }

    const contractQuery = normalizeContractQuery(contractIdInput);
    if (!contractQuery) {
      return json({ message: "Invalid contract id" }, 400, req);
    }

    const db = await getDb();
    const payments = db.collection("payments");
    const ledger = db.collection(process.env.PAYMENT_LEDGER_COLLECTION || "paymentLedger");
    await ensurePaymentIndexes(payments);
    await ensurePaymentLedgerIndexes(ledger);

    const contract = await db.collection("contracts").findOne(contractQuery);
    if (!contract) {
      return json({ message: "Contract not found" }, 404, req);
    }

    if (!canCreatePayment(auth.user, contract)) {
      return json({ message: "Forbidden" }, 403, req);
    }

    const contractStatus = String(contract.status || "active").toLowerCase();
    if (contractStatus === "cancelled") {
      return json({ message: "Cannot create payment for a cancelled contract" }, 400, req);
    }

    const contractMilestones = ensureContractMilestones(contract);
    if (!milestoneKey) {
      if (contractMilestones.length === 1) {
        milestoneKey = normalizeMilestoneKey(contractMilestones[0].key);
      } else {
        return json(
          { message: "milestoneKey is required for multi-milestone contracts" },
          400,
          req
        );
      }
    }

    const milestoneMatch = findMilestoneByKey(contractMilestones, milestoneKey);
    if (!milestoneMatch?.milestone) {
      return json(
        { message: `milestoneKey '${milestoneKey}' does not exist for this contract` },
        400,
        req
      );
    }

    const milestoneAmount = Number(milestoneMatch.milestone.amount || 0);
    const amount =
      amountInput !== undefined && amountInput !== null && amountInput !== ""
        ? Number(amountInput)
        : milestoneAmount;

    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ message: "amount must be greater than 0" }, 400, req);
    }

    if (
      auth.user.role !== "Admin" &&
      Number.isFinite(milestoneAmount) &&
      milestoneAmount > 0 &&
      Math.abs(amount - milestoneAmount) > 0.01
    ) {
      return json(
        { message: `amount must match milestone amount (${milestoneAmount})` },
        400,
        req
      );
    }

    const contractFreelancerId = normalizeId(contract.freelancerId);
    const payloadFreelancerId = normalizeId(payload.freelancerId);
    if (contractFreelancerId && payloadFreelancerId && contractFreelancerId !== payloadFreelancerId) {
      return json({ message: "freelancerId does not match this contract" }, 400, req);
    }

    const freelancerId = contractFreelancerId || payloadFreelancerId;
    if (!freelancerId) {
      return json({ message: "freelancerId is required" }, 400, req);
    }

    const contractClientId = resolveContractClientId(contract);
    const clientId =
      auth.user.role === "Admin"
        ? normalizeId(payload.clientId) || contractClientId || normalizeId(auth.user.id)
        : normalizeId(auth.user.id);

    if (!clientId) {
      return json({ message: "clientId is required" }, 400, req);
    }

    if (auth.user.role !== "Admin" && contractClientId && clientId !== contractClientId) {
      return json({ message: "clientId does not match this contract" }, 400, req);
    }

    const canonicalContractId = normalizeCanonicalContractId(contract, contractIdInput);
    if (!canonicalContractId) {
      return json({ message: "Unable to resolve canonical contract id" }, 400, req);
    }
    const contractIdCandidates = normalizeContractIds([
      canonicalContractId,
      contractIdInput,
      contract.contractId,
    ]);

    if (idempotencyKey) {
      const existingByKey = await payments.findOne(
        {
          contractId: { $in: contractIdCandidates },
          ...buildMilestoneMatchQuery(milestoneKey),
          "idempotencyLog.key": idempotencyKey,
        },
        { sort: { updatedAt: -1, createdAt: -1 } }
      );

      if (existingByKey) {
        return json(
          {
            ...cleanDoc(normalizePaymentForResponse(existingByKey)),
            idempotent: true,
          },
          200,
          req
        );
      }
    }

    if (isActivePaymentStatus(status)) {
      const conflict = await findActiveConflict(payments, {
        contractIds: contractIdCandidates,
        milestoneKey,
      });
      if (conflict) {
        return json(
          { message: "Only one active payment is allowed per contract/milestone" },
          409,
          req
        );
      }
    }

    let dispute = buildDefaultDisputeState();
    if (status === "disputed") {
      if (auth.user.role !== "Admin") {
        return json({ message: "Only admin can create disputed payments directly" }, 403, req);
      }

      const reason = normalizeNote(payload.reason || payload.note);
      if (reason.length < 10) {
        return json({ message: "Dispute reason must be at least 10 characters" }, 400, req);
      }
      dispute = buildDisputeOpenState({
        reason,
        openedBy: normalizeId(auth.user.id),
        now: new Date(),
        evidence: resolveEvidencePayload(payload),
        stage: normalizeDisputeStage(payload.stage || payload.mediationStage, "evidence"),
        note: normalizeNote(payload.mediationNote || payload.note, 1500),
        slaHours: resolveDisputeSlaHours(payload.slaHours),
      });
    }

    const now = new Date();
    const doc = {
      contractId: canonicalContractId,
      milestoneKey,
      clientId,
      freelancerId,
      amount,
      currency,
      status,
      isActive: isActivePaymentStatus(status),
      note,
      dispute: normalizeDisputeState(dispute, { now }),
      provider: {
        name: providerName,
        paymentId: providerPaymentId,
        lastEventType: providerEventType,
        rawStatus: providerRawStatus,
        reconciledAt: null,
      },
      statusHistory: [
        buildPaymentStatusHistoryEntry({
          action: "create",
          fromStatus: "",
          toStatus: status,
          reason: note,
          actorId: normalizeId(auth.user.id),
          at: now,
        }),
      ],
      idempotencyLog: idempotencyKey
        ? [
            buildIdempotencyEntry({
              key: idempotencyKey,
              action: "create",
              fromStatus: "",
              toStatus: status,
              actorId: normalizeId(auth.user.id),
              at: now,
            }),
          ]
        : [],
      createdAt: now,
      updatedAt: now,
    };

    try {
      const result = await payments.insertOne(doc);
      const insertedDoc = { ...doc, _id: result.insertedId };
      await appendEscrowLedgerEntry(ledger, {
        payment: insertedDoc,
        fromStatus: "",
        toStatus: status,
        action: "create",
        reason: note || "payment_created",
        actorId: normalizeId(auth.user.id),
        actorRole: normalizeId(auth.user.role),
        source: "payments_api",
        idempotencyKey,
        at: now,
        provider: insertedDoc.provider,
      });
      return json(
        cleanDoc(normalizePaymentForResponse(insertedDoc)),
        201,
        req
      );
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        if (idempotencyKey) {
          const existing = await payments.findOne(
            {
              contractId: { $in: contractIdCandidates },
              ...buildMilestoneMatchQuery(milestoneKey),
              "idempotencyLog.key": idempotencyKey,
            },
            { sort: { updatedAt: -1, createdAt: -1 } }
          );
          if (existing) {
            return json(
              {
                ...cleanDoc(normalizePaymentForResponse(existing)),
                idempotent: true,
              },
              200,
              req
            );
          }
        }

        return json(
          { message: "Only one active payment is allowed per contract/milestone" },
          409,
          req
        );
      }

      throw error;
    }
  } catch (error) {
    return json({ message: "Failed to create payment", error: error.message }, 500, req);
  }
}

export async function PATCH(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const payload = await req.json();
    const action = normalizeMutationAction(payload);
    if (!MUTATION_ACTIONS.has(action)) {
      return json(
        { message: "Invalid action. Use transition, dispute, resolve, withdraw, evidence, or mediate." },
        400,
        req
      );
    }

    const db = await getDb();
    const payments = db.collection("payments");
    const ledger = db.collection(process.env.PAYMENT_LEDGER_COLLECTION || "paymentLedger");
    const users = db.collection(process.env.USER_COLLECTION || "userData");
    await ensurePaymentIndexes(payments);
    await ensurePaymentLedgerIndexes(ledger);

    const payment = await resolvePaymentFromPayload(payments, payload);
    if (!payment) {
      return json({ message: "Payment not found. Provide payment id or contractId/milestone." }, 404, req);
    }

    const idempotencyKey = resolveIdempotencyKey(req, payload);
    if (idempotencyKey && hasIdempotencyKey(payment, idempotencyKey)) {
      return json(
        {
          ...cleanDoc(normalizePaymentForResponse(payment)),
          idempotent: true,
        },
        200,
        req
      );
    }

    const actorId = normalizeId(auth.user.id);
    const currentStatus = normalizePaymentStatus(payment.status, "");
    if (!currentStatus) {
      return json({ message: "Current payment status is invalid" }, 409, req);
    }

    const now = new Date();
    const contractId = normalizeId(payment.contractId);
    const contractIdCandidates = normalizeContractIds([contractId, payload.contractId]);
    const milestoneKey = normalizeMilestoneKey(
      payment.milestoneKey || payload.milestoneKey || payload.milestoneId
    );

    let nextStatus = currentStatus;
    let reason = "";
    const updateSet = {};
    const currentDispute = normalizeDisputeState(payment.dispute || {}, { now });

    if (action === "dispute") {
      if (!canDisputePayment(auth.user, payment)) {
        return json({ message: "Only payment owner client can open dispute" }, 403, req);
      }
      if (hasOpenDispute({ ...payment, dispute: currentDispute })) {
        return json({ message: "Dispute is already open for this payment" }, 409, req);
      }

      reason = normalizeNote(payload.reason || payload.note);
      if (reason.length < 10) {
        return json({ message: "Dispute reason must be at least 10 characters" }, 400, req);
      }

      nextStatus = "disputed";
      updateSet.dispute = buildDisputeOpenState({
        reason,
        openedBy: actorId,
        now,
        evidence: resolveEvidencePayload(payload),
        stage: normalizeDisputeStage(payload.stage || payload.mediationStage, "evidence"),
        note: normalizeNote(payload.mediationNote || payload.note, 1500),
        slaHours: resolveDisputeSlaHours(payload.slaHours),
      });
    }

    if (action === "resolve") {
      if (auth.user.role !== "Admin") {
        return json({ message: "Only admin can resolve disputes" }, 403, req);
      }
      if (!hasOpenDispute({ ...payment, dispute: currentDispute })) {
        return json({ message: "No open dispute to resolve for this payment" }, 400, req);
      }

      const resolution = normalizeResolution(payload.resolution || payload.decision);
      if (!resolution) {
        return json({ message: "resolution must be release or refund" }, 400, req);
      }

      const resolutionNote = normalizeNote(payload.note || payload.resolutionNote);
      reason = resolutionNote || `resolved:${resolution}`;
      nextStatus = resolution === "release" ? "released" : "refunded";
      updateSet.dispute = buildDisputeResolvedState({
        previous: currentDispute,
        resolution,
        resolutionNote,
        resolvedBy: actorId,
        now,
      });
    }

    if (action === "withdraw") {
      if (!canWithdrawPayment(auth.user, payment)) {
        return json({ message: "Only admin/freelancer owner can withdraw released payments" }, 403, req);
      }
      if (hasOpenDispute({ ...payment, dispute: currentDispute })) {
        return json({ message: "Cannot withdraw while dispute is open" }, 409, req);
      }

      nextStatus = "withdrawn";
      reason = normalizeNote(payload.reason || payload.note || "freelancer_withdraw");
    }

    if (action === "evidence") {
      if (!canContributeDisputeEvidence(auth.user, payment)) {
        return json({ message: "Only client/freelancer owner/admin can add dispute evidence" }, 403, req);
      }
      if (!hasOpenDispute({ ...payment, dispute: currentDispute })) {
        return json({ message: "No open dispute to add evidence" }, 409, req);
      }

      const evidence = resolveEvidencePayload(payload);
      if (!evidence.length) {
        return json({ message: "evidence is required (file/link list)" }, 400, req);
      }

      reason = normalizeNote(payload.note || payload.evidenceNote || "dispute_evidence_added");
      updateSet.dispute = appendDisputeEvidence({
        previous: currentDispute,
        evidence,
        actorId,
        note: reason,
        now,
      });
    }

    if (action === "mediate") {
      if (auth.user.role !== "Admin") {
        return json({ message: "Only admin can update mediation stage" }, 403, req);
      }
      if (!hasOpenDispute({ ...payment, dispute: currentDispute })) {
        return json({ message: "No open dispute to mediate" }, 409, req);
      }

      const requestedStage = normalizeId(payload.stage || payload.mediationStage).toLowerCase();
      if (!MEDIATION_STAGE_ACTIONS.has(requestedStage)) {
        return json({ message: "stage must be one of: evidence, mediation, decision" }, 400, req);
      }

      reason = normalizeNote(payload.note || payload.mediationNote || `stage:${requestedStage}`);
      updateSet.dispute = buildDisputeMediationUpdate({
        previous: currentDispute,
        stage: requestedStage,
        note: reason,
        actorId,
        now,
        slaHours:
          payload.slaHours !== undefined
            ? resolveDisputeSlaHours(payload.slaHours)
            : undefined,
      });
    }

    if (action === "transition") {
      if (auth.user.role !== "Admin") {
        return json({ message: "Only admin can perform generic status transitions" }, 403, req);
      }

      nextStatus = normalizePaymentStatus(payload.toStatus || payload.status, "");
      if (!nextStatus) {
        return json(
          { message: "toStatus/status must be one of: reserved, in_review, released, withdrawn, failed, refunded, disputed" },
          400,
          req
        );
      }

      if (currentStatus === "disputed" && nextStatus !== "disputed") {
        return json({ message: "Use action=resolve to transition from disputed status" }, 409, req);
      }

      if (nextStatus === "disputed") {
        if (hasOpenDispute({ ...payment, dispute: currentDispute })) {
          return json({ message: "Dispute is already open for this payment" }, 409, req);
        }

        reason = normalizeNote(payload.reason || payload.note);
        if (reason.length < 10) {
          return json({ message: "Dispute reason must be at least 10 characters" }, 400, req);
        }

        updateSet.dispute = buildDisputeOpenState({
          reason,
          openedBy: actorId,
          now,
          evidence: resolveEvidencePayload(payload),
          stage: normalizeDisputeStage(payload.stage || payload.mediationStage, "evidence"),
          note: normalizeNote(payload.mediationNote || payload.note, 1500),
          slaHours: resolveDisputeSlaHours(payload.slaHours),
        });
      } else {
        if (hasOpenDispute({ ...payment, dispute: currentDispute })) {
          return json({ message: "Open dispute must be resolved before changing to this status" }, 409, req);
        }
        reason = normalizeNote(payload.reason || payload.note || `${currentStatus} -> ${nextStatus}`);
      }
    }

    const sourceRaw = normalizeId(payload.source).toLowerCase();
    const providerReconcile = sourceRaw === "provider" || sourceRaw === "webhook";
    const providerName = normalizeProviderName(payload.provider || payload.providerName);
    const providerPaymentId = normalizeProviderPaymentId(
      payload.providerPaymentId || payload.externalPaymentId || payload.processorPaymentId
    );
    const providerEventId = normalizeNote(payload.eventId || payload.providerEventId, 180);
    const providerEventType = normalizeProviderEventType(payload.providerEventType || payload.eventType || payload.type);
    const providerRawStatus = normalizeProviderRawStatus(payload.providerStatus || payload.rawStatus || payload.status || payload.toStatus);
    const transitionAllowed = providerReconcile
      ? canReconcileProviderStatus(currentStatus, nextStatus)
      : canTransitionPaymentStatus(currentStatus, nextStatus);

    if (!transitionAllowed) {
      return json(
        {
          message: `Invalid payment status transition: ${currentStatus} -> ${nextStatus}`,
        },
        409,
        req
      );
    }

    const statusChanged = currentStatus !== nextStatus;
    if (!statusChanged && !updateSet.dispute) {
      return json(
        {
          ...cleanDoc(normalizePaymentForResponse(payment)),
          idempotent: true,
        },
        200,
        req
      );
    }

    if (isActivePaymentStatus(nextStatus)) {
      const conflict = await findActiveConflict(payments, {
        contractIds: contractIdCandidates,
        milestoneKey,
        excludeId: payment._id,
      });

      if (conflict) {
        return json(
          { message: "Only one active payment is allowed per contract/milestone" },
          409,
          req
        );
      }
    }

    const providerBase =
      payment.provider && typeof payment.provider === "object" ? payment.provider : {};
    const providerNext = {
      ...providerBase,
      ...(providerName ? { name: providerName } : {}),
      ...(providerPaymentId ? { paymentId: providerPaymentId } : {}),
      ...(providerEventType ? { lastEventType: providerEventType } : {}),
      ...(providerEventId ? { lastEventId: providerEventId } : {}),
      ...(providerRawStatus ? { rawStatus: providerRawStatus } : {}),
      ...(providerReconcile ? { reconciledAt: now } : {}),
    };
    const hasProviderPatch =
      providerName ||
      providerPaymentId ||
      providerEventType ||
      providerEventId ||
      providerRawStatus ||
      providerReconcile;
    if (hasProviderPatch) {
      updateSet.provider = providerNext;
    }

    if (!reason) {
      reason = normalizeNote(payload.note || `${action}:${currentStatus}->${nextStatus}`);
    }

    const update = {
      $set: {
        ...updateSet,
        status: nextStatus,
        milestoneKey,
        isActive: isActivePaymentStatus(nextStatus),
        updatedAt: now,
      },
      $push: {
        statusHistory: {
          $each: [
            buildPaymentStatusHistoryEntry({
              action,
              fromStatus: currentStatus,
              toStatus: nextStatus,
              reason,
              actorId,
              at: now,
            }),
          ],
          $slice: -120,
        },
      },
    };

    if (idempotencyKey) {
      update.$push.idempotencyLog = {
        $each: [
          buildIdempotencyEntry({
            key: idempotencyKey,
            action,
            fromStatus: currentStatus,
            toStatus: nextStatus,
            actorId,
            at: now,
          }),
        ],
        $slice: -120,
      };
    }

    try {
      await payments.updateOne({ _id: payment._id }, update);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return json(
          { message: "Only one active payment is allowed per contract/milestone" },
          409,
          req
        );
      }
      throw error;
    }

    if (statusChanged && nextStatus === "withdrawn") {
      await recordWithdrawAttempt(users, payment.freelancerId, now);
    }

    const updated = await payments.findOne({ _id: payment._id });
    if (statusChanged && updated) {
      await appendEscrowLedgerEntry(ledger, {
        payment: updated,
        fromStatus: currentStatus,
        toStatus: nextStatus,
        action,
        reason,
        actorId,
        actorRole: normalizeId(auth.user.role),
        source: providerReconcile ? "provider_webhook" : "payments_api",
        idempotencyKey,
        eventId: providerEventId,
        at: now,
        provider: updated?.provider || providerNext,
      });
    }
    return json(cleanDoc(normalizePaymentForResponse(updated)), 200, req);
  } catch (error) {
    return json({ message: "Failed to update payment", error: error.message }, 500, req);
  }
}
