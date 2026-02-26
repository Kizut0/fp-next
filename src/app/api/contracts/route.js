import { getDb } from "../../../lib/mongodb";
import { cleanDoc, cleanDocs, json, options, requireAuth, toObjectId } from "../../../lib/api";

export const dynamic = "force-dynamic";

const STATUSES = ["active", "completed", "cancelled"];

function normalizeStatus(value, fallback = "active") {
  const raw = String(value || fallback).trim().toLowerCase();
  return STATUSES.includes(raw) ? raw : fallback;
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildClientOwnerQuery(ownerId) {
  const id = String(ownerId || "").trim();
  if (!id) return { clientId: "__no_owner__" };

  const objectId = toObjectId(id);
  const clauses = [{ clientId: id }, { userId: id }, { ownerId: id }, { createdBy: id }];

  if (objectId) {
    clauses.push(
      { clientId: objectId },
      { userId: objectId },
      { ownerId: objectId },
      { createdBy: objectId }
    );
  }

  return { $or: clauses };
}

function resolveProposalQuery(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { proposalId: id }] };
  return { $or: [{ _id: id }, { proposalId: id }] };
}

function resolveJobQuery(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { jobId: id }] };
  return { $or: [{ _id: id }, { jobId: id }] };
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

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { searchParams } = new URL(req.url);
    const status = String(searchParams.get("status") || "").trim().toLowerCase();
    const mine = String(searchParams.get("mine") || "").trim().toLowerCase();

    const query = {};
    if (status && status !== "all") query.status = normalizeStatus(status);

    if (mine === "client" || auth.user.role === "Client") {
      Object.assign(query, buildClientOwnerQuery(auth.user.id));
    }

    if (mine === "freelancer" || auth.user.role === "Freelancer") {
      query.freelancerId = String(auth.user.id || "").trim();
    }

    const db = await getDb();
    const items = await db.collection("contracts").find(query).sort({ createdAt: -1 }).toArray();
    return json(cleanDocs(items), 200, req);
  } catch (error) {
    return json({ message: "Failed to load contracts", error: error.message }, 500, req);
  }
}

export async function POST(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  if (!["Client", "Admin"].includes(auth.user.role)) {
    return json({ message: "Only clients/admins can create contracts" }, 403, req);
  }

  try {
    const payload = await req.json();
    const proposalId = String(payload.proposalId || "").trim();

    const db = await getDb();
    const contracts = db.collection("contracts");
    const proposals = db.collection("proposals");
    const jobs = db.collection(process.env.JOB_COLLECTION || "Job");

    if (proposalId) {
      const proposalQuery = resolveProposalQuery(proposalId);
      if (!proposalQuery) return json({ message: "Invalid proposal id" }, 400, req);

      const proposal = await proposals.findOne(proposalQuery);
      if (!proposal) return json({ message: "Proposal not found" }, 404, req);

      if (
        auth.user.role !== "Admin" &&
        String(proposal.clientId || "").trim() !== String(auth.user.id || "").trim()
      ) {
        return json({ message: "Forbidden" }, 403, req);
      }

      const existing = await contracts.findOne({ proposalId: proposal._id });
      if (existing) {
        return json({ message: "Contract already exists for this proposal", contract: cleanDoc(existing) }, 409, req);
      }

      const proposalAmount = Number(proposal.price || 0);
      if (!Number.isFinite(proposalAmount) || proposalAmount <= 0) {
        return json({ message: "Invalid proposal amount" }, 400, req);
      }
      const proposalReserved = getReservedAmount(proposal);
      const requiredExtra = Math.max(0, proposalAmount - proposalReserved);

      const now = new Date();
      const jobQuery = resolveJobQuery(proposal.jobId);
      if (jobQuery) {
        const job = await jobs.findOne(jobQuery);
        if (job) {
          const jobBudget = normalizeBudget(job.budget);
          if (jobBudget > 0 && requiredExtra > jobBudget) {
            return json({ message: "Proposal price cannot exceed client job budget" }, 400, req);
          }

          const alreadyAccepted = String(job.acceptedProposalId || "").trim();
          if (alreadyAccepted && !sameId(alreadyAccepted, proposal._id)) {
            return json({ message: "Another proposal has already been accepted for this job" }, 409, req);
          }

          const otherSubmitted = await proposals
            .find({
              _id: { $ne: proposal._id },
              jobId: proposal.jobId,
              status: "submitted",
            })
            .toArray();
          const sumOtherReserved = otherSubmitted.reduce((sum, item) => sum + getReservedAmount(item), 0);
          const nextBudget = Math.max(0, jobBudget - requiredExtra + sumOtherReserved);
          const originalBudget = normalizeBudget(job.budgetOriginal || job.budget);
          await jobs.updateOne(
            { _id: job._id },
            {
              $set: {
                status: "closed",
                budget: nextBudget,
                budgetOriginal: originalBudget,
                acceptedProposalId: proposal._id,
                acceptedFreelancerId: proposal.freelancerId,
                acceptedAmount: proposalAmount,
                budgetReducedAt: now,
                updatedAt: now,
              },
            }
          );
        }
      }

      const doc = {
        proposalId: proposal._id,
        jobId: proposal.jobId,
        jobTitle: proposal.jobTitle || "Untitled Project",
        clientId: String(proposal.clientId || auth.user.id || "").trim(),
        freelancerId: String(proposal.freelancerId || "").trim(),
        amount: proposalAmount,
        status: "active",
        startDate: now,
        createdAt: now,
        updatedAt: now,
      };

      const inserted = await contracts.insertOne(doc);
      await proposals.updateOne({ _id: proposal._id }, { $set: { status: "accepted", updatedAt: now } });
      await proposals.updateMany(
        {
          _id: { $ne: proposal._id },
          jobId: proposal.jobId,
          status: "submitted",
        },
        { $set: { status: "rejected", updatedAt: now } }
      );

      return json(cleanDoc({ ...doc, _id: inserted.insertedId }), 201, req);
    }

    const jobId = String(payload.jobId || "").trim();
    const freelancerId = String(payload.freelancerId || "").trim();
    const amount = Number(payload.amount || 0);

    if (!jobId) return json({ message: "jobId is required" }, 400, req);
    if (!freelancerId) return json({ message: "freelancerId is required" }, 400, req);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ message: "amount must be greater than 0" }, 400, req);
    }

    const startDate = toDateOrNull(payload.startDate) || new Date();
    const endDate = toDateOrNull(payload.endDate);

    const ownerId = auth.user.role === "Admin"
      ? String(payload.clientId || payload.userId || payload.ownerId || payload.createdBy || "").trim()
      : String(auth.user.id || "").trim();

    if (!ownerId) {
      return json({ message: "clientId is required" }, 400, req);
    }

    const now = new Date();
    const doc = {
      proposalId: null,
      jobId,
      jobTitle: String(payload.jobTitle || "Untitled Project").trim(),
      clientId: ownerId,
      freelancerId,
      amount,
      status: normalizeStatus(payload.status, "active"),
      startDate,
      ...(endDate ? { endDate } : {}),
      createdAt: now,
      updatedAt: now,
    };

    const inserted = await contracts.insertOne(doc);
    return json(cleanDoc({ ...doc, _id: inserted.insertedId }), 201, req);
  } catch (error) {
    return json({ message: "Failed to create contract", error: error.message }, 500, req);
  }
}
