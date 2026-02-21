import { getDb } from "../../../lib/mongodb";
import { cleanDoc, cleanDocs, json, options, requireAuth, toObjectId } from "../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get("jobId");
    const mine = searchParams.get("mine");

    const query = {};
    if (jobId) {
      const jobObjectId = toObjectId(jobId);
      query.jobId = jobObjectId || jobId;
    }

    if (mine === "freelancer" || auth.user.role === "Freelancer") {
      query.freelancerId = auth.user.id;
    }

    if (mine === "client" || auth.user.role === "Client") {
      query.clientId = auth.user.id;
    }

    const db = await getDb();
    const items = await db.collection("proposals").find(query).sort({ createdAt: -1 }).toArray();
    return json(cleanDocs(items));
  } catch (error) {
    return json({ message: "Failed to load proposals", error: error.message }, 500);
  }
}

export async function POST(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  if (auth.user.role !== "Freelancer" && auth.user.role !== "Admin") {
    return json({ message: "Only freelancers can submit proposals" }, 403);
  }

  try {
    const payload = await req.json();
    if (!payload.jobId) return json({ message: "jobId is required" }, 400);

    const db = await getDb();
    const jobs = db.collection(process.env.JOB_COLLECTION || "Job");
    const proposals = db.collection("proposals");

    const jobObjectId = toObjectId(payload.jobId);
    const job = await jobs.findOne({ _id: jobObjectId || payload.jobId });
    if (!job) return json({ message: "Job not found" }, 404);

    const now = new Date();
    const doc = {
      jobId: job._id,
      jobTitle: job.title,
      clientId: job.clientId,
      freelancerId: auth.user.id,
      price: Number(payload.price || 0),
      message: payload.message || "",
      status: payload.status || "submitted",
      createdAt: now,
      updatedAt: now,
    };

    const result = await proposals.insertOne(doc);
    return json(cleanDoc({ ...doc, _id: result.insertedId }), 201);
  } catch (error) {
    return json({ message: "Failed to submit proposal", error: error.message }, 500);
  }
}
