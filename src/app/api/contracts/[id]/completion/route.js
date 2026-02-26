import { getDb } from "../../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../../lib/api";
import {
  buildPaymentContractQuery,
  buildDefaultDisputeState,
  buildPaymentStatusHistoryEntry,
  canTransitionPaymentStatus,
  ensurePaymentIndexes,
  hasOpenDispute,
  isActivePaymentStatus,
  normalizeCanonicalContractId,
  normalizeId,
  normalizeMilestoneKey,
  normalizePaymentStatus,
} from "../../../../../lib/payments";
import {
  areAllMilestonesReleased,
  buildContractCompletionRequest,
  buildMilestoneSummary,
  ensureContractMilestones,
  normalizeCompletionRequest,
  pickMilestoneForAction,
} from "../../../../../lib/contractMilestones";

export const dynamic = "force-dynamic";

function normalizeContractQuery(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { contractId: id }] };
  return { $or: [{ _id: id }, { contractId: id }] };
}

function normalizeText(value, maxLen = 500) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.slice(0, maxLen);
}

function normalizeUrl(value) {
  const raw = normalizeText(value, 1000);
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : "";
}

function normalizeAttachment(input) {
  if (!input || typeof input !== "object") return null;

  const name = normalizeText(input.name, 200);
  const type = normalizeText(input.type, 100);
  const dataUrl = normalizeText(input.dataUrl, 2_500_000);
  const size = Number(input.size || 0);

  if (!name || !dataUrl) return null;
  if (!Number.isFinite(size) || size <= 0 || size > 2_000_000) return null;
  if (!/^data:/i.test(dataUrl)) return null;

  return { name, type, size, dataUrl };
}

function buildDefaultMilestonePaymentQuery(contract, milestoneKey = "default") {
  const canonicalId = normalizeCanonicalContractId(contract);
  const altId = normalizeId(contract.contractId);
  const candidates = [canonicalId, altId]
    .map((value) => buildPaymentContractQuery(value, milestoneKey))
    .filter(Boolean);

  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  return { $or: candidates };
}

