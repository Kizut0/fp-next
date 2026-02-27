import { getDb } from "../../../../../lib/mongodb";
import { cleanDoc, json, options, requireAuth, toObjectId } from "../../../../../lib/api";
import {
  buildContractCompletionRequest,
  buildMilestoneSummary,
  ensureContractMilestones,
  findMilestoneByKey,
  hydrateMilestonesWithSla,
  normalizeMilestoneEscalations,
} from "../../../../../lib/contractMilestones";

export const dynamic = "force-dynamic";

const ACTIONS = new Set(["open", "resolve", "cancel"]);
const ESCALATION_STATUS_SET = new Set(["open", "resolved", "cancelled"]);
const ESCALATION_LEVEL_SET = new Set(["warning", "critical"]);

function normalizeContractQuery(rawId) {
  const id = String(rawId || "").trim();
  if (!id) return null;

  const objectId = toObjectId(id);
  if (objectId) return { $or: [{ _id: objectId }, { _id: id }, { contractId: id }] };
  return { $or: [{ _id: id }, { contractId: id }] };
}

function normalizeText(value, maxLen = 500) {
  return String(value || "").trim().slice(0, maxLen);
}

function normalizeEscalationLevel(value, fallback = "warning") {
  const normalized = String(value || "").trim().toLowerCase();
  if (ESCALATION_LEVEL_SET.has(normalized)) return normalized;
  return ESCALATION_LEVEL_SET.has(fallback) ? fallback : "warning";
}

function normalizeEscalationStatus(value, fallback = "open") {
  const normalized = String(value || "").trim().toLowerCase();
  if (ESCALATION_STATUS_SET.has(normalized)) return normalized;
  return ESCALATION_STATUS_SET.has(fallback) ? fallback : "open";
}

function normalizeActor(user = {}) {
  return {
    id: normalizeText(user.id, 120),
    role: normalizeText(user.role, 40),
    email: normalizeText(user.email, 200).toLowerCase(),
    name: normalizeText(user.name, 120),
  };
}

function actorIdFromEscalation(escalation = {}) {
  const openedBy = escalation?.openedBy;
  if (openedBy && typeof openedBy === "object") return normalizeText(openedBy.id, 120);
  return normalizeText(openedBy, 120);
}

function canAccessContract(authUser, contract) {
  if (authUser.role === "Admin") return true;

  const userId = normalizeText(authUser.id, 120);
  if (!userId) return false;

  const ownerIds = [contract.clientId, contract.userId, contract.ownerId, contract.createdBy, contract.freelancerId]
    .map((v) => normalizeText(v, 120))
    .filter(Boolean);

  return ownerIds.includes(userId);
}

function isClientOwner(authUser, contract) {
  if (authUser.role === "Admin") return true;
  if (authUser.role !== "Client") return false;

  const userId = normalizeText(authUser.id, 120);
  if (!userId) return false;

  const clientIds = [contract.clientId, contract.userId, contract.ownerId, contract.createdBy]
    .map((value) => normalizeText(value, 120))
    .filter(Boolean);
  return clientIds.includes(userId);
}

function isFreelancerOwner(authUser, contract) {
  if (authUser.role !== "Freelancer") return false;
  const userId = normalizeText(authUser.id, 120);
  const freelancerId = normalizeText(contract.freelancerId, 120);
  return Boolean(userId && freelancerId && userId === freelancerId);
}

function canOpenEscalation(authUser, contract) {
  return authUser.role === "Admin" || isClientOwner(authUser, contract) || isFreelancerOwner(authUser, contract);
}

function canResolveEscalation(authUser, contract) {
  return authUser.role === "Admin" || isClientOwner(authUser, contract);
}

function canCancelEscalation(authUser, contract, escalation) {
  if (authUser.role === "Admin") return true;
  if (isClientOwner(authUser, contract)) return true;
  return normalizeText(authUser.id, 120) === actorIdFromEscalation(escalation);
}

