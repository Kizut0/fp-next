import { getDb } from "../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../lib/api";
import {
  areAllMilestonesReleased,
  buildContractCompletionRequest,
  buildMilestoneSummary,
  ensureContractMilestones,
  normalizeMilestonesForContract,
} from "../../../../lib/contractMilestones";

export const dynamic = "force-dynamic";

const STATUSES = ["active", "completed", "cancelled"];
const NON_DELETABLE_CONTRACT_STATUSES = new Set(["accepted", "active", "completed"]);

function normalizeStatus(value, fallback = "active") {
  const raw = String(value || fallback).trim().toLowerCase();
  return STATUSES.includes(raw) ? raw : fallback;
}

function isDeleteRestrictedContract(contract) {
  const status = String(contract?.status || "").trim().toLowerCase();
  return NON_DELETABLE_CONTRACT_STATUSES.has(status);
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeContractQuery(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { contractId: id }] };
  return { $or: [{ _id: id }, { contractId: id }] };
}

function canAccessContract(authUser, contract) {
  if (authUser.role === "Admin") return true;

  const userId = String(authUser.id || "").trim();
  if (!userId) return false;

  const ownerIds = [contract.clientId, contract.userId, contract.ownerId, contract.createdBy, contract.freelancerId]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  return ownerIds.includes(userId);
}

function canMutateContract(authUser, contract) {
  if (authUser.role === "Admin") return true;

  const userId = String(authUser.id || "").trim();
  if (!userId) return false;

  const clientIds = [contract.clientId, contract.userId, contract.ownerId, contract.createdBy]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  return clientIds.includes(userId);
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

function mapContractStatusToJobStatus(contractStatus) {
  const status = normalizeStatus(contractStatus, "active");
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "in_progress";
}

async function syncJobStatusForContract(db, contract, contractStatus) {
  const jobStatus = mapContractStatusToJobStatus(contractStatus);
  const idVariants = normalizeJobIdVariants(contract);
  if (!idVariants.length) return;

  const jobs = db.collection(process.env.JOB_COLLECTION || "Job");
  await jobs.updateMany(
    {
      $or: [{ _id: { $in: idVariants } }, { jobId: { $in: idVariants } }],
    },
    { $set: { status: jobStatus, updatedAt: new Date() } }
  );
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
    const query = normalizeContractQuery(rawId);
    if (!query) return json({ message: "Invalid contract id" }, 400, req);

    const db = await getDb();
    const contract = await db.collection("contracts").findOne(query);
    if (!contract) return json({ message: "Contract not found" }, 404, req);

    if (!canAccessContract(auth.user, contract)) {
      return json({ message: "Forbidden" }, 403, req);
    }

    return json(cleanDoc(normalizeContractForResponse(contract)), 200, req);
  } catch (error) {
    return json({ message: "Failed to load contract", error: error.message }, 500, req);
  }
}

export async function PUT(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const rawId = await getParamId(params);
    const query = normalizeContractQuery(rawId);
    if (!query) return json({ message: "Invalid contract id" }, 400, req);

    const db = await getDb();
    const contracts = db.collection("contracts");
    const contract = await contracts.findOne(query);
    if (!contract) return json({ message: "Contract not found" }, 404, req);

    if (!canMutateContract(auth.user, contract)) {
      return json({ message: "Forbidden" }, 403, req);
    }

    const payload = await req.json();

    let amount = payload.amount !== undefined ? Number(payload.amount) : Number(contract.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ message: "Amount must be greater than 0" }, 400, req);
    }

    const currentAmount = Number(contract.amount || 0);
    const isProposalLinked = Boolean(contract.proposalId);
    if (
      isProposalLinked &&
      payload.amount !== undefined &&
      Number.isFinite(currentAmount) &&
      amount !== currentAmount
    ) {
      return json(
        {
          message: "Contract amount is fixed from the accepted proposal and cannot be changed",
        },
        400,
        req
      );
    }

    const nextStatus = payload.status !== undefined ? normalizeStatus(payload.status, contract.status) : contract.status;
    const currentMilestones = ensureContractMilestones(contract);
    let nextMilestones = currentMilestones;

    if (payload.milestones !== undefined) {
      const normalizedMilestones = normalizeMilestonesForContract(payload.milestones, {
        totalAmount: amount,
        strictTotal: true,
        legacyStatus: nextStatus,
        defaultTitle:
          payload.jobTitle !== undefined
            ? String(payload.jobTitle || "Project Delivery").trim()
            : String(contract.jobTitle || "Project Delivery").trim(),
      });

      if (normalizedMilestones.error) {
        return json({ message: normalizedMilestones.error }, 400, req);
      }

      nextMilestones = normalizedMilestones.milestones;
      amount = normalizedMilestones.totalAmount;
    } else if (payload.amount !== undefined) {
      if (currentMilestones.length > 1) {
        return json(
          { message: "For multi-milestone contracts, update milestones when changing amount" },
          400,
          req
        );
      }

      nextMilestones = currentMilestones.map((item, index) => {
        if (index !== 0) return item;
        return { ...item, amount };
      });
    }

    if (nextStatus === "completed" && !areAllMilestonesReleased(nextMilestones)) {
      return json(
        { message: "All milestones must be released before marking contract completed" },
        400,
        req
      );
    }

    const startDate =
      payload.startDate !== undefined
        ? toDateOrNull(payload.startDate)
        : toDateOrNull(contract.startDate);

    const endDate =
      payload.endDate !== undefined
        ? toDateOrNull(payload.endDate)
        : toDateOrNull(contract.endDate);

    const update = {
      amount,
      status: nextStatus,
      milestones: nextMilestones,
      milestoneSummary: buildMilestoneSummary(nextMilestones),
      completionRequest: buildContractCompletionRequest(nextMilestones),
      jobTitle:
        payload.jobTitle !== undefined
          ? String(payload.jobTitle || "Untitled Project").trim()
          : String(contract.jobTitle || "Untitled Project"),
      updatedAt: new Date(),
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
    };

    if (nextStatus === "completed" && !update.endDate) {
      update.endDate = new Date();
    }

    await contracts.updateOne({ _id: contract._id }, { $set: update });
    await syncJobStatusForContract(db, contract, nextStatus);

    const updated = await contracts.findOne({ _id: contract._id });
    return json(cleanDoc(normalizeContractForResponse(updated)), 200, req);
  } catch (error) {
    return json({ message: "Failed to update contract", error: error.message }, 500, req);
  }
}

export async function DELETE(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const rawId = await getParamId(params);
    const query = normalizeContractQuery(rawId);
    if (!query) return json({ message: "Invalid contract id" }, 400, req);

    const db = await getDb();
    const contracts = db.collection("contracts");
    const contract = await contracts.findOne(query);
    if (!contract) return json({ message: "Contract not found" }, 404, req);

    if (auth.user.role !== "Admin") {
      return json({ message: "Only admin can delete contracts" }, 403, req);
    }
    if (isDeleteRestrictedContract(contract)) {
      return json(
        { message: "Accepted, active, or completed contracts cannot be deleted. Use archive/cancel policy." },
        409,
        req
      );
    }

    await contracts.deleteOne({ _id: contract._id });
    return json({ ok: true }, 200, req);
  } catch (error) {
    return json({ message: "Failed to delete contract", error: error.message }, 500, req);
  }
}
