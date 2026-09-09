import { describe, expect, it } from "bun:test";
import { type Address, encodeAbiParameters, type Hex } from "viem";

import { selectResolvableNames } from "../../script/migrate.js";
import {
  dnsEncodeName,
  type JsonDeployment,
  labelId,
} from "../../script/migrations/plumbing.js";
import { V1_GRACE_PERIOD_SECONDS } from "../../script/preMigration.js";

// `addr(bytes32)`. The stubbed resolver answers this one call and refuses the rest,
// which is enough for a name to count as carrying records.
const ADDR_SELECTOR = "0x3b3b57de";

const BASE_REGISTRAR: JsonDeployment = {
  address: "0x0000000000000000000000000000000000000001",
  abi: [],
};
const UNIVERSAL_RESOLVER: Address =
  "0x0000000000000000000000000000000000000002";
const RECORD_ADDRESS: Address = "0x00000000000000000000000000000000000000a1";

const NOW = 1_800_000_000n;
const LIVE = NOW + 86_400n;
// Expired, but the original owner can still renew, so pre-migration reserves it.
const IN_GRACE = NOW - 1n;
// The grace period ends exactly now: the name is released and pre-migration skips it.
const PAST_GRACE = NOW - V1_GRACE_PERIOD_SECONDS;

type Candidate = { expiry: bigint; resolves: boolean };

// Stands in for the two chain clients the sampler reads through, and records which
// candidates reached the resolution probe so a test can prove the ones that did not.
function stubClients(candidates: Record<string, Candidate>) {
  const expiryByLabelId = new Map<string, bigint>();
  const resolvingNames = new Set<Hex>();
  const probed = new Set<Hex>();

  for (const [name, candidate] of Object.entries(candidates)) {
    const label = name.replace(/\.eth$/, "");
    expiryByLabelId.set(labelId(label).toString(), candidate.expiry);
    if (candidate.resolves) resolvingNames.add(dnsEncodeName(name));
  }

  const v1Client = {
    async readContract({ args }: { args: readonly unknown[] }) {
      return expiryByLabelId.get(String(args[0])) ?? 0n;
    },
  };
  const client = {
    async getChainId() {
      return 1;
    },
    async readContract({ args }: { args: readonly unknown[] }) {
      const [encodedName, call] = args as [Hex, Hex];
      probed.add(encodedName);
      if (!resolvingNames.has(encodedName) || !call.startsWith(ADDR_SELECTOR)) {
        throw new Error("no record");
      }
      return [
        encodeAbiParameters([{ type: "address" }], [RECORD_ADDRESS]),
        UNIVERSAL_RESOLVER,
      ];
    },
  };

  return { client, v1Client, probed };
}

async function sample(
  candidates: Record<string, Candidate>,
  limit = 5,
): Promise<{ chosen: string[]; probed: Hex[] }> {
  const { client, v1Client, probed } = stubClients(candidates);
  const chosen = await selectResolvableNames({
    client: client as never,
    universalResolver: UNIVERSAL_RESOLVER,
    candidates: Object.keys(candidates),
    limit,
    v1Client: v1Client as never,
    v1BaseRegistrar: BASE_REGISTRAR,
    v1Now: NOW,
  });
  return { chosen, probed: [...probed] };
}

describe("selectResolvableNames", () => {
  it("keeps a claimable name that carries records", async () => {
    const { chosen } = await sample({
      "live.eth": { expiry: LIVE, resolves: true },
    });
    expect(chosen).toEqual(["live.eth"]);
  });

  it("keeps a name still inside its v1 grace period", async () => {
    // Pre-migration reserves it, so the cutover has to preserve its resolution.
    const { chosen } = await sample({
      "grace.eth": { expiry: IN_GRACE, resolves: true },
    });
    expect(chosen).toEqual(["grace.eth"]);
  });

  it("drops a name past its grace period even though it still resolves", async () => {
    // The regression this guards: v1 keeps serving the records of a released name,
    // but pre-migration will not reserve it, so it has no v2 entry after the
    // cutover. Sampling it puts an expected change into the report whose whole
    // purpose is to show that nothing changed.
    const { chosen } = await sample({
      "released.eth": { expiry: PAST_GRACE, resolves: true },
      "live.eth": { expiry: LIVE, resolves: true },
    });
    expect(chosen).toEqual(["live.eth"]);
  });

  it("drops a name that was never registered on v1", async () => {
    const { chosen } = await sample({
      "unregistered.eth": { expiry: 0n, resolves: true },
      "live.eth": { expiry: LIVE, resolves: true },
    });
    expect(chosen).toEqual(["live.eth"]);
  });

  it("drops a claimable name that carries no records", async () => {
    const { chosen } = await sample({
      "bare.eth": { expiry: LIVE, resolves: false },
      "live.eth": { expiry: LIVE, resolves: true },
    });
    expect(chosen).toEqual(["live.eth"]);
  });

  it("never probes resolution for a name the expiry gate rejects", async () => {
    // The gate runs first so the sample costs one cheap read per released name
    // rather than a full record probe.
    const { probed } = await sample({
      "released.eth": { expiry: PAST_GRACE, resolves: true },
    });
    expect(probed).toEqual([]);
  });

  it("stops at the limit", async () => {
    const { chosen, probed } = await sample(
      {
        "a.eth": { expiry: LIVE, resolves: true },
        "b.eth": { expiry: LIVE, resolves: true },
        "c.eth": { expiry: LIVE, resolves: true },
      },
      2,
    );
    expect(chosen).toEqual(["a.eth", "b.eth"]);
    expect(probed).toEqual([dnsEncodeName("a.eth"), dnsEncodeName("b.eth")]);
  });
});