function createEscalationId() {
  return `esc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeContractForResponse(contract) {
  const escalations = normalizeMilestoneEscalations(contract?.escalations);
  const milestones = hydrateMilestonesWithSla(ensureContractMilestones(contract), {
    escalations,
  });
  const changeOrders = Array.isArray(contract?.changeOrders) ? contract.changeOrders : [];
  return {
    ...contract,
    milestones,
    milestoneSummary: buildMilestoneSummary(milestones, { escalations }),
    completionRequest: buildContractCompletionRequest(
      milestones,
      contract?.completionRequest?.milestoneKey
    ),
    escalations,
    changeOrders,
  };
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
    const action = normalizeText(payload?.action, 40).toLowerCase();
    if (!ACTIONS.has(action)) {
      return json({ message: "Invalid action. Use open, resolve, or cancel." }, 400, req);
    }

    const db = await getDb();
    const contracts = db.collection("contracts");
    const contract = await contracts.findOne(query);
    if (!contract) return json({ message: "Contract not found" }, 404, req);
    if (!canAccessContract(auth.user, contract)) return json({ message: "Forbidden" }, 403, req);

    const now = new Date();
    const actor = normalizeActor(auth.user);
    const contractStatus = String(contract.status || "active").toLowerCase();
    const escalations = normalizeMilestoneEscalations(contract?.escalations);
    const baseMilestones = ensureContractMilestones(contract);
    const milestones = hydrateMilestonesWithSla(baseMilestones, { escalations, now });

    if (action === "open") {
      if (contractStatus !== "active") {
        return json({ message: "Escalation is only allowed on active contracts" }, 409, req);
      }
      if (!canOpenEscalation(auth.user, contract)) {
        return json({ message: "Only assigned freelancer/client/admin can open escalation" }, 403, req);
      }

      const milestoneKey = normalizeText(payload?.milestoneKey || payload?.milestoneId, 120);
      const selected = findMilestoneByKey(milestones, milestoneKey);
      if (!selected?.milestone) return json({ message: `Milestone not found: ${milestoneKey}` }, 404, req);

      const milestone = selected.milestone;
      const milestoneStatus = String(milestone.status || "pending").toLowerCase();
      if (milestoneStatus === "released" || milestoneStatus === "cancelled") {
        return json({ message: "Cannot escalate released/cancelled milestone" }, 409, req);
      }

      const sla = milestone?.sla || {};
      if (!sla.isOverdue) {
        return json({ message: "Escalation is only allowed for overdue milestones" }, 409, req);
      }

      const hasOpen = escalations.some(
        (item) =>
          item.milestoneKey === selected.key && normalizeEscalationStatus(item.status, "open") === "open"
      );
      if (hasOpen) {
        return json({ message: "An open escalation already exists for this milestone" }, 409, req);
      }

      const reason = normalizeText(payload?.reason, 1500);
      if (reason.length < 10) {
        return json({ message: "reason must be at least 10 characters" }, 400, req);
      }

      const level = normalizeEscalationLevel(
        payload?.level,
        String(sla.breachLevel || "").toLowerCase() === "critical" ? "critical" : "warning"
      );

      const nextEscalations = [
        ...escalations,
        {
          id: createEscalationId(),
          milestoneKey: selected.key,
          status: "open",
          level,
          reason,
          resolutionNote: "",
          openedBy: actor,
          openedAt: now,
          resolvedBy: null,
          resolvedAt: null,
          updatedAt: now,
        },
      ];

      await contracts.updateOne(
        { _id: contract._id },
        {
          $set: {
            escalations: nextEscalations,
            milestoneSummary: buildMilestoneSummary(baseMilestones, {
              escalations: nextEscalations,
              now,
            }),
            completionRequest: buildContractCompletionRequest(
              baseMilestones,
              contract?.completionRequest?.milestoneKey
            ),
            updatedAt: now,
          },
        }
      );

      const updated = await contracts.findOne({ _id: contract._id });
      return json(cleanDoc(normalizeContractForResponse(updated)), 200, req);
    }

    const escalationId = normalizeText(payload?.escalationId || payload?.id, 120);
    if (!escalationId) return json({ message: "escalationId is required" }, 400, req);

    const escalationIndex = escalations.findIndex((item) => normalizeText(item.id, 120) === escalationId);
    if (escalationIndex < 0) return json({ message: "Escalation not found" }, 404, req);

    const currentEscalation = escalations[escalationIndex];
    if (normalizeEscalationStatus(currentEscalation.status, "open") !== "open") {
      return json({ message: "Only open escalation can be processed" }, 409, req);
    }

    if (action === "resolve" && !canResolveEscalation(auth.user, contract)) {
      return json({ message: "Only client/admin can resolve escalation" }, 403, req);
    }
    if (action === "cancel" && !canCancelEscalation(auth.user, contract, currentEscalation)) {
      return json({ message: "Only escalation opener/client/admin can cancel escalation" }, 403, req);
    }

    const resolutionNote = normalizeText(payload?.resolutionNote || payload?.note, 1500);
    const nextEscalations = [...escalations];
    nextEscalations[escalationIndex] = {
      ...currentEscalation,
      status: action === "resolve" ? "resolved" : "cancelled",
      resolutionNote,
      resolvedBy: actor,
      resolvedAt: now,
      updatedAt: now,
    };

    await contracts.updateOne(
      { _id: contract._id },
      {
        $set: {
          escalations: nextEscalations,
          milestoneSummary: buildMilestoneSummary(baseMilestones, {
            escalations: nextEscalations,
            now,
          }),
          completionRequest: buildContractCompletionRequest(
            baseMilestones,
            contract?.completionRequest?.milestoneKey
          ),
          updatedAt: now,
        },
      }
    );

    const updated = await contracts.findOne({ _id: contract._id });
    return json(cleanDoc(normalizeContractForResponse(updated)), 200, req);
  } catch (error) {
    return json({ message: "Failed to process escalation action", error: error.message }, 500, req);
  }
}
