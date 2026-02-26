import { getDb } from "../../../../lib/mongodb";
import { cleanDocs, json, options, requireRole, toObjectId } from "../../../../lib/api";

export const dynamic = "force-dynamic";

const ALLOWED_STATUSES = ["active", "blocked", "deactive"];
const STATUS_ALIASES = {
  inactive: "deactive",
  deactivated: "deactive",
};
const ALLOWED_TRANSITIONS = {
  active: new Set(["blocked", "deactive"]),
  blocked: new Set(["active", "deactive"]),
  deactive: new Set(["active", "blocked"]),
};

function normalizeStatus(value, fallback = "active") {
  const raw = String(value || "").trim().toLowerCase();
  const mapped = STATUS_ALIASES[raw] || raw;
  if (ALLOWED_STATUSES.includes(mapped)) return mapped;

  const fallbackRaw = String(fallback || "active").trim().toLowerCase();
  const fallbackMapped = STATUS_ALIASES[fallbackRaw] || fallbackRaw;
  if (ALLOWED_STATUSES.includes(fallbackMapped)) return fallbackMapped;

  return "";
}

function normalizeReason(value) {
  return String(value || "").trim().slice(0, 1000);
}

function buildModerationAuditEntry({ fromStatus, toStatus, reason, adminUser, now }) {
  const by = {
    role: String(adminUser?.role || "Admin"),
  };

  const id = String(adminUser?.id || "").trim();
  if (id) by.id = id;

  const email = String(adminUser?.email || "").trim().toLowerCase();
  if (email) by.email = email;

  const name = String(adminUser?.name || "").trim();
  if (name) by.name = name;

  return {
    action: "status_change",
    fromStatus,
    toStatus,
    reason,
    at: now,
    by,
  };
}

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req) {
  const auth = requireRole(req, ["Admin"]);
  if (auth.error) return auth.error;

  try {
    const db = await getDb();
    const users = await db
      .collection(process.env.USER_COLLECTION || "userData")
      .find({}, { projection: { passwordHash: 0 } })
      .sort({ createdAt: -1 })
      .toArray();

    return json(cleanDocs(users), 200, req);
  } catch (error) {
    return json({ message: "Failed to load users", error: error.message }, 500, req);
  }
}

export async function PATCH(req) {
  const auth = requireRole(req, ["Admin"]);
  if (auth.error) return auth.error;

  try {
    const payload = await req.json();
    if (!payload.id) return json({ message: "id is required" }, 400, req);

    // Audit log is append-only and cannot be replaced by request payload.
    if (payload.moderationAuditLog !== undefined || payload.moderationAudit !== undefined) {
      return json({ message: "moderationAuditLog is immutable" }, 400, req);
    }

    const _id = toObjectId(payload.id);
    if (!_id) return json({ message: "Invalid user id" }, 400, req);

    const nextStatus = normalizeStatus(payload.status, "");
    if (!nextStatus) {
      return json(
        { message: `status must be one of: ${ALLOWED_STATUSES.join(", ")}` },
        400,
        req
      );
    }

    const reason = normalizeReason(payload.reason);
    if (!reason) {
      return json({ message: "reason is required for moderation actions" }, 400, req);
    }

    const db = await getDb();
    const users = db.collection(process.env.USER_COLLECTION || "userData");
    const user = await users.findOne({ _id }, { projection: { status: 1 } });
    if (!user) return json({ message: "User not found" }, 404, req);

    const currentStatus = normalizeStatus(user.status, "active");
    if (!currentStatus) {
      return json({ message: "Current user status is invalid" }, 409, req);
    }
    if (currentStatus === nextStatus) {
      return json({ message: `User is already ${nextStatus}` }, 409, req);
    }

    const allowed = ALLOWED_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.has(nextStatus)) {
      return json(
        { message: `Invalid status transition: ${currentStatus} -> ${nextStatus}` },
        409,
        req
      );
    }

    const now = new Date();
    const auditEntry = buildModerationAuditEntry({
      fromStatus: currentStatus,
      toStatus: nextStatus,
      reason,
      adminUser: auth.user,
      now,
    });

    const result = await users.updateOne(
      { _id },
      {
        $set: { status: nextStatus, updatedAt: now },
        $push: { moderationAuditLog: auditEntry },
      }
    );

    if (!result.matchedCount) return json({ message: "User not found" }, 404, req);

    return json(
      {
        ok: true,
        status: nextStatus,
        moderationAudit: auditEntry,
      },
      200,
      req
    );
  } catch (error) {
    return json({ message: "Failed to update user", error: error.message }, 500, req);
  }
}
