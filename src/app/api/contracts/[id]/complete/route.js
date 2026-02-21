import { getDb } from "../../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
    return options(req);
}

export async function PATCH(req, { params }) {
    const auth = requireAuth(req);
    if (auth.error) return auth.error;

    try {
        const _id = toObjectId(params.id);
        if (!_id) return json({ message: "Invalid contract id" }, 400);

        const db = await getDb();
        const contracts = db.collection("contracts");
        const contract = await contracts.findOne({ _id });
        if (!contract) return json({ message: "Contract not found" }, 404);

        if (
            auth.user.role !== "Admin" &&
            auth.user.id !== contract.clientId &&
            auth.user.id !== contract.freelancerId
        ) {
            return json({ message: "Forbidden" }, 403);
        }

        await contracts.updateOne(
            { _id },
            { $set: { status: "completed", updatedAt: new Date() } }
        );

        const updated = await contracts.findOne({ _id });
        return json(cleanDoc(updated));
    } catch (error) {
        return json({ message: "Failed to complete contract", error: error.message }, 500);
    }
}
