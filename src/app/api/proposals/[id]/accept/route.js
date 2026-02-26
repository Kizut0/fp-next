import { getDb } from "../../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../../lib/api";
import {
  buildContractCompletionRequest,
  buildMilestoneSummary,
  ensureContractMilestones,
  normalizeMilestonesForContract,
} from "../../../../../lib/contractMilestones";

export const dynamic = "force-dynamic";

function normalizeProposalQuery(rawId) {
  const _id = toObjectId(rawId);
  if (_id) return { $or: [{ _id }, { _id: rawId }, { proposalId: rawId }] };
  return { $or: [{ _id: rawId }, { proposalId: rawId }] };
}

function getOwnerIds(item = {}) {
  return [item.clientId, item.userId, item.ownerId, item.createdBy]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
}

function ownsProposal(authUser, proposal) {
  if (authUser.role === "Admin") return true;
  const userId = String(authUser.id || "").trim();
  if (!userId) return false;
  return getOwnerIds(proposal).includes(userId);
}

function ownsJobByClientKeys(authUser, job) {
  if (authUser.role === "Admin") return true;
  const userId = String(authUser.id || "").trim();
  if (!userId) return false;

  const ownerIds = [job?.clientId, job?.userId, job?.ownerId, job?.createdBy]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  return ownerIds.includes(userId);
}

function normalizeJobQuery(jobId) {
  if (!jobId) return null;
  const raw = String(jobId || "").trim();
  if (!raw) return null;

  const _id = toObjectId(raw);
  if (_id) return { $or: [{ _id }, { _id: raw }, { jobId: raw }] };
  return { $or: [{ _id: raw }, { jobId: raw }] };
}

function normalizeBudget(value) {
  const budget = Number(value);
  return Number.isFinite(budget) && budget > 0 ? budget : 0;
}

function sameId(a, b) {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  return Boolean(left && right && left === right);
}

function getReservedAmount(proposal = {}) {
  const reserved = Number(proposal.reservedAmount);
  if (Number.isFinite(reserved) && reserved > 0) return reserved;

  const price = Number(proposal.price);
  return Number.isFinite(price) && price > 0 ? price : 0;
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
  };
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
    if (!rawId) return json({ message: "Invalid proposal id" }, 400, req);

    let payload = {};
    try {
      payload = await req.json();
    } catch {
      payload = {};
    }

    const db = await getDb();
    const proposals = db.collection("proposals");
    const jobs = db.collection(process.env.JOB_COLLECTION || "Job");
    const contracts = db.collection("contracts");

    const proposal = await proposals.findOne(normalizeProposalQuery(rawId));

    if (!proposal) return json({ message: "Proposal not found" }, 404, req);

    let canManage = ownsProposal(auth.user, proposal);
    const jobQuery = normalizeJobQuery(proposal.jobId);

    if (!canManage && jobQuery) {
      const job = await jobs.findOne(jobQuery);
      canManage = ownsJobByClientKeys(auth.user, job);
    }

    if (!canManage) return json({ message: "Forbidden" }, 403, req);

    const currentStatus = String(proposal.status || "submitted").toLowerCase();
    if (currentStatus === "accepted") {
      const existing = await contracts.findOne({ proposalId: proposal._id });
      return json({ ok: true, contract: cleanDoc(normalizeContractForResponse(existing)) }, 200, req);
    }

    if (currentStatus !== "submitted") {
      return json({ message: "Only submitted proposals can be accepted" }, 400, req);
    }

    const job = jobQuery ? await jobs.findOne(jobQuery) : null;
    const proposalPrice = Number(proposal.price || 0);
    if (!Number.isFinite(proposalPrice) || proposalPrice <= 0) {
      return json({ message: "Invalid proposal amount" }, 400, req);
    }

    const milestoneResult = normalizeMilestonesForContract(
      payload.milestones || proposal.milestones,
      {
        totalAmount: proposalPrice,
        strictTotal: true,
        legacyStatus: "active",
        defaultTitle: proposal.jobTitle || "Project Delivery",
      }
    );
    if (milestoneResult.error) {
      return json({ message: milestoneResult.error }, 400, req);
    }

    const proposalReserved = getReservedAmount(proposal);
    const requiredExtra = Math.max(0, proposalPrice - proposalReserved);

    let otherSubmitted = [];
    if (job) {
      const jobBudget = normalizeBudget(job.budget);
      if (jobBudget > 0 && requiredExtra > jobBudget) {
        return json({ message: "Proposal price cannot exceed client job budget" }, 400, req);
      }

      const alreadyAccepted = String(job.acceptedProposalId || "").trim();
      if (alreadyAccepted && !sameId(alreadyAccepted, proposal._id)) {
        return json({ message: "Another proposal has already been accepted for this job" }, 409, req);
      }

      otherSubmitted = await proposals
        .find({
          _id: { $ne: proposal._id },
          jobId: proposal.jobId,
          status: "submitted",
        })
        .toArray();
    }

    const now = new Date();

    await proposals.updateOne(
      { _id: proposal._id },
      { $set: { status: "accepted", updatedAt: now } }
    );

    await proposals.updateMany(
      {
        _id: { $ne: proposal._id },
        jobId: proposal.jobId,
        status: "submitted",
      },
      { $set: { status: "rejected", updatedAt: now } }
    );

    if (jobQuery) {
      const sumOtherReserved = otherSubmitted.reduce((sum, item) => sum + getReservedAmount(item), 0);
      const currentBudget = normalizeBudget(job?.budget);
      const nextBudget = Math.max(0, currentBudget - requiredExtra + sumOtherReserved);
      const originalBudget = normalizeBudget(job?.budgetOriginal || job?.budget);
      await jobs.updateOne(jobQuery, {
        $set: {
          status: "in_progress",
          budget: nextBudget,
          budgetOriginal: originalBudget,
          acceptedProposalId: proposal._id,
          acceptedFreelancerId: proposal.freelancerId,
          acceptedAmount: proposalPrice,
          budgetReducedAt: now,
          updatedAt: now,
        },
      });
    }

    const existingContract = await contracts.findOne({ proposalId: proposal._id });
    let contract = existingContract;

    if (!existingContract) {
      const contractDoc = {
        proposalId: proposal._id,
        jobId: proposal.jobId,
        jobTitle: proposal.jobTitle || "Untitled Project",
        clientId: String(proposal.clientId || auth.user.id || "").trim(),
        freelancerId: proposal.freelancerId,
        amount: milestoneResult.totalAmount,
        milestones: milestoneResult.milestones,
        milestoneSummary: buildMilestoneSummary(milestoneResult.milestones),
        completionRequest: buildContractCompletionRequest(milestoneResult.milestones),
        status: "active",
        startDate: now,
        createdAt: now,
        updatedAt: now,
      };

      const inserted = await contracts.insertOne(contractDoc);
      contract = { ...contractDoc, _id: inserted.insertedId };
    }

    return json({ ok: true, contract: cleanDoc(normalizeContractForResponse(contract)) }, 200, req);
  } catch (error) {
    return json({ message: "Failed to accept proposal", error: error.message }, 500, req);
  }
}
