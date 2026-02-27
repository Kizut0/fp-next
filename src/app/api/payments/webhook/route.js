import crypto from "crypto";
import { getDb } from "../../../../lib/mongodb";
import { cleanDoc, json, options, toObjectId } from "../../../../lib/api";
import {
  ACTIVE_PAYMENT_STATUSES,
  appendEscrowLedgerEntry,
  buildDisputeResolvedState,
  buildIdempotencyEntry,
  buildPaymentContractQuery,
  buildPaymentStatusHistoryEntry,
  canReconcileProviderStatus,
  ensurePaymentLedgerIndexes,
  ensurePaymentIndexes,
  hasIdempotencyKey,
  hasOpenDispute,
  isActivePaymentStatus,
  normalizeDisputeState,
  normalizeId,
  normalizeMilestoneKey,
  normalizePaymentStatus,
} from "../../../../lib/payments";

export const dynamic = "force-dynamic";

function normalizeText(value, maxLen = 1500) {
  return normalizeId(value).slice(0, maxLen);
}

function normalizePaymentQuery(rawId) {
  const id = normalizeId(rawId);
  if (!id) return null;
  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { paymentId: id }] };
  return { $or: [{ _id: id }, { paymentId: id }] };
}

function normalizeProviderName(value) {
  return normalizeText(value, 120);
}

function normalizeProviderPaymentId(value) {
  return normalizeText(value, 180);
}

function normalizeProviderEventId(value) {
  return normalizeText(value, 180);
}

function normalizeProviderEventType(value) {
  return normalizeText(value, 120);
}

function normalizeProviderRawStatus(value) {
  return normalizeText(value, 80);
}

function extractSignature(headerValue) {
  const raw = normalizeId(headerValue);
  if (!raw) return "";
  if (raw.startsWith("sha256=")) return raw.slice("sha256=".length);
  return raw;
}

