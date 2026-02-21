import { getDb } from "../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
    return options(req);
}

export async function GET(req) {
    const auth = requireAuth(req);
    if (auth.error) return auth.error;

    try {
        const db = await getDb();
        const users = db.collection(process.env.USER_COLLECTION || "userData");
        const _id = toObjectId(auth.user.id);
        if (!_id) return json({ message: "Invalid token user" }, 400);

        const user = await users.findOne({ _id }, { projection: { passwordHash: 0 } });
        if (!user) return json({ message: "User not found" }, 404);

        return json(cleanDoc(user));
    } catch (error) {
        return json({ message: "Failed to load current user", error: error.message }, 500);
    }
}
