import { getDb } from "../../../lib/mongodb";
import { cleanDoc, cleanDocs, json, options, requireAuth, toObjectId } from "../../../lib/api";

export const dynamic = "force-dynamic";

const ALLOWED_STATUSES = new Set(["paid", "pending", "failed"]);

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeContractQuery(rawId) {
  const id = normalizeId(rawId);
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { contractId: id }] };
  return { $or: [{ _id: id }, { contractId: id }] };
}

function normalizeStatus(value) {
  const status = String(value || "paid").trim().toLowerCase();
  return ALLOWED_STATUSES.has(status) ? status : "";
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

function resolveContractClientId(contract) {
  return (
    normalizeId(contract.clientId) ||
    normalizeId(contract.userId) ||
    normalizeId(contract.ownerId) ||
    normalizeId(contract.createdBy)
  );
}

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const query = {};
    if (auth.user.role === "Client") query.clientId = auth.user.id;
    if (auth.user.role === "Freelancer") query.freelancerId = auth.user.id;

    const db = await getDb();
    const items = await db.collection("payments").find(query).sort({ createdAt: -1 }).toArray();
    return json(cleanDocs(items));
  } catch (error) {
    return json({ message: "Failed to load payments", error: error.message }, 500);
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
    const amount = Number(payload.amount);
    const status = normalizeStatus(payload.status);
    const note = String(payload.note || "").trim();

    if (!contractIdInput) {
      return json({ message: "contractId is required" }, 400, req);
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ message: "amount must be greater than 0" }, 400, req);
    }

    if (!status) {
      return json({ message: "status must be one of: paid, pending, failed" }, 400, req);
    }

    const contractQuery = normalizeContractQuery(contractIdInput);
    if (!contractQuery) {
      return json({ message: "Invalid contract id" }, 400, req);
    }

    const db = await getDb();
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

    const canonicalContractId = normalizeId(contract._id || contract.contractId || contractIdInput);
    const now = new Date();
    const doc = {
      contractId: canonicalContractId || contractIdInput,
      clientId,
      freelancerId,
      amount,
      status,
      note,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection("payments").insertOne(doc);
    return json(cleanDoc({ ...doc, _id: result.insertedId }), 201, req);
  } catch (error) {
    return json({ message: "Failed to create payment", error: error.message }, 500, req);
  }
}
