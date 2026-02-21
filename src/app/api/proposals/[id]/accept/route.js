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
    if (!_id) return json({ message: "Invalid proposal id" }, 400);

    const db = await getDb();
    const proposals = db.collection("proposals");
    const proposal = await proposals.findOne({ _id });

    if (!proposal) return json({ message: "Proposal not found" }, 404);
    if (auth.user.role !== "Admin" && proposal.clientId !== auth.user.id) {
      return json({ message: "Forbidden" }, 403);
    }

    await proposals.updateOne(
      { _id },
      { $set: { status: "accepted", updatedAt: new Date() } }
    );

    const contracts = db.collection("contracts");
    const existingContract = await contracts.findOne({ proposalId: proposal._id });
    let contract = existingContract;

    if (!existingContract) {
      const contractDoc = {
        proposalId: proposal._id,
        jobId: proposal.jobId,
        clientId: proposal.clientId,
        freelancerId: proposal.freelancerId,
        amount: proposal.price,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const inserted = await contracts.insertOne(contractDoc);
      contract = { ...contractDoc, _id: inserted.insertedId };
    }

    return json({ ok: true, contract: cleanDoc(contract) });
  } catch (error) {
    return json({ message: "Failed to accept proposal", error: error.message }, 500);
  }
}
