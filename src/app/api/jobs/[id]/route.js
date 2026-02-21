import { getDb } from "../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
  return options(req);
}

async function resolveJobQuery(params) {
  const resolvedParams = await params;
  const rawId = String(resolvedParams?.id || "").trim();
  if (!rawId) return null;

  const _id = toObjectId(rawId);
  if (_id) return { _id };

  // Backward compatibility for non-ObjectId records.
  return { $or: [{ jobId: rawId }, { _id: rawId }] };
}

export async function GET(_req, { params }) {
  try {
    const query = await resolveJobQuery(params);
    if (!query) return json({ message: "Invalid job id" }, 400);

    const db = await getDb();
    const job = await db.collection(process.env.JOB_COLLECTION || "Job").findOne(query);
    if (!job) return json({ message: "Job not found" }, 404);

    return json(cleanDoc(job));
  } catch (error) {
    return json({ message: "Failed to load job", error: error.message }, 500);
  }
}

export async function PUT(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const query = await resolveJobQuery(params);
    if (!query) return json({ message: "Invalid job id" }, 400);

    const db = await getDb();
    const jobs = db.collection(process.env.JOB_COLLECTION || "Job");
    const existing = await jobs.findOne(query);

    if (!existing) return json({ message: "Job not found" }, 404);
    if (
      auth.user.role !== "Admin" &&
      String(existing.clientId || "") !== String(auth.user.id || "")
    ) {
      return json({ message: "Forbidden" }, 403);
    }

    const payload = await req.json();
    const update = {
      title: payload.title ?? existing.title,
      description: payload.description ?? existing.description,
      budget: payload.budget !== undefined ? Number(payload.budget) : existing.budget,
      status: payload.status ?? existing.status,
      updatedAt: new Date(),
    };

    await jobs.updateOne({ _id: existing._id }, { $set: update });
    const updated = await jobs.findOne({ _id: existing._id });
    return json(cleanDoc(updated));
  } catch (error) {
    return json({ message: "Failed to update job", error: error.message }, 500);
  }
}

export async function DELETE(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const query = await resolveJobQuery(params);
    if (!query) return json({ message: "Invalid job id" }, 400);

    const db = await getDb();
    const jobs = db.collection(process.env.JOB_COLLECTION || "Job");
    const existing = await jobs.findOne(query);

    if (!existing) return json({ message: "Job not found" }, 404);
    if (
      auth.user.role !== "Admin" &&
      String(existing.clientId || "") !== String(auth.user.id || "")
    ) {
      return json({ message: "Forbidden" }, 403);
    }

    await jobs.deleteOne({ _id: existing._id });
    return json({ ok: true });
  } catch (error) {
    return json({ message: "Failed to delete job", error: error.message }, 500);
  }
}
