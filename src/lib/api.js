import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { verifyToken } from "./auth";

function getCorsOrigin(req) {
  const requestOrigin = req?.headers?.get("origin") || "";
  const configured = (process.env.CORS_ORIGIN || "http://127.0.0.1:5173")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  if (configured.includes(requestOrigin)) return requestOrigin;

  const localAllowed = ["http://127.0.0.1:5173", "http://localhost:5173"];
  if (localAllowed.includes(requestOrigin)) return requestOrigin;

  return configured[0] || localAllowed[0];
}

function getCorsHeaders(req) {
  return {
    "Access-Control-Allow-Origin": getCorsOrigin(req),
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
  };
}

export function json(data, status = 200, req) {
  return NextResponse.json(data, { status, headers: getCorsHeaders(req) });
}

export function options(req) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(req) });
}

export function getBearerToken(req) {
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader.replace("Bearer ", "").trim();
}

export function getAuthUser(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  return verifyToken(token);
}

function pickFirst(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return "";
}

function normalizeRole(role) {
  const raw = String(role || "").trim();
  if (!raw) return "";

  const lower = raw.toLowerCase();
  if (lower === "client") return "Client";
  if (lower === "freelancer") return "Freelancer";
  if (lower === "admin") return "Admin";

  return raw;
}

function normalizeAuthUser(user) {
  if (!user || typeof user !== "object") return null;

  const out = { ...user };

  const id = pickFirst(
    out.id,
    out._id,
    out.userId,
    out.userid,
    out.user_id,
    out.userID,
    out.uid,
    out.sub
  );
  if (id) out.id = id;

  const role = normalizeRole(out.role);
  if (role) out.role = role;

  if (out.email) out.email = String(out.email).toLowerCase().trim();
  if (out.name) out.name = String(out.name).trim();

  return out;
}

export function requireAuth(req) {
  const user = normalizeAuthUser(getAuthUser(req));
  if (!user) {
    return { error: json({ message: "Unauthorized" }, 401, req) };
  }
  return { user };
}

export function requireRole(req, roles = []) {
  const auth = requireAuth(req);
  if (auth.error) return auth;

  if (!roles.includes(auth.user.role)) {
    return { error: json({ message: "Forbidden" }, 403, req) };
  }

  return auth;
}

export function toObjectId(id) {
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

export function cleanDoc(doc) {
  if (!doc) return null;
  const out = { ...doc };
  if (out._id) out._id = String(out._id);
  if (out.userId) out.userId = String(out.userId);
  if (out.jobId && typeof out.jobId !== "string") out.jobId = String(out.jobId);
  if (out.freelancerId && typeof out.freelancerId !== "string") out.freelancerId = String(out.freelancerId);
  if (out.clientId && typeof out.clientId !== "string") out.clientId = String(out.clientId);
  if (out.ownerId && typeof out.ownerId !== "string") out.ownerId = String(out.ownerId);
  if (out.createdBy && typeof out.createdBy !== "string") out.createdBy = String(out.createdBy);
  if (out.contractId && typeof out.contractId !== "string") out.contractId = String(out.contractId);
  if (out.proposalId && typeof out.proposalId !== "string") out.proposalId = String(out.proposalId);
  if (out.reviewerId && typeof out.reviewerId !== "string") out.reviewerId = String(out.reviewerId);
  if (out.revieweeId && typeof out.revieweeId !== "string") out.revieweeId = String(out.revieweeId);
  if (out.clientEmail) out.clientEmail = String(out.clientEmail).toLowerCase().trim();
  if (out.clientName) out.clientName = String(out.clientName).trim();
  return out;
}

export function cleanDocs(items = []) {
  return items.map(cleanDoc);
}
