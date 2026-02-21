import { getDb } from "../../../lib/mongodb";
import { cleanDoc, cleanDocs, json, options, requireAuth } from "../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
  return options(req);
}

export async function GET() {
  try {
    const db = await getDb();
    const jobs = await db
      .collection(process.env.JOB_COLLECTION || "Job")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    return json(cleanDocs(jobs));
  } catch (error) {
    return json({ message: "Failed to load jobs", error: error.message }, 500);
  }
}

export async function POST(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  if (!["Client", "Admin"].includes(auth.user.role)) {
    return json({ message: "Only clients can create jobs" }, 403);
  }

  try {
    const payload = await req.json();
    const now = new Date();

    const doc = {
      title: payload.title || "Untitled Job",
      description: payload.description || "",
      budget: Number(payload.budget || 0),
      clientId: auth.user.id,
      status: payload.status || "open",
      createdAt: now,
      updatedAt: now,
    };

    const db = await getDb();
    const result = await db.collection(process.env.JOB_COLLECTION || "Job").insertOne(doc);
    return json(cleanDoc({ ...doc, _id: result.insertedId }), 201);
  } catch (error) {
    return json({ message: "Failed to create job", error: error.message }, 500);
  }
}
