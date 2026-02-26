import { getDb } from "../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../lib/api";

export const dynamic = "force-dynamic";

async function getParamId(params) {
  const resolved = await params;
  return String(resolved?.id || "").trim();
}

function normalizeId(value) {
  return String(value || "").trim();
}

function resolveReviewQuery(rawId) {
  const id = normalizeId(rawId);
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { reviewId: id }] };
  return { $or: [{ _id: id }, { reviewId: id }] };
}

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(_req, { params }) {
  try {
    const rawId = await getParamId(params);
    const query = resolveReviewQuery(rawId);
    if (!query) return json({ message: "Invalid review id" }, 400);

    const db = await getDb();
    const review = await db.collection("reviews").findOne(query);
    if (!review) return json({ message: "Review not found" }, 404);

    return json(cleanDoc(review));
  } catch (error) {
    return json({ message: "Failed to load review", error: error.message }, 500);
  }
}

export async function DELETE(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const rawId = await getParamId(params);
    const query = resolveReviewQuery(rawId);
    if (!query) return json({ message: "Invalid review id" }, 400);

    const db = await getDb();
    const reviews = db.collection("reviews");
    const review = await reviews.findOne(query);
    if (!review) return json({ message: "Review not found" }, 404);

    const canDelete = auth.user.role === "Admin" || review.reviewerId === auth.user.id;
    if (!canDelete) return json({ message: "Forbidden" }, 403);

    await reviews.deleteOne({ _id: review._id });
    return json({ ok: true });
  } catch (error) {
    return json({ message: "Failed to delete review", error: error.message }, 500);
  }
}
