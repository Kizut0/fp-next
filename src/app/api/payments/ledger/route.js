import { getDb } from "../../../../lib/mongodb";
import { cleanDocs, json, options, requireAuth } from "../../../../lib/api";
import {
  ensurePaymentLedgerIndexes,
  normalizeId,
  normalizeMilestoneKey,
} from "../../../../lib/payments";

export const dynamic = "force-dynamic";

export async function OPTIONS(req) {
  return options(req);
}

export async function GET(req) {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { searchParams } = new URL(req.url);
    const query = {};

    if (auth.user.role === "Client") query.clientId = normalizeId(auth.user.id);
    if (auth.user.role === "Freelancer") query.freelancerId = normalizeId(auth.user.id);

    const paymentId = normalizeId(searchParams.get("paymentId"));
    const contractId = normalizeId(searchParams.get("contractId"));
    const milestoneKey = normalizeId(searchParams.get("milestoneKey") || searchParams.get("milestoneId"));
    const source = normalizeId(searchParams.get("source"));
    const action = normalizeId(searchParams.get("action"));

    if (paymentId) query.paymentId = paymentId;
    if (contractId) query.contractId = contractId;
    if (milestoneKey) query.milestoneKey = normalizeMilestoneKey(milestoneKey);
    if (source) query.source = source;
    if (action) query.action = action;

    const limitRaw = Number(searchParams.get("limit") || 200);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.floor(limitRaw), 1), 1000)
      : 200;

    const db = await getDb();
    const ledger = db.collection(process.env.PAYMENT_LEDGER_COLLECTION || "paymentLedger");
    await ensurePaymentLedgerIndexes(ledger);

    const items = await ledger
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return json(cleanDocs(items), 200, req);
  } catch (error) {
    return json({ message: "Failed to load payment ledger", error: error.message }, 500, req);
  }
}
