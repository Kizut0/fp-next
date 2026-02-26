import { getDb } from "../../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../../lib/api";
import {
  buildDisputeOpenState,
  buildDisputeResolvedState,
  buildPaymentStatusHistoryEntry,
  canTransitionPaymentStatus,
  ensurePaymentIndexes,
  hasOpenDispute,
  isActivePaymentStatus,
  normalizePaymentStatus,
} from "../../../../../lib/payments";

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
  const ids = [];
  const seen = new Set();
  const contractIds = [contract?._id, contract?.contractId];

  for (const value of contractIds) {
    const normalized = normalizeId(value);
    if (!normalized) continue;

    const stringKey = `s:${normalized}`;
    if (!seen.has(stringKey)) {
      seen.add(stringKey);
      ids.push(normalized);
    }

    const objectId = toObjectId(normalized);
    if (!objectId) continue;

    const objectIdKey = `o:${String(objectId)}`;
    if (!seen.has(objectIdKey)) {
      seen.add(objectIdKey);
      ids.push(objectId);
    }
  }

  if (!ids.length) return null;
  return { contractId: { $in: ids } };
}

function canOpenByCompletionOrPayment(contract, payment) {
  const completionStatus = normalizeId(contract?.completionRequest?.status).toLowerCase();
  if (["pending", "accepted"].includes(completionStatus)) return true;

  const paymentStatus = normalizePaymentStatus(payment?.status, "");
  return ["reserved", "in_review", "released", "disputed"].includes(paymentStatus);
}

function isResolvableDispute(dispute) {
  return normalizeId(dispute?.status).toLowerCase() === "open";
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
    await ensurePaymentIndexes(payments);

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
      if (hasOpenDispute(payment)) {
        return json({ message: "This payment already has an open dispute" }, 409, req);
      }

      if (!canOpenByCompletionOrPayment(contract, payment)) {
        return json({ message: "Dispute can only be opened after submission or during reserved/in-review/released payment states" }, 400, req);
      }

      const paymentStatus = normalizePaymentStatus(payment?.status, "");
      if (["withdrawn", "refunded", "failed"].includes(paymentStatus)) {
        return json({ message: "Cannot open dispute for withdrawn/refunded/failed payment" }, 409, req);
      }

      const update = {
        dispute: buildDisputeOpenState({ reason, openedBy: actorId, now }),
        updatedAt: now,
      };

      await contracts.updateOne({ _id: contract._id }, { $set: update });

      if (payment?._id) {
        if (!canTransitionPaymentStatus(paymentStatus, "disputed")) {
          return json(
            { message: `Invalid payment status transition: ${paymentStatus} -> disputed` },
            409,
            req
          );
        }

        await payments.updateOne(
          { _id: payment._id },
          {
            $set: {
              status: "disputed",
              isActive: isActivePaymentStatus("disputed"),
              note: payment.note || "Payment marked disputed by client",
              dispute: buildDisputeOpenState({ reason, openedBy: actorId, now }),
              updatedAt: now,
            },
            $push: {
              statusHistory: {
                $each: [
                  buildPaymentStatusHistoryEntry({
                    action: "contract_dispute_open",
                    fromStatus: paymentStatus,
                    toStatus: "disputed",
                    reason,
                    actorId,
                    at: now,
                  }),
                ],
                $slice: -120,
              },
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

    const currentPaymentStatus = normalizePaymentStatus(payment.status, "");
    const nextPaymentStatus = resolution === "release" ? "released" : "refunded";
    if (!canTransitionPaymentStatus(currentPaymentStatus, nextPaymentStatus)) {
      return json(
        { message: `Invalid payment status transition: ${currentPaymentStatus} -> ${nextPaymentStatus}` },
        409,
        req
      );
    }

    await payments.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: nextPaymentStatus,
          isActive: isActivePaymentStatus(nextPaymentStatus),
          note:
            resolutionNote ||
            (resolution === "release" ? "Released by admin after dispute resolution" : "Refunded by admin after dispute resolution"),
          dispute: buildDisputeResolvedState({
            previous: payment.dispute,
            resolution,
            resolutionNote,
            resolvedBy: actorId,
            now,
          }),
          updatedAt: now,
        },
        $push: {
          statusHistory: {
            $each: [
              buildPaymentStatusHistoryEntry({
                action: "contract_dispute_resolve",
                fromStatus: currentPaymentStatus,
                toStatus: nextPaymentStatus,
                reason: resolutionNote || resolution,
                actorId,
                at: now,
              }),
            ],
            $slice: -120,
          },
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
