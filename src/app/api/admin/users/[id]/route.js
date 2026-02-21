import { getDb } from "../../../../../lib/mongodb";
import { json, options, requireRole, toObjectId } from "../../../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
    return options(req);
}

export async function DELETE(req, { params }) {
    const auth = requireRole(req, ["Admin"]);
    if (auth.error) return auth.error;

    try {
        const _id = toObjectId(params.id);
        if (!_id) return json({ message: "Invalid user id" }, 400);

        const db = await getDb();
        await db.collection(process.env.USER_COLLECTION || "userData").deleteOne({ _id });

        return json({ ok: true });
    } catch (error) {
        return json({ message: "Failed to delete user", error: error.message }, 500);
    }
}
