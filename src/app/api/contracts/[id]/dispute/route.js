import { getDb } from "../../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../../lib/api";

export const dynamic = "force-dynamic";

const RESOLUTION_DECISIONS = new Set(["release", "refund"]);

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeText(value, maxLen = 1000) {
  return String(value || "").trim().slice(0, maxLen);
}

function normalizeContractQuery(rawId) {
  const id = normalizeId(rawId);
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { contractId: id }] };
  return { $or: [{ _id: id }, { contractId: id }] };
}

function resolveContractClientId(contract) {
  return (
    normalizeId(contract.clientId) ||
    normalizeId(contract.userId) ||
    normalizeId(contract.ownerId) ||
    normalizeId(contract.createdBy)
  );
}

function canClientOpenDispute(authUser, contract) {
  if (authUser.role === "Admin") return true;
  if (authUser.role !== "Client") return false;

  const actorId = normalizeId(authUser.id);
  if (!actorId) return false;

  const clientIds = [contract.clientId, contract.userId, contract.ownerId, contract.createdBy]
    .map(normalizeId)
    .filter(Boolean);

  return clientIds.includes(actorId);
}

function resolvePaymentQuery(contract) {
  const canonicalId = normalizeId(contract._id || contract.contractId);
  const alternateId = normalizeId(contract.contractId);
  const ids = [canonicalId, alternateId].filter(Boolean);
  if (!ids.length) return null;
  return { contractId: { $in: ids } };
}

function canOpenByCompletionOrPayment(contract, payment) {
  const completionStatus = normalizeId(contract?.completionRequest?.status).toLowerCase();
  if (["pending", "accepted"].includes(completionStatus)) return true;

  const paymentStatus = normalizeId(payment?.status).toLowerCase();
  return ["pending", "hold"].includes(paymentStatus);
}

function isResolvableDispute(dispute) {
  return normalizeId(dispute?.status).toLowerCase() === "open";
}

function buildDisputeState(actionBy, reason, now) {
  return {
    status: "open",
    reason,
    openedAt: now,
    openedBy: actionBy,
    resolvedAt: null,
    resolvedBy: "",
    resolution: "",
    resolutionNote: "",
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
    const query = normalizeContractQuery(rawId);
    if (!query) return json({ message: "Invalid contract id" }, 400, req);

    const payload = await req.json();
    const action = normalizeId(payload.action).toLowerCase();
    if (!["open", "resolve"].includes(action)) {
      return json({ message: "Invalid action. Use open or resolve." }, 400, req);
    }

    const db = await getDb();
    const contracts = db.collection("contracts");
    const payments = db.collection("payments");

    const contract = await contracts.findOne(query);
    if (!contract) return json({ message: "Contract not found" }, 404, req);

    const paymentQuery = resolvePaymentQuery(contract);
    const payment = paymentQuery ? await payments.findOne(paymentQuery, { sort: { createdAt: -1 } }) : null;
    const now = new Date();
    const actorId = normalizeId(auth.user.id);

    if (action === "open") {
      if (!canClientOpenDispute(auth.user, contract)) {
        return json({ message: "Only client can open dispute" }, 403, req);
      }

      const reason = normalizeText(payload.reason, 1500);
      if (!reason) {
        return json({ message: "reason is required" }, 400, req);
      }

      if (isResolvableDispute(contract.dispute)) {
        return json({ message: "This contract already has an open dispute" }, 409, req);
      }

      if (!canOpenByCompletionOrPayment(contract, payment)) {
        return json({ message: "Dispute can only be opened after submission or during payment hold/pending" }, 400, req);
      }

      if (normalizeId(payment?.status).toLowerCase() === "paid") {
        return json({ message: "Cannot open dispute after payment release" }, 409, req);
      }

      const update = {
        dispute: buildDisputeState(actorId, reason, now),
        updatedAt: now,
      };

      await contracts.updateOne({ _id: contract._id }, { $set: update });

      if (payment?._id) {
        await payments.updateOne(
          { _id: payment._id },
          {
            $set: {
              status: "hold",
              note: payment.note || "Payment put on hold due to dispute",
              updatedAt: now,
            },
          }
        );
      }

      const updated = await contracts.findOne({ _id: contract._id });
      return json(cleanDoc(updated), 200, req);
    }

    if (auth.user.role !== "Admin") {
      return json({ message: "Only admin can resolve disputes" }, 403, req);
    }

    if (!isResolvableDispute(contract.dispute)) {
      return json({ message: "No open dispute to resolve" }, 400, req);
    }

    const resolution = normalizeId(payload.decision).toLowerCase();
    if (!RESOLUTION_DECISIONS.has(resolution)) {
      return json({ message: "decision must be one of: release, refund" }, 400, req);
    }

    const resolutionNote = normalizeText(payload.resolutionNote, 1500);
    if (!payment?._id) {
      return json({ message: "Cannot resolve dispute without a payment record" }, 404, req);
    }

    const nextPaymentStatus = resolution === "release" ? "paid" : "refunded";
    await payments.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: nextPaymentStatus,
          note:
            resolutionNote ||
            (resolution === "release" ? "Released by admin after dispute resolution" : "Refunded by admin after dispute resolution"),
          updatedAt: now,
        },
      }
    );

    await contracts.updateOne(
      { _id: contract._id },
      {
        $set: {
          dispute: {
            ...contract.dispute,
            status: "resolved",
            resolvedAt: now,
            resolvedBy: actorId,
            resolution,
            resolutionNote,
          },
          updatedAt: now,
        },
      }
    );

    const updated = await contracts.findOne({ _id: contract._id });
    return json(cleanDoc(updated), 200, req);
  } catch (error) {
    return json({ message: "Failed to process dispute", error: error.message }, 500, req);
  }
}
