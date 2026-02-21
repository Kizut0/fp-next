import { getDb } from "../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const _id = toObjectId(params.id);
    if (!_id) return json({ message: "Invalid proposal id" }, 400);

    const db = await getDb();
    const proposal = await db.collection("proposals").findOne({ _id });
    if (!proposal) return json({ message: "Proposal not found" }, 404);

    return json(cleanDoc(proposal));
  } catch (error) {
    return json({ message: "Failed to load proposal", error: error.message }, 500);
  }
}

export async function DELETE(req, { params }) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const _id = toObjectId(params.id);
    if (!_id) return json({ message: "Invalid proposal id" }, 400);

    const db = await getDb();
    const proposals = db.collection("proposals");
    const proposal = await proposals.findOne({ _id });
    if (!proposal) return json({ message: "Proposal not found" }, 404);

    const canDelete =
      auth.user.role === "Admin" ||
      proposal.freelancerId === auth.user.id ||
      proposal.clientId === auth.user.id;

    if (!canDelete) {
      return json({ message: "Forbidden" }, 403);
    }

    await proposals.deleteOne({ _id });
    return json({ ok: true });
  } catch (error) {
    return json({ message: "Failed to delete proposal", error: error.message }, 500);
  }
}
