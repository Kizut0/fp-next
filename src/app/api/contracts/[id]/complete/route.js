import { getDb } from "../../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../../lib/api";
import { areAllMilestonesReleased, ensureContractMilestones } from "../../../../../lib/contractMilestones";

export const dynamic = "force-dynamic";

function normalizeContractQuery(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { contractId: id }] };
  return { $or: [{ _id: id }, { contractId: id }] };
}

function canCompleteContract(authUser, contract) {
  if (authUser.role === "Admin") return true;

  const userId = String(authUser.id || "").trim();
  if (!userId) return false;

  const ownerIds = [contract.clientId, contract.userId, contract.ownerId, contract.createdBy, contract.freelancerId]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  return ownerIds.includes(userId);
}

function normalizeText(value, maxLen = 500) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.slice(0, maxLen);
}

function normalizeUrl(value) {
  const raw = normalizeText(value, 1000);
  if (!raw) return "";

  if (/^https?:\/\//i.test(raw)) return raw;
  return "";
}

function normalizeAttachment(input) {
  if (!input || typeof input !== "object") return null;

  const name = normalizeText(input.name, 200);
  const type = normalizeText(input.type, 100);
  const dataUrl = normalizeText(input.dataUrl, 2_500_000);
  const size = Number(input.size || 0);

  if (!name || !dataUrl) return null;
  if (!Number.isFinite(size) || size <= 0 || size > 2_000_000) return null;
  if (!/^data:/i.test(dataUrl)) return null;

  return { name, type, size, dataUrl };
}

function normalizeJobIdVariants(contract) {
  const stringIds = Array.from(
    new Set(
      [contract?.jobId]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );

  const objectIds = stringIds.map((value) => toObjectId(value)).filter(Boolean);
  return [...stringIds, ...objectIds];
}

async function syncCompletedJobStatus(db, contract, now) {
  const idVariants = normalizeJobIdVariants(contract);
  if (!idVariants.length) return;

  const jobs = db.collection(process.env.JOB_COLLECTION || "Job");
  await jobs.updateMany(
    {
      $or: [{ _id: { $in: idVariants } }, { jobId: { $in: idVariants } }],
    },
    { $set: { status: "completed", updatedAt: now } }
  );
}

async function getParamId(params) {
  const resolved = await params;
  return String(resolved?.id || "").trim();
}

export async function OPTIONS(req) {
  return options(req);
}

export async function PATCH(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const rawId = await getParamId(params);
    const query = normalizeContractQuery(rawId);
    if (!query) return json({ message: "Invalid contract id" }, 400, req);

    const db = await getDb();
    const contracts = db.collection("contracts");
    const contract = await contracts.findOne(query);
    if (!contract) return json({ message: "Contract not found" }, 404, req);

    if (!canCompleteContract(auth.user, contract)) {
      return json({ message: "Forbidden" }, 403, req);
    }

    const milestones = ensureContractMilestones(contract);
    if (!areAllMilestonesReleased(milestones)) {
      return json(
        { message: "All milestones must be released before marking contract completed" },
        400,
        req
      );
    }

    let payload = {};
    try {
      payload = await req.json();
    } catch {
      payload = {};
    }

    const deliveryLink = normalizeUrl(payload.deliveryLink);
    const notes = normalizeText(payload.deliveryNotes, 1500);
    const attachment = normalizeAttachment(payload.deliveryAttachment);

    const authId = String(auth.user.id || "").trim();
    const freelancerId = String(contract.freelancerId || "").trim();
    const isFreelancer = auth.user.role === "Freelancer" && authId && freelancerId && authId === freelancerId;
    const canWriteDelivery = isFreelancer || auth.user.role === "Admin";

    const now = new Date();
    const update = {
      status: "completed",
      endDate: contract.endDate || now,
      updatedAt: now,
    };

    if (canWriteDelivery && (deliveryLink || notes || attachment)) {
      update.delivery = {
        link: deliveryLink || "",
        notes: notes || "",
        attachment: attachment || null,
        submittedBy: authId,
        submittedAt: now,
      };
    }

    await contracts.updateOne(
      { _id: contract._id },
      { $set: update }
    );
    await syncCompletedJobStatus(db, contract, now);

    const updated = await contracts.findOne({ _id: contract._id });
    return json(cleanDoc(updated), 200, req);
  } catch (error) {
    return json({ message: "Failed to complete contract", error: error.message }, 500, req);
  }
}
