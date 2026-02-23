import { getDb } from "../../../../lib/mongodb";
import { cleanDoc, json, options, toObjectId } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
  return options(req);
}

function resolveUserQuery(rawId) {
  const _id = toObjectId(rawId);
  if (_id) {
    return { $or: [{ _id }, { _id: rawId }, { userId: rawId }] };
  }

  return { $or: [{ _id: rawId }, { userId: rawId }] };
}

export async function GET(req, { params }) {
  try {
    const resolvedParams = await params;
    const rawId = String(resolvedParams?.id || "").trim();
    if (!rawId) return json({ message: "Invalid user id" }, 400, req);

    const db = await getDb();
    const users = db.collection(process.env.USER_COLLECTION || "userData");
    const query = resolveUserQuery(rawId);

    const user = await users.findOne(
      query,
      { projection: { passwordHash: 0, password: 0 } }
    );

    if (!user) return json({ message: "User not found" }, 404, req);

    return json(cleanDoc(user), 200, req);
  } catch (error) {
    return json({ message: "Failed to load user", error: error.message }, 500, req);
  }
}
