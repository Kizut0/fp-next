import { getDb } from "../../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../../lib/api";

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
      return json({ ok: true, contract: cleanDoc(existing) }, 200, req);
    }

    if (currentStatus !== "submitted") {
      return json({ message: "Only submitted proposals can be accepted" }, 400, req);
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
      await jobs.updateOne(jobQuery, { $set: { status: "closed", updatedAt: now } });
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
        amount: Number(proposal.price || 0),
        status: "active",
        startDate: now,
        createdAt: now,
        updatedAt: now,
      };

      const inserted = await contracts.insertOne(contractDoc);
      contract = { ...contractDoc, _id: inserted.insertedId };
    }

    return json({ ok: true, contract: cleanDoc(contract) }, 200, req);
  } catch (error) {
    return json({ message: "Failed to accept proposal", error: error.message }, 500, req);
  }
}