async function upsertMilestonePayment({
  payments,
  contract,
  milestone,
  toStatus,
  action,
  reason,
  actorId,
  now,
}) {
  const milestoneKey = normalizeMilestoneKey(milestone?.key);
  const paymentQuery = buildDefaultMilestonePaymentQuery(contract, milestoneKey);
  if (!paymentQuery) return;

  const existingPayment = await payments.findOne(paymentQuery, {
    sort: { updatedAt: -1, createdAt: -1 },
  });

  const amount = Number(milestone?.amount || 0);
  if (!existingPayment) {
    const clientId = resolveContractClientId(contract);
    const freelancerId = normalizeId(contract.freelancerId);
    if (!clientId || !freelancerId || !Number.isFinite(amount) || amount <= 0) return;

    const canonicalId = normalizeCanonicalContractId(contract, normalizeId(contract.contractId));
    await payments.insertOne({
      contractId: canonicalId,
      milestoneKey,
      clientId,
      freelancerId,
      amount,
      status: toStatus,
      isActive: isActivePaymentStatus(toStatus),
      note: reason,
      dispute: buildDefaultDisputeState(),
      statusHistory: [
        buildPaymentStatusHistoryEntry({
          action,
          fromStatus: "",
          toStatus,
          reason,
          actorId,
          at: now,
        }),
      ],
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  const paymentStatus = normalizePaymentStatus(existingPayment.status, "");
  if (!paymentStatus) return;
  if (hasOpenDispute(existingPayment)) return;
  if (!canTransitionPaymentStatus(paymentStatus, toStatus)) return;

  await payments.updateOne(
    { _id: existingPayment._id },
    {
      $set: {
        status: toStatus,
        milestoneKey,
        amount: Number.isFinite(amount) && amount > 0 ? amount : Number(existingPayment.amount || 0),
        isActive: isActivePaymentStatus(toStatus),
        updatedAt: now,
      },
      $push: {
        statusHistory: {
          $each: [
            buildPaymentStatusHistoryEntry({
              action,
              fromStatus: paymentStatus,
              toStatus,
              reason,
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

function resolveContractClientId(contract) {
  return (
    normalizeId(contract.clientId) ||
    normalizeId(contract.userId) ||
    normalizeId(contract.ownerId) ||
    normalizeId(contract.createdBy)
  );
}

function canClientDecide(authUser, contract) {
  if (authUser.role === "Admin") return true;

  const userId = String(authUser.id || "").trim();
  if (!userId) return false;

  const clientIds = [contract.clientId, contract.userId, contract.ownerId, contract.createdBy]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  return authUser.role === "Client" && clientIds.includes(userId);
}

function canFreelancerSubmit(authUser, contract) {
  if (authUser.role === "Admin") return true;

  const userId = String(authUser.id || "").trim();
  const freelancerId = String(contract.freelancerId || "").trim();
  if (!userId || !freelancerId) return false;

  return authUser.role === "Freelancer" && userId === freelancerId;
}

function normalizeJobIdVariants(contract) {
  const stringIds = Array.from(
    new Set(
      [contract?.jobId]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );

  const objectIds = stringIds.map((value) => toObjectId(value)).filter(Boolean);
  return [...stringIds, ...objectIds];
}

async function syncJobStatusForContract(db, contract, status, now) {
  const nextStatus = String(status || "").trim().toLowerCase();
  if (!["in_progress", "completed", "cancelled"].includes(nextStatus)) return;

  const idVariants = normalizeJobIdVariants(contract);
  if (!idVariants.length) return;

  const jobs = db.collection(process.env.JOB_COLLECTION || "Job");
  await jobs.updateMany(
    {
      $or: [{ _id: { $in: idVariants } }, { jobId: { $in: idVariants } }],
    },
    { $set: { status: nextStatus, updatedAt: now } }
  );
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
    const action = String(payload.action || "").trim().toLowerCase();
    if (!["submit", "accept", "reject"].includes(action)) {
      return json({ message: "Invalid action. Use submit, accept, or reject." }, 400, req);
    }

    const db = await getDb();
    const contracts = db.collection("contracts");
    const contract = await contracts.findOne(query);
    if (!contract) return json({ message: "Contract not found" }, 404, req);

    const now = new Date();
    const authId = normalizeId(auth.user.id);
    const requestedMilestoneKey = normalizeMilestoneKey(
      payload.milestoneKey || payload.milestoneId
    );
    const milestones = ensureContractMilestones(contract);
    const selected = pickMilestoneForAction(milestones, action, requestedMilestoneKey);

    if (!selected?.milestone) {
      if (requestedMilestoneKey) {
        return json({ message: `Milestone not found: ${requestedMilestoneKey}` }, 404, req);
      }
      return json({ message: "No actionable milestone found for this action" }, 400, req);
    }

    const milestoneKey = normalizeMilestoneKey(selected.key);
    const currentMilestone = selected.milestone;
    const currentRequest = normalizeCompletionRequest(currentMilestone.completionRequest || {});
    const contractUpdate = {};
    let nextMilestone = { ...currentMilestone };
    let nextContractStatus = String(contract.status || "active").toLowerCase();

    if (action === "submit") {
      if (!canFreelancerSubmit(auth.user, contract)) {
        return json({ message: "Only assigned freelancer can submit completion work" }, 403, req);
      }

      if (String(contract.status || "").toLowerCase() === "cancelled") {
        return json({ message: "Cannot submit work for cancelled contract" }, 400, req);
      }

      const link = normalizeUrl(payload.deliveryLink);
      const notes = normalizeText(payload.deliveryNotes, 1500);
      const attachment = normalizeAttachment(payload.deliveryAttachment);

      if (!link && !attachment) {
        return json({ message: "Attach at least one delivery link or file" }, 400, req);
      }
      const payments = db.collection("payments");
      await ensurePaymentIndexes(payments);

      if (currentRequest.status === "pending") {
        return json({ message: "This milestone already has a pending submission" }, 409, req);
      }

      if (currentMilestone.status === "released" || currentMilestone.status === "cancelled") {
        return json({ message: "Cannot submit work for released/cancelled milestone" }, 409, req);
      }

      if (currentRequest.status === "rejected" && !notes) {
        return json(
          { message: "Revision notes are required when resubmitting rejected milestone work" },
          400,
          req
        );
      }

      nextMilestone = {
        ...currentMilestone,
        status: "in_review",
        completionRequest: {
          status: "pending",
          link: link || "",
          notes: notes || "",
          attachment: attachment || null,
          submittedAt: now,
          submittedBy: authId,
          decisionAt: null,
          decidedBy: "",
          clientFeedback: "",
        },
      };

      await upsertMilestonePayment({
        payments,
        contract,
        milestone: nextMilestone,
        toStatus: "in_review",
        action: "contract_submit",
        reason: "Freelancer submitted milestone work for review",
        actorId: authId,
        now,
      });

      nextContractStatus = "active";
      await syncJobStatusForContract(db, contract, "in_progress", now);
    }

    if (action === "accept") {
      if (!canClientDecide(auth.user, contract)) {
        return json({ message: "Only client can accept completion work" }, 403, req);
      }

      if (String(contract.status || "").toLowerCase() === "cancelled") {
        return json({ message: "Cannot accept milestone for cancelled contract" }, 400, req);
      }

      if (currentRequest.status !== "pending") {
        return json({ message: "No pending completion request to accept for this milestone" }, 400, req);
      }

      const payments = db.collection("payments");
      await ensurePaymentIndexes(payments);

      nextMilestone = {
        ...currentMilestone,
        status: "released",
        completionRequest: {
          ...currentRequest,
          status: "accepted",
          decisionAt: now,
          decidedBy: authId,
          clientFeedback: normalizeText(payload.feedback, 1500),
        },
      };

      await upsertMilestonePayment({
        payments,
        contract,
        milestone: nextMilestone,
        toStatus: "released",
        action: "contract_accept",
        reason: "Client accepted milestone completion request",
        actorId: authId,
        now,
      });
    }

    if (action === "reject") {
      if (!canClientDecide(auth.user, contract)) {
        return json({ message: "Only client can reject completion work" }, 403, req);
      }

      if (String(contract.status || "").toLowerCase() === "cancelled") {
        return json({ message: "Cannot reject milestone for cancelled contract" }, 400, req);
      }

      if (currentRequest.status !== "pending") {
        return json({ message: "No pending completion request to reject for this milestone" }, 400, req);
      }

      const payments = db.collection("payments");
      await ensurePaymentIndexes(payments);

      nextMilestone = {
        ...currentMilestone,
        status: "pending",
        completionRequest: {
          ...currentRequest,
          status: "rejected",
          decisionAt: now,
          decidedBy: authId,
          clientFeedback: normalizeText(payload.feedback, 1500),
        },
      };

      await upsertMilestonePayment({
        payments,
        contract,
        milestone: nextMilestone,
        toStatus: "reserved",
        action: "contract_reject",
        reason: "Client rejected milestone completion request",
        actorId: authId,
        now,
      });

      nextContractStatus = "active";
      await syncJobStatusForContract(db, contract, "in_progress", now);
    }

    const nextMilestones = milestones.map((item, index) => {
      if (index !== selected.index) return item;
      return nextMilestone;
    });

    const allReleased = areAllMilestonesReleased(nextMilestones);
    if (action === "accept") {
      nextContractStatus = allReleased ? "completed" : "active";
      await syncJobStatusForContract(db, contract, allReleased ? "completed" : "in_progress", now);
    }

    contractUpdate.status =
      String(contract.status || "").toLowerCase() === "cancelled" ? "cancelled" : nextContractStatus;
    contractUpdate.milestones = nextMilestones;
    contractUpdate.milestoneSummary = buildMilestoneSummary(nextMilestones);
    contractUpdate.completionRequest = buildContractCompletionRequest(nextMilestones, milestoneKey);
    contractUpdate.updatedAt = now;
    if (contractUpdate.status === "completed") {
      contractUpdate.endDate = contract.endDate || now;
    }

    await contracts.updateOne({ _id: contract._id }, { $set: contractUpdate });

    const updated = await contracts.findOne({ _id: contract._id });
    return json(cleanDoc(updated), 200, req);
  } catch (error) {
    return json({ message: "Failed to process completion request", error: error.message }, 500, req);
  }
}
