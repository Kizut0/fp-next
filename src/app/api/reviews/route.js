import { getDb } from "../../../lib/mongodb";
import { cleanDoc, cleanDocs, json, options, requireAuth } from "../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");

    const query = userId ? { revieweeId: userId } : {};
    const db = await getDb();
    const items = await db.collection("reviews").find(query).sort({ createdAt: -1 }).toArray();
    return json(cleanDocs(items));
  } catch (error) {
    return json({ message: "Failed to load reviews", error: error.message }, 500);
  }
}

export async function POST(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const payload = await req.json();

    if (!payload.revieweeId) {
      return json({ message: "revieweeId is required" }, 400);
    }

    const now = new Date();
    const doc = {
      reviewerId: auth.user.id,
      revieweeId: payload.revieweeId,
      rating: Number(payload.rating || 0),
      comment: payload.comment || "",
      createdAt: now,
      updatedAt: now,
    };

    const db = await getDb();
    const result = await db.collection("reviews").insertOne(doc);
    return json(cleanDoc({ ...doc, _id: result.insertedId }), 201);
  } catch (error) {
    return json({ message: "Failed to create review", error: error.message }, 500);
  }
}
