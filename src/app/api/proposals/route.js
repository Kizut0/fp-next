import { getDb } from "../../../lib/mongodb";
import { cleanDoc, cleanDocs, json, options, requireAuth, toObjectId } from "../../../lib/api";

export const dynamic = "force-dynamic";

const MUTABLE_STATUSES = ["submitted", "accepted", "rejected", "withdrawn"];

function normalizeStatus(value) {
  const raw = String(value || "submitted").trim().toLowerCase();
  return MUTABLE_STATUSES.includes(raw) ? raw : "submitted";
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (role === "freelance") return "freelancer";
  return role;
}

function canSubmitProposals(role) {
  const normalized = normalizeRole(role);
  return normalized === "freelancer" || normalized === "admin";
}

async function resolveCurrentRoleFromDb(db, userId) {
  const id = String(userId || "").trim();
  if (!id) return "";

  const users = db.collection(process.env.USER_COLLECTION || "userData");
  const objectId = toObjectId(id);
  const query = objectId ? { _id: objectId } : { _id: id };
  const user = await users.findOne(query, { projection: { role: 1 } });
  return String(user?.role || "").trim();
}

function buildMineOwnerMatch(user) {
  const ownerId = String(user?.id || "").trim();
  if (!ownerId) return null;

  const ownerObjectId = toObjectId(ownerId);
  const clauses = [{ clientId: ownerId }, { userId: ownerId }, { ownerId: ownerId }, { createdBy: ownerId }];

  if (ownerObjectId) {
    clauses.push(
      { clientId: ownerObjectId },
      { userId: ownerObjectId },
      { ownerId: ownerObjectId },
      { createdBy: ownerObjectId }
    );
  }

  return clauses;
}

function resolveJobLookup(jobId) {
  const raw = String(jobId || "").trim();
  if (!raw) return null;

  const jobObjectId = toObjectId(raw);
  if (jobObjectId) {
    return { $or: [{ _id: jobObjectId }, { _id: raw }, { jobId: raw }] };
  }

  return { $or: [{ _id: raw }, { jobId: raw }] };
}

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { searchParams } = new URL(req.url);
    const jobId = String(searchParams.get("jobId") || "").trim();
    const mine = String(searchParams.get("mine") || "").trim().toLowerCase();
    const status = String(searchParams.get("status") || "").trim().toLowerCase();

    const query = {};

    if (jobId) {
      const jobObjectId = toObjectId(jobId);
      query.jobId = jobObjectId || jobId;
    }

    if (status && status !== "all") {
      query.status = normalizeStatus(status);
    }

    if (mine === "freelancer" || auth.user.role === "Freelancer") {
      query.freelancerId = String(auth.user.id || "").trim();
    }

    if (mine === "client" || auth.user.role === "Client") {
      const ownerMatch = buildMineOwnerMatch(auth.user);
      if (ownerMatch) query.$or = ownerMatch;
      else query.clientId = String(auth.user.id || "").trim();
    }

    const db = await getDb();
    const items = await db.collection("proposals").find(query).sort({ createdAt: -1 }).toArray();
    return json(cleanDocs(items), 200, req);
  } catch (error) {
    return json({ message: "Failed to load proposals", error: error.message }, 500, req);
  }
}

export async function POST(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const db = await getDb();
    const tokenRole = String(auth.user.role || "").trim();
    const dbRole = await resolveCurrentRoleFromDb(db, auth.user.id);
    const effectiveRole = canSubmitProposals(tokenRole) ? tokenRole : dbRole;

    if (!canSubmitProposals(effectiveRole)) {
      return json(
        {
          message: "Only freelancers can submit proposals",
          role: tokenRole || "",
          dbRole: dbRole || "",
        },
        403,
        req
      );
    }

    const payload = await req.json();
    const jobId = String(payload.jobId || "").trim();
    const price = Number(payload.price || 0);
    const message = String(payload.message || "").trim();

    if (!jobId) return json({ message: "jobId is required" }, 400, req);
    if (!Number.isFinite(price) || price <= 0) return json({ message: "Price must be greater than 0" }, 400, req);
    if (message.length < 20) return json({ message: "Message must be at least 20 characters" }, 400, req);

    const jobs = db.collection(process.env.JOB_COLLECTION || "Job");
    const proposals = db.collection("proposals");

    const jobQuery = resolveJobLookup(jobId);
    if (!jobQuery) return json({ message: "Invalid job id" }, 400, req);

    const job = await jobs.findOne(jobQuery);
    if (!job) return json({ message: "Job not found" }, 404, req);
    if (String(job.status || "open").toLowerCase() !== "open") {
      return json({ message: "This job is not accepting proposals" }, 400, req);
    }

    const proposalJobId = job._id || job.jobId;
    const freelancerId = String(auth.user.id || "").trim();

    const existing = await proposals.findOne({
      jobId: proposalJobId,
      freelancerId,
      status: { $in: ["submitted", "accepted"] },
    });

    if (existing) {
      return json({ message: "You already have an active proposal for this job" }, 409, req);
    }

    const now = new Date();
    const clientId = String(job.clientId || job.userId || job.ownerId || job.createdBy || "").trim();

    const doc = {
      jobId: proposalJobId,
      jobTitle: String(job.title || "Untitled Project"),
      clientId,
      freelancerId,
      price,
      message,
      status: "submitted",
      createdAt: now,
      updatedAt: now,
    };

    const result = await proposals.insertOne(doc);

    await jobs.updateOne(
      { _id: job._id },
      { $inc: { proposalsCount: 1 }, $set: { updatedAt: now } }
    );

    return json(cleanDoc({ ...doc, _id: result.insertedId }), 201, req);
  } catch (error) {
    return json({ message: "Failed to submit proposal", error: error.message }, 500, req);
  }
}
