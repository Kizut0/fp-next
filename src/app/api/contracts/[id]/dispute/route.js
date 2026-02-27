import { getDb } from "../../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../../lib/api";
import {
  appendDisputeEvidence,
  appendEscrowLedgerEntry,
  buildIdempotencyEntry,
  buildDisputeMediationUpdate,
  buildDisputeOpenState,
  buildDisputeResolvedState,
  buildPaymentStatusHistoryEntry,
  canTransitionPaymentStatus,
  ensurePaymentLedgerIndexes,
  ensurePaymentIndexes,
  hasIdempotencyKey,
  hasOpenDispute,
  isActivePaymentStatus,
  normalizeDisputeStage,
  normalizeDisputeState,
  normalizeIdempotencyKey,
  normalizePaymentStatus,
  resolveDisputeSlaHours,
} from "../../../../../lib/payments";

export const dynamic = "force-dynamic";

const RESOLUTION_DECISIONS = new Set(["release", "refund"]);
const DISPUTE_ACTIONS = new Set(["open", "resolve", "evidence", "mediate"]);
const MEDIATION_STAGE_ACTIONS = new Set(["evidence", "mediation", "decision"]);

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeText(value, maxLen = 1000) {
  return String(value || "").trim().slice(0, maxLen);
}

function normalizeContractQuery(rawId) {
  const id = normalizeId(rawId);
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { contractId: id }] };
  return { $or: [{ _id: id }, { contractId: id }] };
}

function canClientOpenDispute(authUser, contract) {
  if (authUser.role === "Admin") return true;
  if (authUser.role !== "Client") return false;

  const actorId = normalizeId(authUser.id);
  if (!actorId) return false;

  const clientIds = [contract.clientId, contract.userId, contract.ownerId, contract.createdBy]
    .map(normalizeId)
    .filter(Boolean);

  return clientIds.includes(actorId);
}

function canContractParticipant(authUser, contract) {
  if (authUser.role === "Admin") return true;
  const actorId = normalizeId(authUser.id);
  if (!actorId) return false;

  const participants = [
    contract.clientId,
    contract.userId,
    contract.ownerId,
    contract.createdBy,
    contract.freelancerId,
  ]
    .map(normalizeId)
    .filter(Boolean);
  return participants.includes(actorId);
}

function resolvePaymentQuery(contract) {
  const ids = [];
  const seen = new Set();
  const contractIds = [contract?._id, contract?.contractId];

  for (const value of contractIds) {
    const normalized = normalizeId(value);
    if (!normalized) continue;

    const stringKey = `s:${normalized}`;
    if (!seen.has(stringKey)) {
      seen.add(stringKey);
      ids.push(normalized);
    }

    const objectId = toObjectId(normalized);
    if (!objectId) continue;

    const objectIdKey = `o:${String(objectId)}`;
    if (!seen.has(objectIdKey)) {
      seen.add(objectIdKey);
      ids.push(objectId);
    }
  }

  if (!ids.length) return null;
  return { contractId: { $in: ids } };
}

function canOpenByCompletionOrPayment(contract, payment) {
  const completionStatus = normalizeId(contract?.completionRequest?.status).toLowerCase();
  if (["pending", "accepted"].includes(completionStatus)) return true;

  const paymentStatus = normalizePaymentStatus(payment?.status, "");
  return ["reserved", "in_review", "released", "disputed"].includes(paymentStatus);
}

function isResolvableDispute(dispute) {
  return normalizeId(dispute?.status).toLowerCase() === "open";
}

function normalizeNote(value, maxLen = 1500) {
  return normalizeId(value).slice(0, maxLen);
}

function resolveIdempotencyKey(req, payload = {}) {
  return normalizeIdempotencyKey(
    payload.idempotencyKey ||
      req.headers.get("x-idempotency-key") ||
      req.headers.get("idempotency-key")
  );
}

