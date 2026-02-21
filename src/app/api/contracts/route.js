import { getDb } from "../../../lib/mongodb";
import { cleanDocs, json, options, requireAuth } from "../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
    return options(req);
}

export async function GET(req) {
    const auth = requireAuth(req);
    if (auth.error) return auth.error;

    try {
        const query = {};

        if (auth.user.role === "Client") query.clientId = auth.user.id;
        if (auth.user.role === "Freelancer") query.freelancerId = auth.user.id;

        const db = await getDb();
        const items = await db.collection("contracts").find(query).sort({ createdAt: -1 }).toArray();
        return json(cleanDocs(items));
    } catch (error) {
        return json({ message: "Failed to load contracts", error: error.message }, 500);
    }
}
