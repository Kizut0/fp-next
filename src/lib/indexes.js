let userIndexesReady = false;
let proposalIndexesReady = false;
let reviewIndexesReady = false;
let contractIndexesReady = false;

export function isDuplicateKeyError(error) {
  const code = Number(error?.code || 0);
  const codeName = String(error?.codeName || "").trim();
  return code === 11000 || codeName === "DuplicateKey";
}

export async function ensureUserIndexes(users) {
  if (userIndexesReady) return;

  await users.createIndex(
    { email: 1 },
    {
      unique: true,
      partialFilterExpression: { email: { $type: "string" } },
    }
  );

  userIndexesReady = true;
}

export async function ensureProposalIndexes(proposals) {
  if (proposalIndexesReady) return;

  await proposals.createIndex(
    { jobId: 1, freelancerId: 1 },
    {
      unique: true,
      partialFilterExpression: { status: { $in: ["submitted", "accepted"] } },
    }
  );

  proposalIndexesReady = true;
}

export async function ensureReviewIndexes(reviews) {
  if (reviewIndexesReady) return;

  await reviews.createIndex(
    { contractId: 1, reviewerId: 1, revieweeId: 1 },
    { unique: true }
  );

  reviewIndexesReady = true;
}

export async function ensureContractIndexes(contracts) {
  if (contractIndexesReady) return;

  await contracts.createIndex(
    { proposalId: 1 },
    {
      unique: true,
      partialFilterExpression: { proposalId: { $exists: true, $ne: null } },
    }
  );

  contractIndexesReady = true;
}

