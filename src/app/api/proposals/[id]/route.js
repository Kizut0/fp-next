import { getDb } from "../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../lib/api";

export const dynamic = "force-dynamic";

const ALLOWED_STATUSES = ["submitted", "accepted", "rejected", "withdrawn"];

function normalizeStatus(value) {
  const raw = String(value || "submitted").trim().toLowerCase();
  return ALLOWED_STATUSES.includes(raw) ? raw : "submitted";
}

function normalizeQueryId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const _id = toObjectId(raw);
  if (_id) return { $or: [{ _id }, { _id: raw }, { proposalId: raw }] };
  return { $or: [{ _id: raw }, { proposalId: raw }] };
}

function resolveParticipantIds(proposal = {}) {
  return [proposal.freelancerId, proposal.clientId, proposal.userId, proposal.ownerId, proposal.createdBy]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
}

function canAccessProposal(authUser, proposal) {
  if (authUser.role === "Admin") return true;

  const userId = String(authUser.id || "").trim();
  if (!userId) return false;

  return resolveParticipantIds(proposal).includes(userId);
}

function canEditProposal(authUser, proposal) {
  if (authUser.role === "Admin") return true;

  const userId = String(authUser.id || "").trim();
  if (!userId) return false;

  return String(proposal.freelancerId || "").trim() === userId;
}

async function decrementJobProposalCount(jobs, proposal, now = new Date()) {
  if (!proposal?.jobId) return;

  const rawJobId = String(proposal.jobId || "").trim();
  if (!rawJobId) return;

  const objectJobId = toObjectId(rawJobId);
  const jobLookup = objectJobId
    ? { $or: [{ _id: objectJobId }, { _id: rawJobId }, { jobId: rawJobId }] }
    : { $or: [{ _id: rawJobId }, { jobId: rawJobId }] };

  const job = await jobs.findOne(jobLookup);
  if (!job) return;

  const current = Number(job.proposalsCount || 0);
  const next = current > 0 ? current - 1 : 0;
  await jobs.updateOne({ _id: job._id }, { $set: { proposalsCount: next, updatedAt: now } });
}

function resolveUserQuery(rawUserId) {
  const userId = String(rawUserId || "").trim();
  if (!userId) return null;

  const objectId = toObjectId(userId);
  if (objectId) {
    return { $or: [{ _id: objectId }, { _id: userId }, { userId }] };
  }

  return { $or: [{ _id: userId }, { userId }] };
}

async function getParamId(params) {
  const resolved = await params;
  return String(resolved?.id || "").trim();
}

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const rawId = await getParamId(params);
    const query = normalizeQueryId(rawId);
    if (!query) return json({ message: "Invalid proposal id" }, 400, req);

    const db = await getDb();
    const proposal = await db.collection("proposals").findOne(query);
    if (!proposal) return json({ message: "Proposal not found" }, 404, req);

    if (!canAccessProposal(auth.user, proposal)) {
      return json({ message: "Forbidden" }, 403, req);
    }

    return json(cleanDoc(proposal), 200, req);
  } catch (error) {
    return json({ message: "Failed to load proposal", error: error.message }, 500, req);
  }
}

export async function PUT(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const rawId = await getParamId(params);
    const query = normalizeQueryId(rawId);
    if (!query) return json({ message: "Invalid proposal id" }, 400, req);

    const db = await getDb();
    const proposals = db.collection("proposals");
    const proposal = await proposals.findOne(query);
    if (!proposal) return json({ message: "Proposal not found" }, 404, req);

    if (!canEditProposal(auth.user, proposal)) {
      return json({ message: "Only proposal owner can edit" }, 403, req);
    }

    const payload = await req.json();

    if (auth.user.role !== "Admin" && String(proposal.status || "").toLowerCase() !== "submitted") {
      return json({ message: "Only submitted proposals can be edited" }, 400, req);
    }

    const price = payload.price !== undefined ? Number(payload.price) : Number(proposal.price || 0);
    const message =
      payload.message !== undefined ? String(payload.message || "").trim() : String(proposal.message || "").trim();

    if (!Number.isFinite(price) || price <= 0) {
      return json({ message: "Price must be greater than 0" }, 400, req);
    }

    if (message.length < 20) {
      return json({ message: "Message must be at least 20 characters" }, 400, req);
    }

    const update = {
      price,
      message,
      updatedAt: new Date(),
    };

    if (auth.user.role === "Admin" && payload.status !== undefined) {
      update.status = normalizeStatus(payload.status);
    }

    await proposals.updateOne({ _id: proposal._id }, { $set: update });
    const updated = await proposals.findOne({ _id: proposal._id });
    return json(cleanDoc(updated), 200, req);
  } catch (error) {
    return json({ message: "Failed to update proposal", error: error.message }, 500, req);
  }
}

export async function DELETE(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const rawId = await getParamId(params);
    const query = normalizeQueryId(rawId);
    if (!query) return json({ message: "Invalid proposal id" }, 400, req);

    const db = await getDb();
    const proposals = db.collection("proposals");
    const jobs = db.collection(process.env.JOB_COLLECTION || "Job");
    const users = db.collection(process.env.USER_COLLECTION || "userData");

    const proposal = await proposals.findOne(query);
    if (!proposal) return json({ message: "Proposal not found" }, 404, req);

    const authUserId = String(auth.user.id || "").trim();
    const proposalFreelancerId = String(proposal.freelancerId || "").trim();
    const isAdmin = auth.user.role === "Admin";
    const isFreelancerOwner =
      auth.user.role === "Freelancer" &&
      Boolean(authUserId) &&
      authUserId === proposalFreelancerId;

    if (!isAdmin && !isFreelancerOwner) {
      return json({ message: "Forbidden" }, 403, req);
    }

    if (isAdmin) {
      await proposals.deleteOne({ _id: proposal._id });
      await decrementJobProposalCount(jobs, proposal, new Date());
      return json({ ok: true, deleted: true }, 200, req);
    }

    const currentStatus = String(proposal.status || "submitted").trim().toLowerCase();
    if (currentStatus !== "submitted") {
      return json({ message: "Only submitted proposals can be withdrawn" }, 400, req);
    }

    const now = new Date();
    await proposals.updateOne(
      { _id: proposal._id },
      { $set: { status: "withdrawn", updatedAt: now } }
    );
    await decrementJobProposalCount(jobs, proposal, now);

    let withdrawCount = 0;
    let deactivated = false;

    const userQuery = resolveUserQuery(proposalFreelancerId);
    if (userQuery) {
      await users.updateOne(userQuery, { $inc: { withdrawCount: 1 }, $set: { updatedAt: now } });

      const user = await users.findOne(userQuery, {
        projection: { withdrawCount: 1, status: 1 },
      });

      withdrawCount = Number(user?.withdrawCount || 0);
      const status = String(user?.status || "active").trim().toLowerCase();

      if (withdrawCount >= 10 && status !== "deactive") {
        await users.updateOne(userQuery, { $set: { status: "deactive", updatedAt: now } });
        deactivated = true;
      }
    }

    return json(
      {
        ok: true,
        withdrawn: true,
        withdrawCount,
        deactivated,
      },
      200,
      req
    );
  } catch (error) {
    return json({ message: "Failed to delete proposal", error: error.message }, 500, req);
  }
}
