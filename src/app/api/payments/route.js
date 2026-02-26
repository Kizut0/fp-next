import { getDb } from "../../../lib/mongodb";
import { cleanDoc, cleanDocs, json, options, requireAuth, toObjectId } from "../../../lib/api";

export const dynamic = "force-dynamic";

const ALLOWED_STATUSES = new Set(["hold", "pending", "paid", "failed", "disputed", "refunded"]);
const CLIENT_ALLOWED_CREATE_STATUSES = new Set(["hold", "pending", "paid", "failed"]);
const DISPUTABLE_STATUSES = new Set(["hold", "pending", "disputed"]);
const RESOLUTION_VALUES = new Set(["release", "refund"]);

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

function normalizeStatus(value) {
  const status = String(value || "paid").trim().toLowerCase();
  return ALLOWED_STATUSES.has(status) ? status : "";
}

function normalizeResolution(value) {
  const resolution = String(value || "").trim().toLowerCase();
  return RESOLUTION_VALUES.has(resolution) ? resolution : "";
}

function normalizePaymentQuery(rawId) {
  const id = normalizeId(rawId);
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { paymentId: id }] };
  return { $or: [{ _id: id }, { paymentId: id }] };
}

function normalizeContractIdVariants(rawContractId) {
  const id = normalizeId(rawContractId);
  if (!id) return [];

  const objectId = toObjectId(id);
  return objectId ? [id, objectId] : [id];
}

function buildPaymentContractQuery(rawContractId) {
  const variants = normalizeContractIdVariants(rawContractId);
  if (!variants.length) return null;
  return { contractId: { $in: variants } };
}

function normalizeDisputeStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (status === "open" || status === "resolved") return status;
  return "none";
}

function hasOpenDispute(payment) {
  const disputeStatus = normalizeDisputeStatus(payment?.dispute?.status);
  if (disputeStatus === "open") return true;
  return normalizeStatus(payment?.status) === "disputed";
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

async function resolvePaymentFromPayload(payments, payload = {}) {
  const paymentId = normalizeId(payload.paymentId || payload.id || payload._id);
  if (paymentId) {
    const query = normalizePaymentQuery(paymentId);
    if (!query) return null;
    return payments.findOne(query);
  }

  const contractQuery = buildPaymentContractQuery(payload.contractId);
  if (!contractQuery) return null;

  return payments.findOne(contractQuery, { sort: { updatedAt: -1, createdAt: -1 } });
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
    const { searchParams } = new URL(req.url);
    const statusFilter = normalizeStatus(searchParams.get("status"));

    const query = {};
    if (auth.user.role === "Client") query.clientId = auth.user.id;
    if (auth.user.role === "Freelancer") query.freelancerId = auth.user.id;
    if (statusFilter) query.status = statusFilter;

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
      return json({ message: "status must be one of: hold, pending, paid, failed, disputed, refunded" }, 400, req);
    }

    if (auth.user.role !== "Admin" && !CLIENT_ALLOWED_CREATE_STATUSES.has(status)) {
      return json({ message: "Client cannot directly create disputed/refunded payments" }, 403, req);
    }

    const contractQuery = normalizeContractQuery(contractIdInput);
    if (!contractQuery) {
      return json({ message: "Invalid contract id" }, 400, req);
    }

    const db = await getDb();
    const users = db.collection(process.env.USER_COLLECTION || "userData");
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
      dispute: {
        status: "none",
        reason: "",
        openedAt: null,
        openedBy: "",
        resolution: "",
        resolutionNote: "",
        resolvedAt: null,
        resolvedBy: "",
      },
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection("payments").insertOne(doc);
    await recordWithdrawAttempt(users, freelancerId, now);
    return json(cleanDoc({ ...doc, _id: result.insertedId }), 201, req);
  } catch (error) {
    return json({ message: "Failed to create payment", error: error.message }, 500, req);
  }
}

export async function PATCH(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const payload = await req.json();
    const action = String(payload.action || "").trim().toLowerCase();
    if (!["dispute", "resolve"].includes(action)) {
      return json({ message: "Invalid action. Use dispute or resolve." }, 400, req);
    }

    const db = await getDb();
    const payments = db.collection("payments");
    const payment = await resolvePaymentFromPayload(payments, payload);
    if (!payment) {
      return json({ message: "Payment not found. Provide payment id or contractId." }, 404, req);
    }

    const now = new Date();

    if (action === "dispute") {
      if (!canDisputePayment(auth.user, payment)) {
        return json({ message: "Only payment owner client can open dispute" }, 403, req);
      }

      const status = normalizeStatus(payment.status);
      if (!DISPUTABLE_STATUSES.has(status)) {
        return json({ message: "This payment cannot be disputed in current status" }, 400, req);
      }

      if (hasOpenDispute(payment)) {
        return json({ message: "Dispute is already open for this payment" }, 409, req);
      }

      const reason = String(payload.reason || payload.note || "").trim();
      if (reason.length < 10) {
        return json({ message: "Dispute reason must be at least 10 characters" }, 400, req);
      }

      await payments.updateOne(
        { _id: payment._id },
        {
          $set: {
            status: "disputed",
            dispute: {
              status: "open",
              reason: reason.slice(0, 1500),
              openedAt: now,
              openedBy: normalizeId(auth.user.id),
              resolution: "",
              resolutionNote: "",
              resolvedAt: null,
              resolvedBy: "",
            },
            updatedAt: now,
          },
        }
      );

      const updated = await payments.findOne({ _id: payment._id });
      return json(cleanDoc(updated), 200, req);
    }

    if (auth.user.role !== "Admin") {
      return json({ message: "Only admin can resolve disputes" }, 403, req);
    }

    const resolution = normalizeResolution(payload.resolution || payload.decision);
    if (!resolution) {
      return json({ message: "resolution must be release or refund" }, 400, req);
    }

    if (!hasOpenDispute(payment)) {
      return json({ message: "No open dispute to resolve for this payment" }, 400, req);
    }

    const resolvedStatus = resolution === "release" ? "paid" : "refunded";
    const resolutionNote = String(payload.note || payload.resolutionNote || "").trim().slice(0, 1500);

    await payments.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: resolvedStatus,
          dispute: {
            ...payment.dispute,
            status: "resolved",
            resolution,
            resolutionNote,
            resolvedAt: now,
            resolvedBy: normalizeId(auth.user.id),
          },
          updatedAt: now,
        },
      }
    );

    const updated = await payments.findOne({ _id: payment._id });
    return json(cleanDoc(updated), 200, req);
  } catch (error) {
    return json({ message: "Failed to update payment", error: error.message }, 500, req);
  }
}