function secureCompare(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyWebhookSignature(req, rawBody) {
  const sharedSecret = normalizeId(process.env.PAYMENT_WEBHOOK_SECRET);
  const providedSecret = normalizeId(
    req.headers.get("x-payment-webhook-secret") ||
      req.headers.get("x-webhook-secret")
  );
  if (sharedSecret && providedSecret !== sharedSecret) {
    return { ok: false, reason: "invalid_shared_secret" };
  }

  const hmacSecret = normalizeId(process.env.PAYMENT_WEBHOOK_HMAC_SECRET);
  if (!hmacSecret) return { ok: true };

  const providedSig = extractSignature(
    req.headers.get("x-payment-signature") ||
      req.headers.get("x-webhook-signature")
  );
  if (!providedSig) return { ok: false, reason: "missing_signature" };

  const expectedSig = crypto.createHmac("sha256", hmacSecret).update(rawBody).digest("hex");
  if (!secureCompare(providedSig, expectedSig)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true };
}

function resolveTargetStatus({ eventType = "", rawStatus = "", status = "" } = {}) {
  const explicit = normalizePaymentStatus(status || rawStatus, "");
  if (explicit) return explicit;

  const event = normalizeId(eventType).toLowerCase();
  const raw = normalizeId(rawStatus).toLowerCase();
  if (event.includes("refund") || raw.includes("refund")) return "refunded";
  if (event.includes("fail") || raw.includes("fail") || raw.includes("declin")) return "failed";
  if (event.includes("withdraw") || event.includes("payout")) {
    if (raw.includes("fail")) return "failed";
    return "withdrawn";
  }
  if (event.includes("release")) return "released";
  if (event.includes("review")) return "in_review";
  if (
    event.includes("reserve") ||
    event.includes("capture") ||
    event.includes("fund") ||
    event.includes("success") ||
    raw.includes("success")
  ) {
    return "reserved";
  }
  return "";
}

function buildActiveStatusQuery() {
  return {
    $in: [...ACTIVE_PAYMENT_STATUSES, "hold", "pending", "paid", "disputed"],
  };
}

async function findActiveConflict(payments, payment, nextStatus) {
  if (!isActivePaymentStatus(nextStatus)) return null;
  const contractId = normalizeId(payment?.contractId);
  if (!contractId) return null;
  const milestoneKey = normalizeMilestoneKey(payment?.milestoneKey);
  return payments.findOne(
    {
      _id: { $ne: payment._id },
      contractId: { $in: [contractId, toObjectId(contractId)].filter(Boolean) },
      ...(milestoneKey !== "default"
        ? { milestoneKey }
        : {
            $or: [
              { milestoneKey: "default" },
              { milestoneKey: { $exists: false } },
              { milestoneKey: null },
              { milestoneKey: "" },
            ],
          }),
      $or: [{ isActive: true }, { status: buildActiveStatusQuery() }],
    },
    { projection: { _id: 1 } }
  );
}

function normalizePaymentForResponse(payment) {
  const status = normalizePaymentStatus(payment?.status, "") || normalizeId(payment?.status).toLowerCase();
  return {
    ...payment,
    status,
    milestoneKey: normalizeMilestoneKey(payment?.milestoneKey),
    dispute: normalizeDisputeState(payment?.dispute || {}, { now: new Date() }),
    isActive:
      typeof payment?.isActive === "boolean"
        ? payment.isActive
        : isActivePaymentStatus(status),
  };
}

async function resolvePayment(payments, payload) {
  const paymentId = normalizeId(payload.paymentRecordId || payload.paymentId || payload.id);
  if (paymentId) {
    const query = normalizePaymentQuery(paymentId);
    if (query) {
      const byId = await payments.findOne(query);
      if (byId) return byId;
    }
  }

  const providerPaymentId = normalizeProviderPaymentId(
    payload.providerPaymentId || payload.externalPaymentId || payload.processorPaymentId || payload.referenceId
  );
  if (providerPaymentId) {
    const byProvider = await payments.findOne(
      { "provider.paymentId": providerPaymentId },
      { sort: { updatedAt: -1, createdAt: -1 } }
    );
    if (byProvider) return byProvider;
  }

  const milestoneKey = normalizeMilestoneKey(payload.milestoneKey || payload.milestoneId);
  const contractQuery = buildPaymentContractQuery(payload.contractId, milestoneKey);
  if (!contractQuery) return null;

  return payments.findOne(contractQuery, { sort: { updatedAt: -1, createdAt: -1 } });
}

export async function OPTIONS(req) {
  return options(req);
}

export async function POST(req) {
  try {
    const rawBody = await req.text();
    const verify = verifyWebhookSignature(req, rawBody);
    if (!verify.ok) {
      return json({ message: "Webhook verification failed", reason: verify.reason }, 401, req);
    }

    let payload = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return json({ message: "Invalid JSON payload" }, 400, req);
    }

    const provider = normalizeProviderName(payload.provider || payload.providerName || req.headers.get("x-payment-provider"));
    const eventId = normalizeProviderEventId(payload.eventId || payload.webhookId || payload.id);
    const eventType = normalizeProviderEventType(payload.eventType || payload.type || payload.event);
    const rawStatus = normalizeProviderRawStatus(payload.status || payload.rawStatus || payload.result);
    const nextStatus = resolveTargetStatus({ eventType, rawStatus, status: payload.status });
    if (!nextStatus) {
      return json({ ok: true, ignored: "status_not_mapped" }, 202, req);
    }

    const db = await getDb();
    const payments = db.collection("payments");
    const ledger = db.collection(process.env.PAYMENT_LEDGER_COLLECTION || "paymentLedger");
    await ensurePaymentIndexes(payments);
    await ensurePaymentLedgerIndexes(ledger);

    const payment = await resolvePayment(payments, payload);
    if (!payment) {
      return json({ ok: true, ignored: "payment_not_found" }, 202, req);
    }
    if (payment.archived === true) {
      return json({ ok: true, ignored: "payment_archived" }, 202, req);
    }

    const webhookKey = normalizeText(
      payload.idempotencyKey ||
        `webhook:${provider || "provider"}:${eventId || eventType || "event"}:${normalizeId(payment._id)}`,
      140
    );
    if (webhookKey && hasIdempotencyKey(payment, webhookKey)) {
      return json(
        {
          ...cleanDoc(normalizePaymentForResponse(payment)),
          idempotent: true,
        },
        200,
        req
      );
    }

    const currentStatus = normalizePaymentStatus(payment.status, "");
    if (!currentStatus) {
      return json({ message: "Current payment status is invalid" }, 409, req);
    }
    if (!canReconcileProviderStatus(currentStatus, nextStatus)) {
      return json(
        { message: `Invalid provider reconciliation transition: ${currentStatus} -> ${nextStatus}` },
        409,
        req
      );
    }

    const statusChanged = currentStatus !== nextStatus;
    const conflict = await findActiveConflict(payments, payment, nextStatus);
    if (conflict) {
      return json(
        { message: "Only one active payment is allowed per contract/milestone" },
        409,
        req
      );
    }

    const now = new Date();
    const providerPaymentId = normalizeProviderPaymentId(
      payload.providerPaymentId || payload.externalPaymentId || payload.processorPaymentId || payload.referenceId
    );
    const providerPatch = {
      ...(payment.provider && typeof payment.provider === "object" ? payment.provider : {}),
      ...(provider ? { name: provider } : {}),
      ...(providerPaymentId ? { paymentId: providerPaymentId } : {}),
      ...(eventId ? { lastEventId: eventId } : {}),
      ...(eventType ? { lastEventType: eventType } : {}),
      ...(rawStatus ? { rawStatus } : {}),
      reconciledAt: now,
    };

    const updateSet = {
      provider: providerPatch,
      updatedAt: now,
    };

    const reason = normalizeText(
      payload.reason || payload.note || `${provider || "provider"}:${eventType || rawStatus || nextStatus}`,
      1500
    );

    if (statusChanged) {
      updateSet.status = nextStatus;
      updateSet.isActive = isActivePaymentStatus(nextStatus);
    }

    const currentDispute = normalizeDisputeState(payment.dispute || {}, { now });
    if (statusChanged && hasOpenDispute({ ...payment, dispute: currentDispute })) {
      if (nextStatus === "released" || nextStatus === "refunded" || nextStatus === "failed") {
        const resolution = nextStatus === "released" ? "release" : "refund";
        updateSet.dispute = buildDisputeResolvedState({
          previous: currentDispute,
          resolution,
          resolutionNote: normalizeText(
            payload.disputeResolutionNote || payload.note || `Resolved by provider event: ${eventType || nextStatus}`,
            1500
          ),
          resolvedBy: `provider:${provider || "system"}`,
          now,
        });
      }
    }

    const update = {
      $set: updateSet,
      $push: {
        statusHistory: {
          $each: [
            buildPaymentStatusHistoryEntry({
              action: "webhook_reconcile",
              fromStatus: currentStatus,
              toStatus: nextStatus,
              reason,
              actorId: `provider:${provider || "system"}`,
              at: now,
            }),
          ],
          $slice: -120,
        },
      },
    };

    if (webhookKey) {
      update.$push.idempotencyLog = {
        $each: [
          buildIdempotencyEntry({
            key: webhookKey,
            action: "webhook_reconcile",
            fromStatus: currentStatus,
            toStatus: nextStatus,
            actorId: `provider:${provider || "system"}`,
            at: now,
          }),
        ],
        $slice: -120,
      };
    }

    await payments.updateOne(
      {
        _id: payment._id,
        ...(webhookKey ? { "idempotencyLog.key": { $ne: webhookKey } } : {}),
      },
      update
    );

    const updated = await payments.findOne({ _id: payment._id });
    if (!updated) return json({ message: "Payment not found after reconciliation" }, 404, req);

    if (statusChanged) {
      await appendEscrowLedgerEntry(ledger, {
        payment: updated,
        fromStatus: currentStatus,
        toStatus: nextStatus,
        action: "webhook_reconcile",
        reason,
        actorId: `provider:${provider || "system"}`,
        actorRole: "provider",
        source: "provider_webhook",
        idempotencyKey: webhookKey,
        eventId,
        at: now,
        provider: {
          name: provider,
          paymentId: providerPaymentId,
          eventType,
          rawStatus,
          reference: normalizeText(payload.reference || payload.referenceId, 180),
        },
      });
    }

    return json(cleanDoc(normalizePaymentForResponse(updated)), 200, req);
  } catch (error) {
    return json({ message: "Failed to reconcile provider webhook", error: error.message }, 500, req);
  }
}
