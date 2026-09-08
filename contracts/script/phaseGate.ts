// Records which verifications have passed, so a phase can refuse to run before the
// check that is supposed to precede it.
//
// The phases are ordered for a reason — freezing v1 before every claimable name is
// reserved on v2 strands the ones that were missed — but nothing enforces that
// ordering. The runbook says to run the checks; a tired operator at 3am can skip one
// and the next phase proceeds regardless. This turns the runbook's ordering into
// something the tool knows about.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PHASE_GATE_FILE = ".verifications.json";

export type VerificationRecord = {
  check: string;
  chainId: number;
  /** Block the verification observed, so a stale pass can be recognised. */
  blockNumber: string;
  /**
   * Hash of that block, which the check re-reads from the chain it is about to act
   * on. This alone does not separate a fork from the chain it forked from: a fork
   * serves the real chain's history unchanged, so a hash from at or below the fork
   * point is canonical on both. It catches a pass recorded against a different
   * chain, and it is the head pair below that carries the fork.
   */
  blockHash: string;
  /**
   * A block near the chain head when the verification ran, and its hash. A fork
   * diverges from its parent the moment it mines anything, so its recent history is
   * its own — a hash from here is canonical only on the chain that produced it. Held
   * a few confirmations back so an ordinary reorg does not invalidate a good pass.
   */
  headBlockNumber: string;
  headBlockHash: string;
  /**
   * Set when the endpoint that answered the verification was a simulated node. A
   * rehearsal is worth recording — an operator wants to see that it ran, and a later
   * failure must still revoke an earlier pass — but it says nothing about the chain
   * the irreversible step will act on, so the gate refuses it.
   */
  simulatedEndpoint?: string;
  verifiedAt: string;
  details?: Record<string, unknown>;
};

type GateFile = { records: VerificationRecord[] };

function gatePath(deploymentsDir: string, namespace: string): string {
  return join(deploymentsDir, namespace, PHASE_GATE_FILE);
}

function readGate(path: string): GateFile {
  if (!existsSync(path)) return { records: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GateFile;
    return { records: parsed.records ?? [] };
  } catch {
    return { records: [] };
  }
}

// A check records its most recent pass, replacing any earlier one: only the latest
// result can gate anything, and keeping the history would invite reading a stale
// pass as a current one.
export function recordVerification(
  deploymentsDir: string,
  namespace: string,
  record: VerificationRecord,
): void {
  const path = gatePath(deploymentsDir, namespace);
  const dir = join(deploymentsDir, namespace);
  if (!existsSync(dir)) return;

  const gate = readGate(path);
  const records = gate.records.filter((entry) => entry.check !== record.check);
  records.push(record);
  writeFileSync(path, `${JSON.stringify({ records }, null, 2)}\n`, "utf8");
}

// Removes a check's recorded pass.
//
// A verification that later fails must not leave an earlier success standing: the
// gate would then read a stale pass and permit a step the latest evidence says is
// unsafe. Failing to verify has to revoke, not merely decline to renew.
export function clearVerification(
  deploymentsDir: string,
  namespace: string,
  check: string,
): void {
  const path = gatePath(deploymentsDir, namespace);
  if (!existsSync(path)) return;
  const gate = readGate(path);
  const records = gate.records.filter((entry) => entry.check !== check);
  if (records.length === gate.records.length) return;
  writeFileSync(path, `${JSON.stringify({ records }, null, 2)}\n`, "utf8");
}

export function readVerification(
  deploymentsDir: string,
  namespace: string,
  check: string,
): VerificationRecord | null {
  const gate = readGate(gatePath(deploymentsDir, namespace));
  return gate.records.find((entry) => entry.check === check) ?? null;
}

export type PreconditionFailure =
  | { kind: "missing" }
  | { kind: "unbound" }
  | { kind: "simulated"; endpoint: string }
  | { kind: "wrong-chain"; recordedChainId: number }
  | { kind: "ahead"; verifiedBlock: bigint; currentBlock: bigint }
  | {
      kind: "not-canonical";
      verifiedBlock: bigint;
      recordedHash: string;
      canonicalHash: string | null;
    }
  | {
      kind: "foreign-head";
      headBlock: bigint;
      recordedHash: string;
      canonicalHash: string | null;
    }
  | { kind: "stale"; verifiedBlock: bigint; currentBlock: bigint };

