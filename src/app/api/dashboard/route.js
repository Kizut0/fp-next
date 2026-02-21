import { getDb } from "../../../lib/mongodb";
import { json, options, requireAuth } from "../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const db = await getDb();

    if (auth.user.role === "Admin") {
      const [totalUsers, activeJobs, activeContracts] = await Promise.all([
        db.collection(process.env.USER_COLLECTION || "userData").countDocuments({}),
        db.collection(process.env.JOB_COLLECTION || "Job").countDocuments({ status: "open" }),
        db.collection("contracts").countDocuments({ status: "active" }),
      ]);

      return json({
        totalUsers,
        activeJobs,
        activeContracts,
        proposalTrends: [],
        topCategories: [],
      });
    }

    if (auth.user.role === "Freelancer") {
      const [jobsApplied, activeContracts] = await Promise.all([
        db.collection("proposals").countDocuments({ freelancerId: auth.user.id }),
        db.collection("contracts").countDocuments({ freelancerId: auth.user.id, status: "active" }),
      ]);

      return json({
        jobsApplied,
        proposalSuccessRate: 0,
        activeContracts,
        avgRating: "-",
        popularCategories: [],
      });
    }

    const [postedJobs, activeContracts, paidCount] = await Promise.all([
      db.collection(process.env.JOB_COLLECTION || "Job").countDocuments({ clientId: auth.user.id }),
      db.collection("contracts").countDocuments({ clientId: auth.user.id, status: "active" }),
      db.collection("payments").countDocuments({ clientId: auth.user.id }),
    ]);

    return json({
      postedJobs,
      activeContracts,
      paidCount,
    });
  } catch (error) {
    return json({ message: "Failed to load dashboard", error: error.message }, 500);
  }
}
