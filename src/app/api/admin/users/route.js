import { getDb } from "../../../../lib/mongodb";
import { cleanDocs, json, options, requireRole, toObjectId } from "../../../../lib/api";

export const dynamic = "force-dynamic";

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

        return json(cleanDocs(users));
    } catch (error) {
        return json({ message: "Failed to load users", error: error.message }, 500);
    }
}

export async function PATCH(req) {
    const auth = requireRole(req, ["Admin"]);
    if (auth.error) return auth.error;

    try {
        const payload = await req.json();
        if (!payload.id) return json({ message: "id is required" }, 400);

        const _id = toObjectId(payload.id);
        if (!_id) return json({ message: "Invalid user id" }, 400);

        const db = await getDb();
        await db.collection(process.env.USER_COLLECTION || "userData").updateOne(
            { _id },
            { $set: { status: payload.status || "active", updatedAt: new Date() } }
        );

        return json({ ok: true });
    } catch (error) {
        return json({ message: "Failed to update user", error: error.message }, 500);
    }
}
