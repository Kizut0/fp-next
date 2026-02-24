import { getDb } from "../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../lib/api";

export const dynamic = "force-dynamic";

const DEFAULTS = {
  category: "Web Development",
  experienceLevel: "Intermediate",
  projectType: "Fixed",
  duration: "1 to 3 months",
  locationType: "Remote",
};

function toSkillsArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function toValidDate(...values) {
  for (const value of values) {
    if (!value) continue;

    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return null;
}

function deriveCreatedAt(clean) {
  const direct = toValidDate(
    clean.createdAt,
    clean.postedAt,
    clean.postedDate,
    clean.created_on,
    clean.date
  );
  if (direct) return direct;

  const fromId = toObjectId(clean._id || clean.jobId);
  return fromId ? fromId.getTimestamp() : null;
}

function normalizeStatus(value) {
  const raw = String(value || "open").trim().toLowerCase();
  if (raw === "closed") return "closed";
  return "open";
}

function normalizeJob(job) {
  const clean = cleanDoc(job) || {};
  const createdAt = deriveCreatedAt(clean);
  const updatedAt = toValidDate(clean.updatedAt, clean.modifiedAt, clean.lastUpdated, createdAt);

  return {
    ...clean,
    title: String(clean.title || "Untitled Project"),
    description: String(clean.description || ""),
    budget: Number(clean.budget ?? clean.price ?? 0),
    category: String(clean.category || DEFAULTS.category),
    experienceLevel: String(clean.experienceLevel || DEFAULTS.experienceLevel),
    projectType: String(clean.projectType || DEFAULTS.projectType),
    duration: String(clean.duration || DEFAULTS.duration),
    locationType: String(clean.locationType || DEFAULTS.locationType),
    skills: toSkillsArray(clean.skills),
    proposalsCount: Number(clean.proposalsCount || 0),
    status: normalizeStatus(clean.status),
    createdAt,
    updatedAt,
  };
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function toStringValues(values = []) {
  return values
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function isOwnedByUser(job, user) {
  const ownerIds = toStringValues([job?.clientId, job?.userId, job?.ownerId, job?.createdBy]);
  const userIds = toStringValues([user?.id, user?._id, user?.userId, user?.sub]);

  if (ownerIds.some((ownerId) => userIds.includes(ownerId))) {
    return true;
  }

  const ownerEmails = [normalizeEmail(job?.clientEmail), normalizeEmail(job?.email)].filter(Boolean);
  const userEmail = normalizeEmail(user?.email);

  return Boolean(userEmail && ownerEmails.includes(userEmail));
}

async function resolveJobQuery(params) {
  const resolvedParams = await params;
  const rawId = String(resolvedParams?.id || "").trim();
  if (!rawId) return null;

  const _id = toObjectId(rawId);
  if (_id) {
    return { $or: [{ _id }, { jobId: rawId }, { _id: rawId }] };
  }

  // Backward compatibility for non-ObjectId records.
  return { $or: [{ jobId: rawId }, { _id: rawId }] };
}

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req, { params }) {
  try {
    const query = await resolveJobQuery(params);
    if (!query) return json({ message: "Invalid job id" }, 400, req);

    const db = await getDb();
    const job = await db.collection(process.env.JOB_COLLECTION || "Job").findOne(query);
    if (!job) return json({ message: "Job not found" }, 404, req);

    return json(normalizeJob(job), 200, req);
  } catch (error) {
    return json({ message: "Failed to load job", error: error.message }, 500, req);
  }
}

export async function PUT(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const query = await resolveJobQuery(params);
    if (!query) return json({ message: "Invalid job id" }, 400, req);

    const db = await getDb();
    const jobs = db.collection(process.env.JOB_COLLECTION || "Job");
    const existing = await jobs.findOne(query);

    if (!existing) return json({ message: "Job not found" }, 404, req);
    if (auth.user.role !== "Admin" && !isOwnedByUser(existing, auth.user)) {
      return json({ message: "Forbidden" }, 403, req);
    }

    const payload = await req.json();

    const update = {
      title: payload.title !== undefined ? String(payload.title || "").trim() : existing.title,
      description:
        payload.description !== undefined
          ? String(payload.description || "").trim()
          : existing.description,
      budget: payload.budget !== undefined ? Number(payload.budget) : Number(existing.budget || 0),
      status:
        payload.status !== undefined ? normalizeStatus(payload.status) : normalizeStatus(existing.status),
      category:
        payload.category !== undefined
          ? String(payload.category || DEFAULTS.category)
          : String(existing.category || DEFAULTS.category),
      experienceLevel:
        payload.experienceLevel !== undefined
          ? String(payload.experienceLevel || DEFAULTS.experienceLevel)
          : String(existing.experienceLevel || DEFAULTS.experienceLevel),
      projectType:
        payload.projectType !== undefined
          ? String(payload.projectType || DEFAULTS.projectType)
          : String(existing.projectType || DEFAULTS.projectType),
      duration:
        payload.duration !== undefined
          ? String(payload.duration || DEFAULTS.duration)
          : String(existing.duration || DEFAULTS.duration),
      locationType:
        payload.locationType !== undefined
          ? String(payload.locationType || DEFAULTS.locationType)
          : String(existing.locationType || DEFAULTS.locationType),
      skills: payload.skills !== undefined ? toSkillsArray(payload.skills) : toSkillsArray(existing.skills),
      updatedAt: new Date(),
    };

    if (!update.title || update.title.length < 6) {
      return json({ message: "Title must be at least 6 characters" }, 400, req);
    }

    if (!update.description || update.description.length < 30) {
      return json({ message: "Description must be at least 30 characters" }, 400, req);
    }

    if (!Number.isFinite(update.budget) || update.budget <= 0) {
      return json({ message: "Budget must be greater than 0" }, 400, req);
    }

    await jobs.updateOne({ _id: existing._id }, { $set: update });
    const updated = await jobs.findOne({ _id: existing._id });
    return json(normalizeJob(updated), 200, req);
  } catch (error) {
    return json({ message: "Failed to update job", error: error.message }, 500, req);
  }
}

export async function DELETE(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const query = await resolveJobQuery(params);
    if (!query) return json({ message: "Invalid job id" }, 400, req);

    const db = await getDb();
    const jobs = db.collection(process.env.JOB_COLLECTION || "Job");
    const existing = await jobs.findOne(query);

    if (!existing) return json({ message: "Job not found" }, 404, req);
    if (auth.user.role !== "Admin" && !isOwnedByUser(existing, auth.user)) {
      return json({ message: "Forbidden" }, 403, req);
    }

    await jobs.deleteOne({ _id: existing._id });
    return json({ ok: true }, 200, req);
  } catch (error) {
    return json({ message: "Failed to delete job", error: error.message }, 500, req);
  }
}
