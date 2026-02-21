import { getDb } from "../../../lib/mongodb";
import { cleanDoc, cleanDocs, json, options, requireAuth } from "../../../lib/api";

export const dynamic = "force-dynamic";

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
    return json({ message: "Only clients can create payments" }, 403);
  }

  try {
    const payload = await req.json();
    const now = new Date();
    const doc = {
      contractId: payload.contractId || null,
      clientId: auth.user.id,
      freelancerId: payload.freelancerId || null,
      amount: Number(payload.amount || 0),
      status: payload.status || "paid",
      note: payload.note || "",
      createdAt: now,
      updatedAt: now,
    };

    const db = await getDb();
    const result = await db.collection("payments").insertOne(doc);
    return json(cleanDoc({ ...doc, _id: result.insertedId }), 201);
  } catch (error) {
    return json({ message: "Failed to create payment", error: error.message }, 500);
  }
}
