import { getDb } from "../../../lib/mongodb";
import { cleanDoc, cleanDocs, json, options, requireAuth, toObjectId } from "../../../lib/api";
import { ensureReviewIndexes, isDuplicateKeyError } from "../../../lib/indexes";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
  return options(req);
}

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

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = normalizeId(searchParams.get("userId"));
    const mine = normalizeId(searchParams.get("mine")).toLowerCase();
    const contractId = normalizeId(searchParams.get("contractId"));

    let authUser = null;
    if (mine) {
      const auth = requireAuth(req);
      if (auth.error) return auth.error;
      authUser = auth.user;

      if (mine === "admin" && authUser.role !== "Admin") {
        return json({ message: "Forbidden" }, 403, req);
      }
    }

    const query = {};
    if (userId) query.revieweeId = userId;
    if (contractId) query.contractId = contractId;

    if (mine === "freelancer" && authUser?.id) {
      query.revieweeId = String(authUser.id);
    }

    if (mine === "client" && authUser?.id) {
      query.reviewerId = String(authUser.id);
    }

    const db = await getDb();
    const items = await db.collection("reviews").find(query).sort({ createdAt: -1 }).toArray();
    return json(cleanDocs(items), 200, req);
  } catch (error) {
    return json({ message: "Failed to load reviews", error: error.message }, 500, req);
  }
}

export async function POST(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const payload = await req.json();
    const revieweeId = normalizeId(payload.revieweeId);
    const contractId = normalizeId(payload.contractId);
    const rating = Number(payload.rating);
    const normalizedRating = Math.round(rating);
    const comment = String(payload.comment || "").trim();

    if (!contractId) {
      return json({ message: "contractId is required" }, 400, req);
    }

    if (!revieweeId) {
      return json({ message: "revieweeId is required" }, 400, req);
    }

    if (!Number.isFinite(rating) || normalizedRating < 1 || normalizedRating > 5) {
      return json({ message: "rating must be between 1 and 5" }, 400, req);
    }

    const db = await getDb();
    const reviews = db.collection("reviews");
    await ensureReviewIndexes(reviews);
    const contractQuery = normalizeContractQuery(contractId);
    if (!contractQuery) return json({ message: "Invalid contract id" }, 400, req);

    const contract = await db.collection("contracts").findOne(contractQuery);
    if (!contract) return json({ message: "Contract not found" }, 404, req);

    const actorId = normalizeId(auth.user.id);
    const participantIds = [
      contract.clientId,
      contract.freelancerId,
      contract.ownerId,
      contract.userId,
      contract.createdBy,
    ]
      .map(normalizeId)
      .filter(Boolean);

    const allowed = auth.user.role === "Admin" || participantIds.includes(actorId);
    if (!allowed) return json({ message: "Forbidden" }, 403, req);

    if (actorId && actorId === revieweeId) {
      return json({ message: "You cannot review yourself" }, 400, req);
    }

    const contractStatus = normalizeId(contract.status).toLowerCase();
    if (auth.user.role !== "Admin" && contractStatus !== "completed") {
      return json({ message: "You can only review completed contracts" }, 400, req);
    }

    const reviewableIds = [contract.clientId, contract.freelancerId]
      .map(normalizeId)
      .filter(Boolean);

    if (reviewableIds.length > 0 && !reviewableIds.includes(revieweeId)) {
      return json({ message: "revieweeId must match a contract participant" }, 400, req);
    }

    const canonicalContractId = normalizeId(contract._id || contract.contractId || contractId);
    const existing = await reviews.findOne({
      contractId: { $in: [canonicalContractId, contractId].filter(Boolean) },
      reviewerId: normalizeId(auth.user.id),
      revieweeId,
    });
    if (existing) {
      return json({ message: "Review already submitted for this contract" }, 409, req);
    }

    const now = new Date();
    const doc = {
      reviewerId: auth.user.id,
      revieweeId,
      contractId: canonicalContractId || contractId,
      rating: normalizedRating,
      comment,
      createdAt: now,
      updatedAt: now,
    };

    const result = await reviews.insertOne(doc);
    return json(cleanDoc({ ...doc, _id: result.insertedId }), 201, req);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return json({ message: "Review already submitted for this contract" }, 409, req);
    }
    return json({ message: "Failed to create review", error: error.message }, 500, req);
  }
}
