import { getDb } from "../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(_req, { params }) {
  try {
    const _id = toObjectId(params.id);
    if (!_id) return json({ message: "Invalid review id" }, 400);

    const db = await getDb();
    const review = await db.collection("reviews").findOne({ _id });
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
    const _id = toObjectId(params.id);
    if (!_id) return json({ message: "Invalid review id" }, 400);

    const db = await getDb();
    const reviews = db.collection("reviews");
    const review = await reviews.findOne({ _id });
    if (!review) return json({ message: "Review not found" }, 404);

    const canDelete = auth.user.role === "Admin" || review.reviewerId === auth.user.id;
    if (!canDelete) return json({ message: "Forbidden" }, 403);

    await reviews.deleteOne({ _id });
    return json({ ok: true });
  } catch (error) {
    return json({ message: "Failed to delete review", error: error.message }, 500);
  }
}
