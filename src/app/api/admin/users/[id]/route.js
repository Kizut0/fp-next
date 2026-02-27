import { getDb } from "../../../../../lib/mongodb";
import { json, options, requireRole, toObjectId } from "../../../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
    return options(req);
}

function normalizeId(value) {
    return String(value || "").trim();
}

function buildIdCandidates(value) {
    const str = normalizeId(value);
    if (!str) return [];
    const objectId = toObjectId(str);
    return objectId ? [str, objectId] : [str];
}

function buildUserReferenceQuery(userDoc = {}, includeSelfObjectId = false) {
    const idValues = new Set();
    buildIdCandidates(userDoc?._id).forEach((item) => idValues.add(item));
    buildIdCandidates(userDoc?.userId).forEach((item) => idValues.add(item));
    buildIdCandidates(userDoc?.id).forEach((item) => idValues.add(item));
    buildIdCandidates(userDoc?.accountId).forEach((item) => idValues.add(item));

    const email = normalizeId(userDoc?.email).toLowerCase();
    const ids = Array.from(idValues);
    const or = [];

    if (ids.length > 0) {
        or.push(
            { clientId: { $in: ids } },
            { freelancerId: { $in: ids } },
            { userId: { $in: ids } },
            { ownerId: { $in: ids } },
            { createdBy: { $in: ids } },
            { reviewerId: { $in: ids } },
            { revieweeId: { $in: ids } },
            { acceptedFreelancerId: { $in: ids } }
        );
        if (includeSelfObjectId) {
            or.push({ _id: { $in: ids } });
        }
    }

    if (email) {
        or.push(
            { email },
            { clientEmail: email },
            { freelancerEmail: email }
        );
    }

    if (!or.length) return { _id: "__no_match__" };
    return { $or: or };
}

async function buildDependencyCounts(db, userDoc) {
    const query = buildUserReferenceQuery(userDoc);
    const jobCollection = process.env.JOB_COLLECTION || "Job";

    const [
        jobs,
        proposals,
        contracts,
        payments,
        reviews,
    ] = await Promise.all([
        db.collection(jobCollection).countDocuments(query),
        db.collection("proposals").countDocuments(query),
        db.collection("contracts").countDocuments(query),
        db.collection("payments").countDocuments(query),
        db.collection("reviews").countDocuments(query),
    ]);

    return {
        jobs,
        proposals,
        contracts,
        payments,
        reviews,
        totalLinkedRecords: jobs + proposals + contracts + payments + reviews,
    };
}

export async function DELETE(req, { params }) {
    const auth = requireRole(req, ["Admin"]);
    if (auth.error) return auth.error;

    try {
        const _id = toObjectId(params.id);
        if (!_id) return json({ message: "Invalid user id" }, 400);

        const db = await getDb();
        const users = db.collection(process.env.USER_COLLECTION || "userData");
        const target = await users.findOne({ _id });
        if (!target) return json({ message: "User not found" }, 404);

        const authUserId = normalizeId(auth?.user?.id);
        const targetUserId = normalizeId(target?._id);
        if (authUserId && targetUserId && authUserId === targetUserId) {
            return json({ message: "Admin cannot archive their own account" }, 409);
        }

        const now = new Date();
        const dependencies = await buildDependencyCounts(db, target);
        const archiveEntry = {
            action: "archive",
            fromStatus: normalizeId(target?.status || "active").toLowerCase() || "active",
            toStatus: "deactive",
            reason: "Archived by admin delete action",
            at: now,
            by: {
                id: normalizeId(auth?.user?.id),
                email: normalizeId(auth?.user?.email).toLowerCase(),
                role: normalizeId(auth?.user?.role || "Admin") || "Admin",
            },
            dependencies,
        };

        await users.updateOne(
            { _id },
            {
                $set: {
                    status: "deactive",
                    archived: true,
                    archivedAt: now,
                    archivedBy: {
                        id: normalizeId(auth?.user?.id),
                        email: normalizeId(auth?.user?.email).toLowerCase(),
                        role: normalizeId(auth?.user?.role || "Admin") || "Admin",
                    },
                    updatedAt: now,
                },
                $push: {
                    moderationAuditLog: archiveEntry,
                },
            }
        );

        return json({
            ok: true,
            action: "archived",
            status: "deactive",
            dependencies,
        });
    } catch (error) {
        return json({ message: "Failed to archive user", error: error.message }, 500);
    }
}
