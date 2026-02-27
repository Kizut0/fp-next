import { getDb } from "../../../lib/mongodb";
import { json, options, requireAuth, toObjectId } from "../../../lib/api";

export const dynamic = "force-dynamic";

function buildOwnerCountQuery(userId) {
  const ownerId = String(userId || "").trim();
  if (!ownerId) return { clientId: "__no_owner__" };

  const ownerObjectId = toObjectId(ownerId);
  const clauses = [
    { clientId: ownerId },
    { userId: ownerId },
    { ownerId },
    { createdBy: ownerId },
  ];

  if (ownerObjectId) {
    clauses.push(
      { clientId: ownerObjectId },
      { userId: ownerObjectId },
      { ownerId: ownerObjectId },
      { createdBy: ownerObjectId }
    );
  }

  return { $or: clauses };
}

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const db = await getDb();

    if (auth.user.role === "Admin") {
      const [totalUsers, activeJobs, activeContracts, totalProposals, proposalAgg, categoryAgg, contractAgg] = await Promise.all([
        db.collection(process.env.USER_COLLECTION || "userData").countDocuments({}),
        db.collection(process.env.JOB_COLLECTION || "Job").countDocuments({ status: "open" }),
        db.collection("contracts").countDocuments({ status: "active" }),
        db.collection("proposals").countDocuments({}),
        db.collection("proposals").aggregate([
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
              count: { $sum: 1 }
            }
          },
          { $sort: { _id: -1 } },
          { $limit: 12 }
        ]).toArray(),
        db.collection(process.env.JOB_COLLECTION || "Job").aggregate([
          { $group: { _id: "$category", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 3 }
        ]).toArray(),
        db.collection("contracts").aggregate([
          { $group: { _id: "$status", count: { $sum: 1 } } }
        ]).toArray()
      ]);

      const proposalTrends = proposalAgg.map(p => ({ month: p._id, count: p.count }));
      const topCategories = categoryAgg.map(c => String(c._id || "Uncategorized"));

      let totalContr = 0;
      let completedContr = 0;
      contractAgg.forEach(c => {
        totalContr += c.count;
        if (c._id === "completed") completedContr += c.count;
      });

      return json({
        totalUsers,
        activeJobs,
        activeContracts,
        proposalTrends,
        topCategories,
        contractCompletionRates: {
          total: totalContr,
          completed: completedContr,
          rate: totalContr > 0 ? (completedContr / totalContr) : 0
        },
        platformActivity: { totalUsers, totalJobs: activeJobs, totalProposals }
      });
    }

    if (auth.user.role === "Freelancer") {
      const [jobsApplied, activeContracts, allProposals, myReviews, categoryAgg] = await Promise.all([
        db.collection("proposals").countDocuments({ freelancerId: auth.user.id }),
        db.collection("contracts").countDocuments({ freelancerId: auth.user.id, status: "active" }),
        db.collection("proposals").find({ freelancerId: auth.user.id }).toArray(),
        db.collection("reviews").aggregate([
          { $match: { revieweeId: auth.user.id } },
          { $group: { _id: null, avgRating: { $avg: "$rating" }, count: { $sum: 1 } } }
        ]).toArray(),
        db.collection(process.env.JOB_COLLECTION || "Job").aggregate([
          { $group: { _id: "$category", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 5 }
        ]).toArray(),
      ]);

      const proposalsResultingInContract = allProposals.filter(p => p.status === "accepted").length;
      const proposalSuccessRate = jobsApplied > 0 ? (proposalsResultingInContract / jobsApplied) : 0;

      const reviewStats = myReviews[0] || { avgRating: 0, count: 0 };
      const avgRating = reviewStats.count > 0 ? Number(reviewStats.avgRating).toFixed(1) : "-";

      const popularCategories = categoryAgg.map(c => ({ category: String(c._id || "Other"), count: c.count }));

      return json({
        jobsApplied,
        proposalSuccessRate,
        activeContracts,
        avgRating,
        popularCategories,
      });
    }

    const ownerQuery = buildOwnerCountQuery(auth.user.id);
    const ownerId = String(auth.user.id);

    // Get client's jobs to find associated proposals
    const clientJobs = await db.collection(process.env.JOB_COLLECTION || "Job").find(ownerQuery).toArray();
    const clientJobIds = clientJobs.map(j => String(j._id));

    const [activeContracts, paidCount, proposalsReceivedAgg, trendsAgg] = await Promise.all([
      db.collection("contracts").countDocuments({ clientId: auth.user.id, status: "active" }),
      db.collection("payments").countDocuments({ clientId: auth.user.id }),
      db.collection("proposals").countDocuments({ jobId: { $in: clientJobIds } }),
      db.collection("proposals").aggregate([
        { $match: { jobId: { $in: clientJobIds } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: -1 } },
        { $limit: 6 }
      ]).toArray(),
    ]);

    const postedJobs = clientJobs.length;
    let jobsLeadingToContract = 0;
    clientJobs.forEach(j => {
      // A job leading to contract often has status 'in_progress', 'completed' or has an accepted proposal
      if (["in_progress", "completed"].includes(j.status) || j.acceptedProposalId) {
        jobsLeadingToContract++;
      }
    });

    const hiringSuccessRate = postedJobs > 0 ? (jobsLeadingToContract / postedJobs) : 0;
    const engagementTrends = trendsAgg.map(t => ({ month: t._id, proposals: t.count }));

    return json({
      postedJobs,
      activeContracts,
      paidCount,
      proposalsReceived: proposalsReceivedAgg,
      hiringSuccessRate,
      engagementTrends,
    });
  } catch (error) {
    return json({ message: "Failed to load dashboard", error: error.message }, 500);
  }
}
