import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkPrecondition,
  describePreconditionFailure,
  readVerification,
  recordVerification,
  type VerificationRecord,
} from "../../script/phaseGate.js";

const NAMESPACE = "mainnet";

function namespaceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "phase-gate-"));
  mkdirSync(join(dir, NAMESPACE), { recursive: true });
  return dir;
}

const CANONICAL_HASH = `0x${"ab".repeat(32)}`;

function record(
  overrides: Partial<VerificationRecord> = {},
): VerificationRecord {
  return {
    check: "premigration-reconcile",
    chainId: 1,
    blockNumber: "100",
    blockHash: CANONICAL_HASH,
    headBlockNumber: "138",
    headBlockHash: CANONICAL_HASH,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// A chain that agrees with the record, so only the property under test differs.
const canonicalBlockHash = async () => CANONICAL_HASH;

describe("verification records", () => {
  it("round-trips a recorded pass", () => {
    const dir = namespaceDir();
    recordVerification(dir, NAMESPACE, record());

    const read = readVerification(dir, NAMESPACE, "premigration-reconcile");
    expect(read?.blockNumber).toBe("100");
    expect(read?.chainId).toBe(1);
  });

  it("keeps only the latest pass, so a stale one cannot gate anything", () => {
    const dir = namespaceDir();
    recordVerification(dir, NAMESPACE, record({ blockNumber: "100" }));
    recordVerification(dir, NAMESPACE, record({ blockNumber: "200" }));

    expect(
      readVerification(dir, NAMESPACE, "premigration-reconcile")?.blockNumber,
    ).toBe("200");
  });

  it("keeps checks independent of one another", () => {
    const dir = namespaceDir();
    recordVerification(dir, NAMESPACE, record({ check: "a" }));
    recordVerification(dir, NAMESPACE, record({ check: "b" }));

    expect(readVerification(dir, NAMESPACE, "a")).not.toBeNull();
    expect(readVerification(dir, NAMESPACE, "b")).not.toBeNull();
  });

  it("reports no record rather than throwing on a missing namespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-gate-empty-"));
    expect(readVerification(dir, NAMESPACE, "anything")).toBeNull();
  });

  it("treats a corrupt gate file as no record rather than crashing a phase", () => {
    const dir = namespaceDir();
    writeFileSync(join(dir, NAMESPACE, ".verifications.json"), "not json");
    expect(readVerification(dir, NAMESPACE, "anything")).toBeNull();
  });
});