function resolveEvidencePayload(payload = {}) {
  const direct = payload.evidence || payload.evidenceItems || payload.files || payload.links;
  if (Array.isArray(direct)) return direct;
  if (direct && typeof direct === "object") return [direct];

  const out = [];
  const link = normalizeId(payload.evidenceLink || payload.link || payload.url);
  if (link) out.push({ type: "link", url: link });
  const file = payload.evidenceFile || payload.file || payload.attachment;
  if (file && typeof file === "object") out.push(file);
  return out;
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

    const payload = await req.json();
    const action = normalizeId(payload.action).toLowerCase();
    if (!DISPUTE_ACTIONS.has(action)) {
      return json({ message: "Invalid action. Use open, resolve, evidence, or mediate." }, 400, req);
    }

    const db = await getDb();
    const contracts = db.collection("contracts");
    const payments = db.collection("payments");
    const ledger = db.collection(process.env.PAYMENT_LEDGER_COLLECTION || "paymentLedger");
    await ensurePaymentIndexes(payments);
    await ensurePaymentLedgerIndexes(ledger);

    const contract = await contracts.findOne(query);
    if (!contract) return json({ message: "Contract not found" }, 404, req);

    const paymentQuery = resolvePaymentQuery(contract);
    const payment = paymentQuery ? await payments.findOne(paymentQuery, { sort: { createdAt: -1 } }) : null;
    const now = new Date();
    const actorId = normalizeId(auth.user.id);
    const idempotencyKey = resolveIdempotencyKey(req, payload);

    if (idempotencyKey && payment && hasIdempotencyKey(payment, idempotencyKey)) {
      const updatedContract = await contracts.findOne({ _id: contract._id });
      return json(cleanDoc(updatedContract), 200, req);
    }

    const contractDispute = normalizeDisputeState(contract.dispute || {}, { now });
    const paymentDispute = normalizeDisputeState(payment?.dispute || {}, { now });
    const contractOpen = isResolvableDispute(contractDispute);
    const paymentOpen = isResolvableDispute(paymentDispute);
    const openDispute = contractOpen ? contractDispute : paymentOpen ? paymentDispute : null;

    if (action === "open") {
      if (!canClientOpenDispute(auth.user, contract)) {
        return json({ message: "Only client can open dispute" }, 403, req);
      }

      const reason = normalizeText(payload.reason, 1500);
      if (!reason) {
        return json({ message: "reason is required" }, 400, req);
      }

      if (contractOpen) {
        return json({ message: "This contract already has an open dispute" }, 409, req);
      }
      if (hasOpenDispute({ ...payment, dispute: paymentDispute })) {
        return json({ message: "This payment already has an open dispute" }, 409, req);
      }

      if (!canOpenByCompletionOrPayment(contract, payment)) {
        return json({ message: "Dispute can only be opened after submission or during reserved/in-review/released payment states" }, 400, req);
      }

      const paymentStatus = normalizePaymentStatus(payment?.status, "");
      if (["withdrawn", "refunded", "failed"].includes(paymentStatus)) {
        return json({ message: "Cannot open dispute for withdrawn/refunded/failed payment" }, 409, req);
      }

      if (payment?._id && !canTransitionPaymentStatus(paymentStatus, "disputed")) {
        return json(
          { message: `Invalid payment status transition: ${paymentStatus} -> disputed` },
          409,
          req
        );
      }

      const nextDispute = buildDisputeOpenState({
        reason,
        openedBy: actorId,
        now,
        evidence: resolveEvidencePayload(payload),
        stage: normalizeDisputeStage(payload.stage || payload.mediationStage, "evidence"),
        note: normalizeNote(payload.mediationNote || payload.note, 1500),
        slaHours: resolveDisputeSlaHours(payload.slaHours),
      });

      await contracts.updateOne(
        { _id: contract._id },
        { $set: { dispute: nextDispute, updatedAt: now } }
      );

      if (payment?._id) {
        const paymentUpdate = {
          $set: {
            status: "disputed",
            isActive: isActivePaymentStatus("disputed"),
            note: payment.note || "Payment marked disputed by client",
            dispute: nextDispute,
            updatedAt: now,
          },
          $push: {
            statusHistory: {
              $each: [
                buildPaymentStatusHistoryEntry({
                  action: "contract_dispute_open",
                  fromStatus: paymentStatus,
                  toStatus: "disputed",
                  reason,
                  actorId,
                  at: now,
                }),
              ],
              $slice: -120,
            },
          },
        };
        if (idempotencyKey) {
          paymentUpdate.$push.idempotencyLog = {
            $each: [
              buildIdempotencyEntry({
                key: idempotencyKey,
                action: "contract_dispute_open",
                fromStatus: paymentStatus,
                toStatus: "disputed",
                actorId,
                at: now,
              }),
            ],
            $slice: -120,
          };
        }
        await payments.updateOne(
          { _id: payment._id },
          paymentUpdate
        );

        const updatedPayment = await payments.findOne({ _id: payment._id });
        if (updatedPayment) {
          await appendEscrowLedgerEntry(ledger, {
            payment: updatedPayment,
            fromStatus: paymentStatus,
            toStatus: "disputed",
            action: "contract_dispute_open",
            reason,
            actorId,
            actorRole: normalizeId(auth.user.role),
            source: "contract_dispute",
            idempotencyKey,
            at: now,
          });
        }
      }

      const updated = await contracts.findOne({ _id: contract._id });
      return json(cleanDoc(updated), 200, req);
    }

    if (action === "evidence") {
      if (!canContractParticipant(auth.user, contract)) {
        return json({ message: "Only contract participant/admin can add dispute evidence" }, 403, req);
      }
      if (!openDispute) {
        return json({ message: "No open dispute to add evidence" }, 409, req);
      }

      const evidence = resolveEvidencePayload(payload);
      if (!evidence.length) {
        return json({ message: "evidence is required (file/link list)" }, 400, req);
      }

      const note = normalizeNote(payload.note || payload.evidenceNote || "Evidence added");
      const nextDispute = appendDisputeEvidence({
        previous: openDispute,
        evidence,
        actorId,
        note,
        now,
      });

      await contracts.updateOne(
        { _id: contract._id },
        { $set: { dispute: nextDispute, updatedAt: now } }
      );

      if (payment?._id && hasOpenDispute({ ...payment, dispute: paymentDispute })) {
        const currentPaymentStatus = normalizePaymentStatus(payment.status, "");
        const paymentUpdate = {
          $set: {
            dispute: appendDisputeEvidence({
              previous: paymentDispute,
              evidence,
              actorId,
              note,
              now,
            }),
            updatedAt: now,
          },
          $push: {
            statusHistory: {
              $each: [
                buildPaymentStatusHistoryEntry({
                  action: "contract_dispute_evidence",
                  fromStatus: currentPaymentStatus,
                  toStatus: currentPaymentStatus,
                  reason: note,
                  actorId,
                  at: now,
                }),
              ],
              $slice: -120,
            },
          },
        };
        if (idempotencyKey) {
          paymentUpdate.$push.idempotencyLog = {
            $each: [
              buildIdempotencyEntry({
                key: idempotencyKey,
                action: "contract_dispute_evidence",
                fromStatus: currentPaymentStatus,
                toStatus: currentPaymentStatus,
                actorId,
                at: now,
              }),
            ],
            $slice: -120,
          };
        }
        await payments.updateOne({ _id: payment._id }, paymentUpdate);
      }

      const updated = await contracts.findOne({ _id: contract._id });
      return json(cleanDoc(updated), 200, req);
    }

    if (action === "mediate") {
      if (auth.user.role !== "Admin") {
        return json({ message: "Only admin can update mediation stage" }, 403, req);
      }
      if (!openDispute) {
        return json({ message: "No open dispute to mediate" }, 409, req);
      }

      const requestedStage = normalizeId(payload.stage || payload.mediationStage).toLowerCase();
      if (!MEDIATION_STAGE_ACTIONS.has(requestedStage)) {
        return json({ message: "stage must be one of: evidence, mediation, decision" }, 400, req);
      }
      const note = normalizeNote(payload.note || payload.mediationNote || `stage:${requestedStage}`);
      const nextDispute = buildDisputeMediationUpdate({
        previous: openDispute,
        stage: requestedStage,
        note,
        actorId,
        now,
        slaHours:
          payload.slaHours !== undefined
            ? resolveDisputeSlaHours(payload.slaHours)
            : undefined,
      });

      await contracts.updateOne(
        { _id: contract._id },
        { $set: { dispute: nextDispute, updatedAt: now } }
      );

      if (payment?._id && hasOpenDispute({ ...payment, dispute: paymentDispute })) {
        const currentPaymentStatus = normalizePaymentStatus(payment.status, "");
        const paymentUpdate = {
          $set: {
            dispute: buildDisputeMediationUpdate({
              previous: paymentDispute,
              stage: requestedStage,
              note,
              actorId,
              now,
              slaHours:
                payload.slaHours !== undefined
                  ? resolveDisputeSlaHours(payload.slaHours)
                  : undefined,
            }),
            updatedAt: now,
          },
          $push: {
            statusHistory: {
              $each: [
                buildPaymentStatusHistoryEntry({
                  action: "contract_dispute_mediate",
                  fromStatus: currentPaymentStatus,
                  toStatus: currentPaymentStatus,
                  reason: note,
                  actorId,
                  at: now,
                }),
              ],
              $slice: -120,
            },
          },
        };
        if (idempotencyKey) {
          paymentUpdate.$push.idempotencyLog = {
            $each: [
              buildIdempotencyEntry({
                key: idempotencyKey,
                action: "contract_dispute_mediate",
                fromStatus: currentPaymentStatus,
                toStatus: currentPaymentStatus,
                actorId,
                at: now,
              }),
            ],
            $slice: -120,
          };
        }
        await payments.updateOne({ _id: payment._id }, paymentUpdate);
      }

      const updated = await contracts.findOne({ _id: contract._id });
      return json(cleanDoc(updated), 200, req);
    }

    if (auth.user.role !== "Admin") {
      return json({ message: "Only admin can resolve disputes" }, 403, req);
    }

    if (!openDispute) {
      return json({ message: "No open dispute to resolve" }, 400, req);
    }

    const resolution = normalizeId(payload.decision || payload.resolution).toLowerCase();
    if (!RESOLUTION_DECISIONS.has(resolution)) {
      return json({ message: "decision must be one of: release, refund" }, 400, req);
    }

    const resolutionNote = normalizeText(payload.resolutionNote || payload.note, 1500);
    if (!payment?._id) {
      return json({ message: "Cannot resolve dispute without a payment record" }, 404, req);
    }

    const currentPaymentStatus = normalizePaymentStatus(payment.status, "");
    const nextPaymentStatus = resolution === "release" ? "released" : "refunded";
    if (!canTransitionPaymentStatus(currentPaymentStatus, nextPaymentStatus)) {
      return json(
        { message: `Invalid payment status transition: ${currentPaymentStatus} -> ${nextPaymentStatus}` },
        409,
        req
      );
    }

    const nextPaymentDispute = buildDisputeResolvedState({
      previous: paymentOpen ? paymentDispute : openDispute,
      resolution,
      resolutionNote,
      resolvedBy: actorId,
      now,
    });

    const paymentUpdate = {
      $set: {
        status: nextPaymentStatus,
        isActive: isActivePaymentStatus(nextPaymentStatus),
        note:
          resolutionNote ||
          (resolution === "release"
            ? "Released by admin after dispute resolution"
            : "Refunded by admin after dispute resolution"),
        dispute: nextPaymentDispute,
        updatedAt: now,
      },
      $push: {
        statusHistory: {
          $each: [
            buildPaymentStatusHistoryEntry({
              action: "contract_dispute_resolve",
              fromStatus: currentPaymentStatus,
              toStatus: nextPaymentStatus,
              reason: resolutionNote || resolution,
              actorId,
              at: now,
            }),
          ],
          $slice: -120,
        },
      },
    };
    if (idempotencyKey) {
      paymentUpdate.$push.idempotencyLog = {
        $each: [
          buildIdempotencyEntry({
            key: idempotencyKey,
            action: "contract_dispute_resolve",
            fromStatus: currentPaymentStatus,
            toStatus: nextPaymentStatus,
            actorId,
            at: now,
          }),
        ],
        $slice: -120,
      };
    }

    await payments.updateOne({ _id: payment._id }, paymentUpdate);
    const updatedPayment = await payments.findOne({ _id: payment._id });
    if (updatedPayment) {
      await appendEscrowLedgerEntry(ledger, {
        payment: updatedPayment,
        fromStatus: currentPaymentStatus,
        toStatus: nextPaymentStatus,
        action: "contract_dispute_resolve",
        reason: resolutionNote || resolution,
        actorId,
        actorRole: normalizeId(auth.user.role),
        source: "contract_dispute",
        idempotencyKey,
        at: now,
      });
    }

    const contractResolvedDispute = buildDisputeResolvedState({
      previous: openDispute,
      resolution,
      resolutionNote,
      resolvedBy: actorId,
      now,
    });

    await contracts.updateOne(
      { _id: contract._id },
      {
        $set: {
          dispute: contractResolvedDispute,
          updatedAt: now,
        },
      }
    );

    const updated = await contracts.findOne({ _id: contract._id });
    return json(cleanDoc(updated), 200, req);
  } catch (error) {
    return json({ message: "Failed to process dispute", error: error.message }, 500, req);
  }
}
