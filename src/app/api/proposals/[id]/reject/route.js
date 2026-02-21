import { getDb } from "../../../../../lib/mongodb";
import { json, options, requireAuth, toObjectId } from "../../../../../lib/api";

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
      { $set: { status: "rejected", updatedAt: new Date() } }
    );

    return json({ ok: true });
  } catch (error) {
    return json({ message: "Failed to reject proposal", error: error.message }, 500);
  }
}
