import { getDb } from "../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../lib/api";

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

function parseNumber(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function buildOwnerMatch(user) {
  const ownerMatch = [];
  const ownerId = String(user?.id || "").trim();
  const ownerEmail = String(user?.email || "")
    .toLowerCase()
    .trim();

  if (ownerId) {
    const ownerObjectId = toObjectId(ownerId);
    const ownerKeys = ["clientId", "userId", "ownerId", "createdBy"];

    for (const key of ownerKeys) {
      ownerMatch.push({ [key]: ownerId });
      if (ownerObjectId) ownerMatch.push({ [key]: ownerObjectId });
    }
  }

  if (ownerEmail) {
    ownerMatch.push({ clientEmail: ownerEmail });
    ownerMatch.push({ email: ownerEmail });
  }

  return ownerMatch;
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

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildQuery(searchParams) {
  const query = {};

  const status = String(searchParams.get("status") || "").trim();
  const category = String(searchParams.get("category") || "").trim();
  const experienceLevel = String(searchParams.get("experienceLevel") || "").trim();
  const projectType = String(searchParams.get("projectType") || "").trim();
  const locationType = String(searchParams.get("locationType") || "").trim();
  const minBudget = parseNumber(searchParams.get("minBudget"));
  const maxBudget = parseNumber(searchParams.get("maxBudget"));
  const q = String(searchParams.get("q") || "").trim();

  if (status && status !== "all") query.status = status;
  if (category && category !== "all") query.category = category;
  if (experienceLevel && experienceLevel !== "all") query.experienceLevel = experienceLevel;
  if (projectType && projectType !== "all") query.projectType = projectType;
  if (locationType && locationType !== "all") query.locationType = locationType;

  if (minBudget !== null || maxBudget !== null) {
    query.budget = {};
    if (minBudget !== null) query.budget.$gte = minBudget;
    if (maxBudget !== null) query.budget.$lte = maxBudget;
  }

  if (q) {
    const safe = escapeRegex(q);
    const regex = { $regex: safe, $options: "i" };
    query.$or = [
      { title: regex },
      { description: regex },
      { category: regex },
      { skills: { $elemMatch: regex } },
    ];
  }

  return query;
}

function buildSort(searchParams) {
  const sort = String(searchParams.get("sort") || "newest").trim();

  switch (sort) {
    case "oldest":
      return { createdAt: 1 };
    case "budgetHigh":
      return { budget: -1, createdAt: -1 };
    case "budgetLow":
      return { budget: 1, createdAt: -1 };
    case "mostProposals":
      return { proposalsCount: -1, createdAt: -1 };
    default:
      return { createdAt: -1 };
  }
}

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const query = buildQuery(searchParams);
    const sort = buildSort(searchParams);
    const mine = String(searchParams.get("mine") || "").trim();

    if (mine === "client") {
      const auth = requireAuth(req);
      if (auth.error) return auth.error;

      if (auth.user.role && !["Client", "Admin"].includes(auth.user.role)) {
        return json({ message: "Only clients can view their own jobs" }, 403, req);
      }

      const ownerMatch = buildOwnerMatch(auth.user);
      if (!ownerMatch.length) {
        return json({ message: "Invalid auth token: missing owner identity" }, 401, req);
      }

      if (query.$or) {
        const textSearch = query.$or;
        delete query.$or;
        query.$and = [{ $or: ownerMatch }, { $or: textSearch }];
      } else {
        query.$or = ownerMatch;
      }
    }

    const db = await getDb();
    const jobs = await db
      .collection(process.env.JOB_COLLECTION || "Job")
      .find(query)
      .sort(sort)
      .toArray();

    return json(jobs.map(normalizeJob), 200, req);
  } catch (error) {
    return json({ message: "Failed to load jobs", error: error.message }, 500, req);
  }
}

export async function POST(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  if (auth.user.role && !["Client", "Admin"].includes(auth.user.role)) {
    return json({ message: "Only clients can create jobs" }, 403, req);
  }

  try {
    const payload = await req.json();
    const now = new Date();

    const title = String(payload.title || "").trim();
    const description = String(payload.description || "").trim();
    const budget = Number(payload.budget || 0);

    if (title.length < 6) {
      return json({ message: "Title must be at least 6 characters" }, 400, req);
    }

    if (description.length < 30) {
      return json({ message: "Description must be at least 30 characters" }, 400, req);
    }

    if (!Number.isFinite(budget) || budget <= 0) {
      return json({ message: "Budget must be greater than 0" }, 400, req);
    }

    const ownerId = String(auth.user.id || "").trim();
    const ownerEmail = String(auth.user.email || "")
      .toLowerCase()
      .trim();
    const ownerName = String(auth.user.name || "").trim();

    if (!ownerId && !ownerEmail) {
      return json({ message: "Invalid auth token: missing owner identity" }, 401, req);
    }

    const ownerFields = {
      ...(ownerId
        ? {
            clientId: ownerId,
            userId: ownerId,
            ownerId,
            createdBy: ownerId,
          }
        : {}),
      ...(ownerEmail ? { clientEmail: ownerEmail } : {}),
      ...(ownerName ? { clientName: ownerName } : {}),
    };

    const doc = {
      title,
      description,
      budget,
      category: String(payload.category || DEFAULTS.category),
      experienceLevel: String(payload.experienceLevel || DEFAULTS.experienceLevel),
      projectType: String(payload.projectType || DEFAULTS.projectType),
      duration: String(payload.duration || DEFAULTS.duration),
      locationType: String(payload.locationType || DEFAULTS.locationType),
      skills: toSkillsArray(payload.skills),
      proposalsCount: 0,
      ...ownerFields,
      status: normalizeStatus(payload.status),
      createdAt: now,
      postedAt: now,
      updatedAt: now,
    };

    const db = await getDb();
    const result = await db.collection(process.env.JOB_COLLECTION || "Job").insertOne(doc);
    return json(normalizeJob({ ...doc, _id: result.insertedId }), 201, req);
  } catch (error) {
    return json({ message: "Failed to create job", error: error.message }, 500, req);
  }
}
