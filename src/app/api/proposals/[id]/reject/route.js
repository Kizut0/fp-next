import { getDb } from "../../../../../lib/mongodb";
import { json, options, requireAuth, toObjectId } from "../../../../../lib/api";

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

function normalizeJobQuery(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { jobId: id }] };
  return { $or: [{ _id: id }, { jobId: id }] };
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
    if (currentStatus === "rejected") {
      return json({ ok: true }, 200, req);
    }

    if (currentStatus !== "submitted") {
      return json({ message: "Only submitted proposals can be rejected" }, 400, req);
    }

    await proposals.updateOne(
      { _id: proposal._id },
      { $set: { status: "rejected", updatedAt: new Date() } }
    );

    return json({ ok: true }, 200, req);
  } catch (error) {
    return json({ message: "Failed to reject proposal", error: error.message }, 500, req);
  }
}