describe("checkPrecondition", () => {
  it("passes when the check ran on this chain", async () => {
    expect(
      await checkPrecondition({
        record: record(),
        chainId: 1,
        currentBlock: 150n,
        canonicalBlockHash,
      }),
    ).toBeNull();
  });

  it("fails when the check never ran", async () => {
    expect(
      await checkPrecondition({
        record: null,
        chainId: 1,
        currentBlock: 150n,
        canonicalBlockHash,
      }),
    ).toEqual({ kind: "missing" });
  });

  it("fails when the check ran against a different chain", async () => {
    expect(
      await checkPrecondition({
        record: record({ chainId: 11155111 }),
        chainId: 1,
        currentBlock: 150n,
        canonicalBlockHash,
      }),
    ).toEqual({ kind: "wrong-chain", recordedChainId: 11155111 });
  });

  it("fails a pass whose observed block is on another branch", async () => {
    // The fork reports chain 1 and a plausible height, so chain id and block number
    // both agree. Only the block hash tells the two apart, and this gate authorises
    // an irreversible freeze.
    const forkHash = `0x${"cd".repeat(32)}`;
    expect(
      await checkPrecondition({
        record: record({ blockHash: forkHash }),
        chainId: 1,
        currentBlock: 150n,
        canonicalBlockHash,
      }),
    ).toEqual({
      kind: "not-canonical",
      verifiedBlock: 100n,
      recordedHash: forkHash,
      canonicalHash: CANONICAL_HASH,
    });
  });

  it("refuses a pass taken against a simulated node", async () => {
    // A rehearsal's pass is recorded so the operator can see it ran, and so a later
    // failure still revokes it — but it describes a fork, not the chain the freeze
    // acts on.
    expect(
      await checkPrecondition({
        record: record({
          simulatedEndpoint: "http://127.0.0.1:8545 is a local endpoint",
        }),
        chainId: 1,
        currentBlock: 150n,
        canonicalBlockHash,
      }),
    ).toEqual({
      kind: "simulated",
      endpoint: "http://127.0.0.1:8545 is a local endpoint",
    });
  });

  it("fails a pass recorded on a fork, whose observed block is canonical", async () => {
    // The case the observed-block hash cannot catch, and the one a rehearsal
    // actually produces: an index built from a source that lags the chain names a
    // block below the fork point, and a fork serves its parent's history unchanged,
    // so that hash is canonical on both chains. The fork's own blocks start at the
    // fork point, so it is the head pair that has no counterpart here.
    const forkHeadHash = `0x${"ef".repeat(32)}`;
    expect(
      await checkPrecondition({
        record: record({ headBlockHash: forkHeadHash }),
        chainId: 1,
        currentBlock: 150n,
        canonicalBlockHash: async (blockNumber) =>
          blockNumber === 100n ? CANONICAL_HASH : `0x${"11".repeat(32)}`,
      }),
    ).toEqual({
      kind: "foreign-head",
      headBlock: 138n,
      recordedHash: forkHeadHash,
      canonicalHash: `0x${"11".repeat(32)}`,
    });
  });

  it("fails a record written before the head pair was carried", async () => {
    // An older record cannot be told apart from a fork's, so it is not accepted for
    // an irreversible step.
    expect(
      await checkPrecondition({
        record: record({ headBlockHash: "" }),
        chainId: 1,
        currentBlock: 150n,
        canonicalBlockHash,
      }),
    ).toEqual({ kind: "unbound" });
  });

  it("fails when the connected chain has no such block", async () => {
    const failure = await checkPrecondition({
      record: record(),
      chainId: 1,
      currentBlock: 150n,
      canonicalBlockHash: async () => null,
    });
    expect(failure?.kind).toBe("not-canonical");
  });

  it("fails a record from a fork advanced past the live head", async () => {
    // No one-sided age comparison catches this: the recorded block is in the
    // chain's future, so it reads as arbitrarily fresh forever.
    expect(
      await checkPrecondition({
        record: record({ blockNumber: "900" }),
        chainId: 1,
        currentBlock: 150n,
        canonicalBlockHash,
        maxAgeBlocks: 100n,
      }),
    ).toEqual({ kind: "ahead", verifiedBlock: 900n, currentBlock: 150n });
  });

  it("fails a record written before the block hash was bound", async () => {
    expect(
      await checkPrecondition({
        record: { ...record(), blockHash: "" },
        chainId: 1,
        currentBlock: 150n,
        canonicalBlockHash,
      }),
    ).toEqual({ kind: "unbound" });
  });

  it("fails when the pass is older than the allowed window", async () => {
    const failure = await checkPrecondition({
      record: record({ blockNumber: "100" }),
      chainId: 1,
      currentBlock: 500n,
      canonicalBlockHash,
      maxAgeBlocks: 100n,
    });
    expect(failure).toEqual({
      kind: "stale",
      verifiedBlock: 100n,
      currentBlock: 500n,
    });
  });

  it("accepts a pass inside the allowed window", async () => {
    expect(
      await checkPrecondition({
        record: record({ blockNumber: "100" }),
        chainId: 1,
        currentBlock: 150n,
        canonicalBlockHash,
        maxAgeBlocks: 100n,
      }),
    ).toBeNull();
  });

  it("explains every failure in terms of what to do next", () => {
    for (const failure of [
      { kind: "missing" } as const,
      { kind: "unbound" } as const,
      { kind: "wrong-chain", recordedChainId: 5 } as const,
      { kind: "ahead", verifiedBlock: 9n, currentBlock: 2n } as const,
      {
        kind: "not-canonical",
        verifiedBlock: 1n,
        recordedHash: "0xaa",
        canonicalHash: "0xbb",
      } as const,
      { kind: "stale", verifiedBlock: 1n, currentBlock: 2n } as const,
    ]) {
      const described = describePreconditionFailure("some-check", failure);
      expect(described).toContain("some-check");
      expect(described.length).toBeGreaterThan(20);
    }
  });
});
