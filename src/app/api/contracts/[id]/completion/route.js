import { getDb } from "../../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../../lib/api";

export const dynamic = "force-dynamic";

function normalizeContractQuery(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { contractId: id }] };
  return { $or: [{ _id: id }, { contractId: id }] };
}

function normalizeText(value, maxLen = 500) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.slice(0, maxLen);
}

function normalizeUrl(value) {
  const raw = normalizeText(value, 1000);
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : "";
}

function normalizeAttachment(input) {
  if (!input || typeof input !== "object") return null;

  const name = normalizeText(input.name, 200);
  const type = normalizeText(input.type, 100);
  const dataUrl = normalizeText(input.dataUrl, 2_500_000);
  const size = Number(input.size || 0);

  if (!name || !dataUrl) return null;
  if (!Number.isFinite(size) || size <= 0 || size > 2_000_000) return null;
  if (!/^data:/i.test(dataUrl)) return null;

  return { name, type, size, dataUrl };
}

function normalizeId(value) {
  return String(value || "").trim();
}

function resolveContractClientId(contract) {
  return (
    normalizeId(contract.clientId) ||
    normalizeId(contract.userId) ||
    normalizeId(contract.ownerId) ||
    normalizeId(contract.createdBy)
  );
}

function canClientDecide(authUser, contract) {
  if (authUser.role === "Admin") return true;

  const userId = String(authUser.id || "").trim();
  if (!userId) return false;

  const clientIds = [contract.clientId, contract.userId, contract.ownerId, contract.createdBy]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  return authUser.role === "Client" && clientIds.includes(userId);
}

function canFreelancerSubmit(authUser, contract) {
  if (authUser.role === "Admin") return true;

  const userId = String(authUser.id || "").trim();
  const freelancerId = String(contract.freelancerId || "").trim();
  if (!userId || !freelancerId) return false;

  return authUser.role === "Freelancer" && userId === freelancerId;
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
    const action = String(payload.action || "").trim().toLowerCase();
    if (!["submit", "accept", "reject"].includes(action)) {
      return json({ message: "Invalid action. Use submit, accept, or reject." }, 400, req);
    }

    const db = await getDb();
    const contracts = db.collection("contracts");
    const contract = await contracts.findOne(query);
    if (!contract) return json({ message: "Contract not found" }, 404, req);

    const now = new Date();
    const authId = String(auth.user.id || "").trim();

    if (action === "submit") {
      if (!canFreelancerSubmit(auth.user, contract)) {
        return json({ message: "Only assigned freelancer can submit completion work" }, 403, req);
      }

      if (String(contract.status || "").toLowerCase() === "cancelled") {
        return json({ message: "Cannot submit work for cancelled contract" }, 400, req);
      }

      const link = normalizeUrl(payload.deliveryLink);
      const notes = normalizeText(payload.deliveryNotes, 1500);
      const attachment = normalizeAttachment(payload.deliveryAttachment);

      if (!link && !attachment) {
        return json({ message: "Attach at least one delivery link or file" }, 400, req);
      }

      const completionRequest = {
        status: "pending",
        link: link || "",
        notes: notes || "",
        attachment: attachment || null,
        submittedAt: now,
        submittedBy: authId,
        decisionAt: null,
        decidedBy: "",
        clientFeedback: "",
      };

      await contracts.updateOne(
        { _id: contract._id },
        {
          $set: {
            completionRequest,
            updatedAt: now,
          },
        }
      );
    }

    if (action === "accept") {
      if (!canClientDecide(auth.user, contract)) {
        return json({ message: "Only client can accept completion work" }, 403, req);
      }

      const requestStatus = String(contract.completionRequest?.status || "").toLowerCase();
      if (requestStatus !== "pending") {
        return json({ message: "No pending completion request to accept" }, 400, req);
      }

      await contracts.updateOne(
        { _id: contract._id },
        {
          $set: {
            status: "completed",
            endDate: contract.endDate || now,
            completionRequest: {
              ...contract.completionRequest,
              status: "accepted",
              decisionAt: now,
              decidedBy: authId,
              clientFeedback: normalizeText(payload.feedback, 1500),
            },
            updatedAt: now,
          },
        }
      );

      const payments = db.collection("payments");
      const canonicalId = normalizeId(contract._id || contract.contractId);
      const altId = normalizeId(contract.contractId);

      const existingPayment = await payments.findOne({
        $or: [{ contractId: canonicalId }, ...(altId ? [{ contractId: altId }] : [])],
      });

      if (!existingPayment) {
        const clientId = resolveContractClientId(contract);
        const freelancerId = normalizeId(contract.freelancerId);
        const amount = Number(contract.amount || 0);

        if (clientId && freelancerId && Number.isFinite(amount) && amount > 0) {
          await payments.insertOne({
            contractId: canonicalId || altId,
            clientId,
            freelancerId,
            amount,
            status: "pending",
            note: "Auto-created after client accepted completed work",
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }

    if (action === "reject") {
      if (!canClientDecide(auth.user, contract)) {
        return json({ message: "Only client can reject completion work" }, 403, req);
      }

      const requestStatus = String(contract.completionRequest?.status || "").toLowerCase();
      if (requestStatus !== "pending") {
        return json({ message: "No pending completion request to reject" }, 400, req);
      }

      await contracts.updateOne(
        { _id: contract._id },
        {
          $set: {
            status: "active",
            completionRequest: {
              ...contract.completionRequest,
              status: "rejected",
              decisionAt: now,
              decidedBy: authId,
              clientFeedback: normalizeText(payload.feedback, 1500),
            },
            updatedAt: now,
          },
        }
      );
    }

    const updated = await contracts.findOne({ _id: contract._id });
    return json(cleanDoc(updated), 200, req);
  } catch (error) {
    return json({ message: "Failed to process completion request", error: error.message }, 500, req);
  }
}