// Whether a check's recorded pass still stands for the chain and block in question.
//
// A verification is tied to the block it observed, and three things can be wrong with
// that. The block may not belong to this chain at all — a pass recorded on a fork
// reports the same chain id as the chain it forked from, and this gate authorises an
// irreversible step, so the recorded block hash is looked up on the connected chain
// rather than taken on trust. The block may be ahead of the head, which a fork
// advanced past live time produces and which no height comparison alone rejects. And
// chain state moves, so a pass from far enough back says nothing about now —
// `maxAgeBlocks` is what makes "verified" mean "verified recently" rather than
// "verified once, ever".
export async function checkPrecondition(opts: {
  record: VerificationRecord | null;
  chainId: number;
  currentBlock: bigint;
  canonicalBlockHash: (blockNumber: bigint) => Promise<string | null>;
  maxAgeBlocks?: bigint;
}): Promise<PreconditionFailure | null> {
  if (!opts.record) return { kind: "missing" };
  if (opts.record.chainId !== opts.chainId) {
    return { kind: "wrong-chain", recordedChainId: opts.record.chainId };
  }
  if (opts.record.simulatedEndpoint) {
    return { kind: "simulated", endpoint: opts.record.simulatedEndpoint };
  }
  if (!opts.record.blockHash || !opts.record.headBlockHash) {
    return { kind: "unbound" };
  }

  const verifiedBlock = BigInt(opts.record.blockNumber);
  if (verifiedBlock > opts.currentBlock) {
    return { kind: "ahead", verifiedBlock, currentBlock: opts.currentBlock };
  }

  const canonicalHash = await opts.canonicalBlockHash(verifiedBlock);
  if (
    canonicalHash === null ||
    canonicalHash.toLowerCase() !== opts.record.blockHash.toLowerCase()
  ) {
    return {
      kind: "not-canonical",
      verifiedBlock,
      recordedHash: opts.record.blockHash,
      canonicalHash,
    };
  }

  // The head pair is what separates a fork from its parent. A fork serves the parent's
  // history unchanged, so the index block above is canonical on both; but a fork mines
  // its own blocks from the fork point on, so a hash recorded near its head belongs to
  // no other chain.
  const headBlock = BigInt(opts.record.headBlockNumber);
  const canonicalHeadHash = await opts.canonicalBlockHash(headBlock);
  if (
    canonicalHeadHash === null ||
    canonicalHeadHash.toLowerCase() !== opts.record.headBlockHash.toLowerCase()
  ) {
    return {
      kind: "foreign-head",
      headBlock,
      recordedHash: opts.record.headBlockHash,
      canonicalHash: canonicalHeadHash,
    };
  }

  if (
    opts.maxAgeBlocks !== undefined &&
    opts.currentBlock > verifiedBlock + opts.maxAgeBlocks
  ) {
    return { kind: "stale", verifiedBlock, currentBlock: opts.currentBlock };
  }
  return null;
}

export function describePreconditionFailure(
  check: string,
  failure: PreconditionFailure,
): string {
  switch (failure.kind) {
    case "missing":
      return `${check} has not passed for this deployment; run it first, or pass --skip-preconditions to proceed anyway`;
    case "unbound":
      return `${check} was recorded without a block hash, so it cannot be tied to this chain; re-run it here`;
    case "simulated":
      return `${check} last passed against ${failure.endpoint}, which is a simulated node rather than this chain; re-run it here`;
    case "wrong-chain":
      return `${check} was verified against chain ${failure.recordedChainId}, not this one; re-run it here`;
    case "ahead":
      return `${check} claims block ${failure.verifiedBlock}, ahead of this chain's head ${failure.currentBlock}; it was recorded against a fork, so re-run it here`;
    case "not-canonical":
      return `${check} recorded block ${failure.verifiedBlock} as ${failure.recordedHash}, but this chain has ${failure.canonicalHash ?? "no such block"}; it was recorded against a fork or a reorged branch, so re-run it here`;
    case "foreign-head":
      return `${check} recorded head block ${failure.headBlock} as ${failure.recordedHash}, but this chain has ${failure.canonicalHash ?? "no such block"}; the pass came from a fork of this chain rather than this chain, so re-run it here`;
    case "stale":
      return `${check} last passed at block ${failure.verifiedBlock} and the chain is now at ${failure.currentBlock}; re-run it`;
  }
}
