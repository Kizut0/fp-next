import { getDb } from "../../../../lib/mongodb";
import { json, options, requireRole } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
    return options(req);
}

export async function GET(req) {
    const auth = requireRole(req, ["Admin"]);
    if (auth.error) return auth.error;

    try {
        const db = await getDb();

        const [totalUsers, activeJobs, activeContracts] = await Promise.all([
            db.collection(process.env.USER_COLLECTION || "userData").countDocuments({}),
            db.collection(process.env.JOB_COLLECTION || "Job").countDocuments({ status: "open" }),
            db.collection("contracts").countDocuments({ status: "active" }),
        ]);

        return json({ totalUsers, activeJobs, activeContracts });
    } catch (error) {
        return json({ message: "Failed to load admin stats", error: error.message }, 500);
    }
}
