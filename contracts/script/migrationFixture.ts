#!/usr/bin/env bun
/// Weighted ENSv1 migration fixture.
///
/// Registers the weighted migration corpus on ENSv1, shapes each name into the
/// exact pre-migration state its scenario specifies, and emits the label list
/// the pre-migration CLI reserves on v2 alongside the real registration export.
/// See docs/migration.md.

import { Command } from "commander";
import {
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  namehash,
  stringToHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Artifact_MigrationFixtureBatcher } from "generated/artifacts/MigrationFixtureBatcher.js";
import { Artifact_CustomResolver } from "generated/artifacts/CustomResolver.js";
import { Artifact_UnsupportedResolver } from "generated/artifacts/UnsupportedResolver.js";
import { Artifact_ERC1155ReceiverOwner } from "generated/artifacts/ERC1155ReceiverOwner.js";
import { Artifact_NonReceiverOwner } from "generated/artifacts/NonReceiverOwner.js";
import { Artifact_CustomSubregistry } from "generated/artifacts/CustomSubregistry.js";

import {
  accounts,
  bufferedGas,
  clients,
  fixtureDigest,
  loadDotEnv,
  loadFixture,
  networkChain,
  optionalV1Deployment,
  parseNumber,
  readJson,
  receipt,
  rpc,
  runStatePath,
  v1Deployment,
  v2Deployment,
  withPriceBuffer,
} from "./migrationFixture/config.js";
import { verifySeededV1State } from "./migrationFixture/verifyV1.js";
import { resolveRegistrarControlRoute } from "./registrarControl.js";
import {
  executionScenario,
  expectedResult,
  migrationRoute,
  preMigrationOwnerAlias,
  wrapperState,
  type RefContext,
} from "./migrationFixture/scenario.js";
import {
  planSetupSteps,
  tokenIdOf,
  type PlanContext,
  type PlannedCall,
} from "./migrationFixture/plan.js";
import {
  actorsNeedingHelperApproval,
  buildHelperArgs,
  migrationTarget,
  partitionMigration,
} from "./migrationFixture/migrate.js";
import {
  executePlannedCalls,
  fundActors,
  assertStateControls,
  impersonateAccount,
  type Executor,
} from "./migrationFixture/execute.js";
import {
  type CommonOptions,
  type FixtureEnvelope,
  type FixtureRunName,
  type FixtureRunState,
  type FixtureActor,
} from "./migrationFixture/types.js";

/// The corpus's counterparty contracts. `v1Args` names the v1 deployments each
/// constructor takes, in order.

const FIXTURE_ARTIFACTS = [
  {
    name: "CustomResolver",
    artifact: Artifact_CustomResolver,
    v1Args: ["ENSRegistry", "NameWrapper"],
  },
  {
    name: "UnsupportedResolver",
    artifact: Artifact_UnsupportedResolver,
    v1Args: [],
  },
  {
    name: "ERC1155ReceiverOwner",
    artifact: Artifact_ERC1155ReceiverOwner,
    v1Args: [],
  },
  { name: "NonReceiverOwner", artifact: Artifact_NonReceiverOwner, v1Args: [] },
  {
    name: "CustomSubregistry",
    artifact: Artifact_CustomSubregistry,
    v1Args: [],
  },
] as const;

function v1Addresses(opts: CommonOptions) {
  return {
    base: v1Deployment(opts, "BaseRegistrarImplementation"),
    registry: v1Deployment(opts, "ENSRegistry"),
    wrapper: v1Deployment(opts, "NameWrapper"),
    controller: v1Deployment(opts, "ETHRegistrarController"),
    publicResolver: v1Deployment(opts, "PublicResolver"),
    reverseRegistrar: v1Deployment(opts, "ReverseRegistrar"),
    defaultReverse: optionalV1Deployment(opts, "DefaultReverseRegistrar"),
  };
}

function refContext(
  opts: CommonOptions,
  fixtureContracts: Record<string, Address>,
): RefContext {
  return {
    actors: new Map(accounts(opts).map((a) => [a.alias, a.account.address])),
    fixtureContracts,
    v1Address: (name) => v1Deployment(opts, name).address,
    v2Address: (name) => v2Deployment(opts, name).address,
  };
}

function planContext(
  opts: CommonOptions,
  fixtureContracts: Record<string, Address>,
  batcher: Address,
): PlanContext {
  const v1 = v1Addresses(opts);
  return {
    ...refContext(opts, fixtureContracts),
    batcher,
    addresses: {
      baseRegistrar: v1.base.address,
      registry: v1.registry.address,
      wrapper: v1.wrapper.address,
      controller: v1.controller.address,
      publicResolver: v1.publicResolver.address,
      reverseRegistrar: v1.reverseRegistrar.address,
      defaultReverseRegistrar:
        v1.defaultReverse?.address ?? v1.reverseRegistrar.address,
    },
  };
}

const PRIOR_RENEWER_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "transferRegistrarOwnership",
    stateMutability: "nonpayable",
    inputs: [{ type: "address", name: "newOwner" }],
    outputs: [],
  },
] as const;

async function ownerWallet(opts: CommonOptions, owner: Address) {
  const chain = networkChain(opts.network, opts.rpcUrl, opts.chainId);
  // Re-enabling the v1 controller can need more than one signer: the registrar
  // owner, and — on an already-migrated chain — whoever owns the contract now
  // holding registrar ownership. A configured key is used only for the account
  // it actually controls, so a mismatch falls through to impersonation rather
  // than failing a run that never needed the key.
  const key =
    opts.v1OwnerKey ??
    (process.env.SEPOLIA_V1_OWNER_KEY as Hex | undefined) ??
    (process.env.V1_OWNER_KEY as Hex | undefined);
  if (key) {
    const account = privateKeyToAccount(key);
    if (getAddress(account.address) === getAddress(owner)) {
      return createWalletClient({
        chain,
        account,
        transport: http(opts.rpcUrl),
      });
    }
    if (!opts.rpcStateControls) {
      throw new Error(
        `V1 owner key controls ${account.address}, but ${owner} must sign`,
      );
    }
  }
  if (!opts.rpcStateControls)
    throw new Error(`missing V1 owner key for ${owner}`);
  await impersonateAccount(opts, owner);
  return createWalletClient({
    chain,
    account: owner,
    transport: http(opts.rpcUrl),
  });
}

/// Ensures the official v1 controller can register.
///
/// On a chain whose registrations are still open this is a read-only no-op. It
/// only acts on a rehearsal or re-deploy where an earlier migration disabled
/// the controller, and needs the v1 owner key to undo that.
async function ensureV1ControllerEnabled(opts: CommonOptions): Promise<void> {
  const { client } = clients(opts);
  const base = v1Deployment(opts, "BaseRegistrarImplementation");
  const controller = v1Deployment(opts, "ETHRegistrarController");

  const enabled = (await client.readContract({
    address: base.address,
    abi: base.abi,
    functionName: "controllers",
    args: [controller.address],
  })) as boolean;
  if (enabled) return;

  const configured =
    opts.v1Owner ??
    (process.env.MIGRATION_FIXTURE_V1_OWNER as Address | undefined);
  if (!configured) {
    throw new Error(
      "v1 ETHRegistrarController is not authorised and no --v1-owner was supplied; " +
        "seed before phase 3, or pass the v1 owner to re-enable it",
    );
  }
  const v1Owner = getAddress(configured);
  let currentOwner = getAddress(
    (await client.readContract({
      address: base.address,
      abi: base.abi,
      functionName: "owner",
    })) as Address,
  );

  if (currentOwner !== v1Owner) {
    // A completed migration hands registrar ownership to its renewer contract,
    // whose own owner can hand it back. Against an EOA this read reverts, which
    // is the right outcome: it means --v1-owner does not match the chain.
    const priorOwner = getAddress(
      (await client.readContract({
        address: currentOwner,
        abi: PRIOR_RENEWER_ABI,
        functionName: "owner",
      })) as Address,
    );
    const wallet = await ownerWallet(opts, priorOwner);
    const hash = await wallet.writeContract({
      address: currentOwner,
      abi: PRIOR_RENEWER_ABI,
      functionName: "transferRegistrarOwnership",
      args: [v1Owner],
    });
    await receipt(client, hash, "reclaim v1 registrar ownership");
    currentOwner = v1Owner;
  }

  // The security controller only works while it still owns the registrar, so the
  // route follows the registrar's live owner rather than the artifact's presence.
  const route = await resolveRegistrarControlRoute({
    client,
    baseRegistrar: base,
    registrarSecurityController: optionalV1Deployment(
      opts,
      "RegistrarSecurityController",
    ),
    owner: currentOwner,
  });
  const routeOwner = getAddress(
    (await client.readContract({
      address: route.target.address,
      abi: route.target.abi,
      functionName: "owner",
    })) as Address,
  );
  const wallet = await ownerWallet(opts, routeOwner);
  const hash = await wallet.writeContract({
    address: route.target.address,
    abi: route.target.abi,
    functionName: route.addFunctionName,
    args: [controller.address],
  });
  await receipt(client, hash, "enable v1 registrar controller");
}

async function deployBatcher(opts: CommonOptions): Promise<Address> {
  const { client, wallet, account } = clients(opts);
  const controller = v1Deployment(opts, "ETHRegistrarController");
  const hash = await wallet.deployContract({
    abi: Artifact_MigrationFixtureBatcher.abi,
    bytecode: Artifact_MigrationFixtureBatcher.bytecode,
    args: [controller.address, account.address],
  });
  const r = await receipt(client, hash, "deploy MigrationFixtureBatcher");
  if (!r.contractAddress)
    throw new Error("batcher deployment had no contract address");
  return getAddress(r.contractAddress);
}

async function deployFixtureContracts(
  opts: CommonOptions,
  existing: Record<string, Address>,
): Promise<Record<string, Address>> {
  const { client, wallet } = clients(opts);
  const out: Record<string, Address> = { ...existing };
  for (const { name, artifact, v1Args } of FIXTURE_ARTIFACTS) {
    if (out[name]) continue;
    const hash = await wallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: v1Args.map((n) => v1Deployment(opts, n).address) as never,
    });
    const r = await receipt(client, hash, `deploy ${name}`);
    if (!r.contractAddress)
      throw new Error(`${name} deployment had no address`);
    out[name] = getAddress(r.contractAddress);
    console.log(`  ${name}: ${out[name]}`);
  }
  return out;
}

const deterministicSecret = (fixtureId: string): Hex =>
  keccak256(stringToHex(`ens-migration-fixture:${fixtureId}`));

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size)
    out.push(values.slice(i, i + size));
  return out;
}

async function waitCommitmentAge(
  opts: CommonOptions,
  seconds: bigint,
): Promise<void> {
  if (seconds <= 0n) return;
  if (opts.rpcStateControls) {
    await rpc(opts, "evm_increaseTime", [Number(seconds)]);
    await rpc(opts, "evm_mine", []);
    return;
  }
  const deadline = Date.now() + Number(seconds + 1n) * 1000;
  while (Date.now() < deadline)
    await sleep(Math.min(5000, deadline - Date.now()));
}

function loadRunState(opts: CommonOptions): FixtureRunState | null {
  const path = runStatePath(opts);
  return existsSync(path) ? readJson<FixtureRunState>(path) : null;
}

/// Rejects run state that describes a different run.
///
/// The state carries a batcher, deployed counterparty contracts and the set of
/// names already seeded. Reusing a work directory across chains, corpora or
/// actor mnemonics would spend against addresses from the other run and treat
/// names it never registered as already done, so the mismatch is refused before
/// any write rather than surfacing as a failed check much later.
///
/// The recorded digest is not compared: it describes the last selection, and
/// seeding a wider selection into a work directory is how a run grows.
function assertRunStateCompatible(
  opts: CommonOptions,
  state: FixtureRunState,
  chainId: number,
  actors: FixtureActor[],
): void {
  const mismatches: string[] = [];
  if (state.version !== 2)
    mismatches.push(`run state version ${state.version}, expected 2`);
  if (state.chainId !== chainId)
    mismatches.push(`chain ${state.chainId}, now ${chainId}`);
  const fixtureRoot = resolve(opts.fixtureRoot);
  if (state.fixtureRoot !== fixtureRoot)
    mismatches.push(`corpus ${state.fixtureRoot}, now ${fixtureRoot}`);
  for (const actor of actors) {
    const recorded = state.actorAddresses[actor.alias];
    if (recorded && getAddress(recorded) !== getAddress(actor.account.address))
      mismatches.push(
        `actor ${actor.alias} ${recorded}, now ${actor.account.address}`,
      );
  }
  if (!mismatches.length) return;
  throw new Error(
    `${runStatePath(opts)} belongs to a different run: ${mismatches.join("; ")}; ` +
      "use a fresh --work-dir",
  );
}

function saveRunState(opts: CommonOptions, state: FixtureRunState): void {
  state.updatedAt = new Date().toISOString();
  writeFileSync(runStatePath(opts), `${JSON.stringify(state, null, 2)}\n`);
}

/// Columns of the emitted label list. It leads with `labelName`, the column
/// preMigration.ts locates by name, so the file feeds the pre-migration CLI
/// with no transformation; the rest are diagnostic and ignored downstream.
const FIXTURE_CSV_HEADER =
  "labelName,fixtureId,reservationState,sourceScenarioId,replicaIndex,popularityTier";

/// Writes the label list the pre-migration phases reserve on v2.
///
/// Derived from the corpus rather than shipped beside it: every column restates
/// a field of the envelope, so a separate file is one more thing that can fall
/// out of step with the scenarios it describes. Only names whose v2
/// pre-migration profile is `present` are listed — the rest model names that are
/// deliberately absent, already registered, or expired on v2, and reserving them
/// would defeat the case they exist to cover.
function writePremigrationCsv(
  opts: CommonOptions,
  rows: FixtureEnvelope[],
  state: FixtureRunState,
): { path: string; labels: string[] } {
  const seeded = new Set(state.names.map((n) => n.fixtureId));
  const labels: string[] = [];
  const output = [FIXTURE_CSV_HEADER];
  for (const row of rows) {
    if (!seeded.has(row.fixture_id)) continue;
    const profile = row.scenario.v2_premigration?.profile;
    if (profile !== "present") continue;
    labels.push(row.label);
    output.push(
      [
        row.label,
        row.fixture_id,
        profile,
        row.source_scenario_id,
        row.replica_index,
        row.popularity_tier,
      ].join(","),
    );
  }
  const path = join(resolve(opts.workDir), "fixture-premigration.csv");
  writeFileSync(path, `${output.join("\n")}\n`);
  return { path, labels };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Offline validation: parses the corpus, checks the replica contract, and
/// plans every scenario's setup calls so an unsupported action or unresolvable
/// reference surfaces before anything touches a chain.
/// Shortest lease the v1 registration controller accepts.
const MIN_REGISTRATION_SECONDS = 28 * 24 * 60 * 60;

/// Scenario features seeding knows how to establish.
///
/// The corpus describes more states than the seeder builds. Every scenario the
/// public-testnet cohort selects sits inside these, and the rest — expiries that
/// need a controlled clock, v2 states that need a name already registered there,
/// leases below the controller's minimum — would otherwise be registered fresh
/// and then verified against assertions that never mention what is missing. That
/// reads as a pass, so the selection is refused instead.
const SEEDABLE_CLOCKS = new Set(["none"]);
const SEEDABLE_EXPIRY_COHORTS = new Set(["long", "minimum"]);
const SEEDABLE_V2_PROFILES = new Set(["present", "missing"]);

/// Rejects a selection whose scenarios ask for state seeding cannot build.
export function assertSeedable(rows: FixtureEnvelope[]): void {
  const unsupported = new Map<string, string[]>();
  const note = (reason: string, fixtureId: string) => {
    const ids = unsupported.get(reason);
    if (ids) ids.push(fixtureId);
    else unsupported.set(reason, [fixtureId]);
  };

  for (const row of rows) {
    const scenario = row.scenario;
    const clock = scenario.execution?.clock ?? "none";
    if (!SEEDABLE_CLOCKS.has(clock))
      note(
        `execution.clock "${clock}" needs a controlled clock`,
        row.fixture_id,
      );

    const cohort = scenario.v1.expected_pre_migration?.expiry_cohort;
    if (cohort && !SEEDABLE_EXPIRY_COHORTS.has(cohort))
      note(
        `expiry cohort "${cohort}" is not established by seeding`,
        row.fixture_id,
      );

    const profile = scenario.v2_premigration?.profile;
    if (profile && !SEEDABLE_V2_PROFILES.has(profile))
      note(
        `v2 pre-migration profile "${profile}" is not established by seeding`,
        row.fixture_id,
      );

    const duration = Number(scenario.v1.registration.duration_seconds);
    if (duration < MIN_REGISTRATION_SECONDS)
      note(
        `lease of ${duration}s is below the v1 controller minimum`,
        row.fixture_id,
      );
  }

  if (!unsupported.size) return;
  const detail = [...unsupported.entries()]
    .map(([reason, ids]) => {
      const shown = ids.slice(0, 4).join(", ");
      const rest = ids.length > 4 ? `, +${ids.length - 4} more` : "";
      return `  ${ids.length}x ${reason}: ${shown}${rest}`;
    })
    .join("\n");
  throw new Error(
    `fixture selection contains scenarios seeding cannot establish:\n${detail}\n` +
      "restrict the selection (--scenarios live_now) or implement the missing state",
  );
}

/// Reports the reverse claims a selection cannot all express.
///
/// A reverse node derives from the claimant, and each actor alias is one
/// account, so every scenario claiming from the same alias writes the same node
/// and only the last survives. Nothing reads a reverse record back, so this
/// would otherwise be invisible; it is reported rather than refused because the
/// overlap is inherent to a fixed actor pool and touches no other state the
/// corpus shapes or checks.
function reportReverseClaimOverlap(rows: FixtureEnvelope[]): void {
  const byClaimant = new Map<string, number>();
  for (const row of rows) {
    for (const step of row.scenario.v1.setup_steps) {
      if (step.action !== "set_reverse_claim") continue;
      const claimant = String(step.address_actor ?? "").replace("actor.", "");
      byClaimant.set(claimant, (byClaimant.get(claimant) ?? 0) + 1);
    }
  }
  const overlapping = [...byClaimant.entries()].filter(([, n]) => n > 1);
  if (!overlapping.length) return;
  const detail = overlapping
    .map(([claimant, n]) => `${claimant} (${n})`)
    .join(", ");
  console.warn(
    `warning: ${overlapping.reduce((a, [, n]) => a + n, 0)} reverse claims share ${overlapping.length} ` +
      `actor accounts, so only the last claim per account survives: ${detail}`,
  );
}

async function verify(opts: CommonOptions): Promise<void> {
  const rows = loadFixture(opts);
  if (!rows.length) throw new Error("fixture selection is empty");
  assertSeedable(rows);
  reportReverseClaimOverlap(rows);

  const ids = new Set<string>();
  const labels = new Set<string>();
  const perVector = new Map<string, number>();
  for (const row of rows) {
    if (ids.has(row.fixture_id))
      throw new Error(`duplicate fixture ID ${row.fixture_id}`);
    if (labels.has(row.label))
      throw new Error(`duplicate fixture label ${row.label}`);
    ids.add(row.fixture_id);
    labels.add(row.label);
    perVector.set(
      row.source_scenario_id,
      (perVector.get(row.source_scenario_id) ?? 0) + 1,
    );
  }

  // Placeholder addresses are enough to prove every action resolves, and keep
  // the check runnable without deployments or an RPC.
  const placeholder = (n: number) =>
    `0x${n.toString(16).padStart(40, "0")}` as Address;
  const ctx: PlanContext = {
    actors: new Map(
      accounts(opts).map((a, i) => [a.alias, placeholder(0x1000 + i)]),
    ),
    fixtureContracts: Object.fromEntries(
      FIXTURE_ARTIFACTS.map((f, i) => [f.name, placeholder(0x2000 + i)]),
    ),
    v1Address: (name) => placeholder(0x3000 + name.length),
    v2Address: (name) => placeholder(0x4000 + name.length),
    batcher: placeholder(0x9999),
    addresses: {
      baseRegistrar: placeholder(0x3001),
      registry: placeholder(0x3002),
      wrapper: placeholder(0x3003),
      controller: placeholder(0x3004),
      publicResolver: placeholder(0x3005),
      reverseRegistrar: placeholder(0x3006),
      defaultReverseRegistrar: placeholder(0x3007),
    },
  };

  let batcherCalls = 0;
  let actorCalls = 0;
  const scenarios = new Map<string, number>();
  const routes = new Map<string, number>();
  for (const row of rows) {
    expectedResult(row.scenario);
    wrapperState(row.scenario);
    const route = migrationRoute(row.scenario);
    routes.set(route, (routes.get(route) ?? 0) + 1);
    const scenario = executionScenario(row.scenario);
    scenarios.set(scenario, (scenarios.get(scenario) ?? 0) + 1);
    for (const call of planSetupSteps(row, ctx)) {
      if (call.signer.kind === "batcher") batcherCalls += 1;
      else actorCalls += 1;
    }
  }

  const targets = rows.map((r) => migrationTarget(r, ctx));
  const { batches, singles } = partitionMigration(targets);
  let wrappedGroups = 0;
  for (const b of batches) {
    const args = buildHelperArgs(b.members);
    wrappedGroups +=
      args.unlockedGroups.length +
      args.lockedGroups.length +
      args.lockedChildren.reduce((n, c) => n + c.groups.length, 0);
  }

  console.log(
    JSON.stringify(
      {
        selected: rows.length,
        sourceScenarios: perVector.size,
        replicasPerVector: {
          min: Math.min(...perVector.values()),
          max: Math.max(...perVector.values()),
        },
        executionScenarios: Object.fromEntries(scenarios),
        migrationRoutes: Object.fromEntries(routes),
        setupCalls: { batcher: batcherCalls, actor: actorCalls },
        migration: {
          batches: batches.length,
          wrappedGroups,
          singles: singles.length,
        },
        helperApprovalActors: [...actorsNeedingHelperApproval(targets)].sort(),
        digest: fixtureDigest(rows),
      },
      null,
      2,
    ),
  );
}

async function deployFixtures(opts: CommonOptions): Promise<void> {
  await requireWriteableChain(opts);
  mkdirSync(resolve(opts.workDir), { recursive: true });
  const { chain } = clients(opts);
  const existing = loadRunState(opts);
  if (existing)
    assertRunStateCompatible(opts, existing, chain.id, accounts(opts));
  const fixtureContracts = await deployFixtureContracts(
    opts,
    existing?.fixtureContracts ?? {},
  );
  const batcher = existing?.batcher ?? (await deployBatcher(opts));
  const now = new Date().toISOString();
  const state: FixtureRunState = existing ?? {
    version: 2,
    chainId: chain.id,
    fixtureRoot: resolve(opts.fixtureRoot),
    fixtureDigest: "0x" as Hex,
    createdAt: now,
    updatedAt: now,
    batcher,
    fixtureContracts,
    actorAddresses: {},
    names: [],
  };
  state.batcher = batcher;
  state.fixtureContracts = fixtureContracts;
  saveRunState(opts, state);
  console.log(`batcher: ${batcher}`);
  console.log(`run state: ${runStatePath(opts)}`);
}

/// Registers the selected corpus on V1 and shapes each name's state. Returns
/// the label list the pre-migration phases reserve on V2, which is a subset of
/// what was seeded: see `writePremigrationCsv`.
export async function seedV1(
  opts: CommonOptions,
): Promise<{ path: string; labels: string[] }> {
  await requireWriteableChain(opts);
  mkdirSync(resolve(opts.workDir), { recursive: true });
  const rows = loadFixture(opts);
  if (!rows.length) throw new Error("fixture selection is empty");
  assertSeedable(rows);
  reportReverseClaimOverlap(rows);

  const actors = accounts(opts);
  const { chain, client, wallet } = clients(opts);

  // Checked before the controller re-enable, which is the run's first write.
  const existing = loadRunState(opts);
  if (existing) assertRunStateCompatible(opts, existing, chain.id, actors);

  await ensureV1ControllerEnabled(opts);
  const batcher = existing?.batcher ?? (await deployBatcher(opts));
  const fixtureContracts = await deployFixtureContracts(
    opts,
    existing?.fixtureContracts ?? {},
  );

  // Record the deployed batcher and counterparty contracts before registering
  // anything. Seeding registers each name to the batcher first, so a run that
  // fails partway leaves names owned by it; without this the next run would
  // deploy a second batcher, fail to recognise the first as its own, and refuse
  // to continue against names it had itself created.
  const startedAt = new Date().toISOString();
  const seeded: FixtureRunState = existing ?? {
    version: 2,
    chainId: chain.id,
    fixtureRoot: resolve(opts.fixtureRoot),
    fixtureDigest: "0x" as Hex,
    createdAt: startedAt,
    updatedAt: startedAt,
    batcher,
    fixtureContracts,
    actorAddresses: {},
    names: [],
  };
  seeded.batcher = batcher;
  seeded.fixtureContracts = fixtureContracts;
  saveRunState(opts, seeded);

  const v1 = v1Addresses(opts);
  const ctx = planContext(opts, fixtureContracts, batcher);
  const executor: Executor = {
    opts,
    chain,
    client,
    wallet,
    batcher,
    actors: new Map(actors.map((a) => [a.alias, a])),
  };

  const runNames: FixtureRunName[] = rows.map((row) => {
    const state = wrapperState(row.scenario);
    const ownerAlias = preMigrationOwnerAlias(row.scenario);
    const actor = actors.find((a) => a.alias === ownerAlias);
    if (!actor)
      throw new Error(`unknown actor "${ownerAlias}" for ${row.fixture_id}`);
    return {
      fixtureId: row.fixture_id,
      sourceScenarioId: row.source_scenario_id,
      label: row.label,
      name: row.name,
      ownerAlias,
      owner: actor.account.address,
      form: state.form,
      wrapped: state.wrapped,
      locked: state.locked,
      fuses: state.fuses,
      route: migrationRoute(row.scenario),
      batchId: row.scenario.migration.batch?.batch_id ?? null,
      expectedResult: expectedResult(row.scenario),
      seedTransactions: [],
      setupComplete: false,
    };
  });

  // A name is skipped only once every setup call for it landed. One whose
  // registration landed but whose setup did not is part-shaped, and replanning
  // it would replay steps from an assumed initial state the name has left.
  const alreadySeeded = new Set(
    seeded.names.filter((n) => n.setupComplete).map((n) => n.fixtureId),
  );
  const pending = runNames.filter((n) => !alreadySeeded.has(n.fixtureId));
  const rowById = new Map(rows.map((r) => [r.fixture_id, r]));

  const registrations: {
    run: FixtureRunName;
    registration: any;
    commitment: Hex;
  }[] = [];

  for (const run of pending) {
    const row = rowById.get(run.fixtureId)!;
    const tokenId = tokenIdOf(run.label);
    const expiry = (await client.readContract({
      address: v1.base.address,
      abi: v1.base.abi,
      functionName: "nameExpires",
      args: [tokenId],
    })) as bigint;

    if (expiry > 0n) {
      // Resuming is only safe when the existing registration is one of ours.
      // Any other holder means the label collides with a name we do not
      // control, and shaping state against it would corrupt that name.
      const owner = getAddress(
        (await client.readContract({
          address: v1.base.address,
          abi: v1.base.abi,
          functionName: "ownerOf",
          args: [tokenId],
        })) as Address,
      );
      const ours = new Set(
        [
          batcher,
          v1.wrapper.address,
          ...actors.map((a) => a.account.address),
        ].map((a) => getAddress(a)),
      );
      if (!ours.has(owner)) {
        throw new Error(
          `${run.fixtureId}: ${run.name} is already registered to ${owner}, which is not a fixture ` +
            "actor of this run; if that is a batcher, its run state is in another work directory",
        );
      }
      // The batcher that holds the name is recorded here, so this work
      // directory is what can still reach it. Sending the operator elsewhere
      // would deploy a second batcher and strand the name behind the check
      // above.
      throw new Error(
        `${run.fixtureId}: ${run.name} is registered but its setup did not finish, so its state is ` +
          "part-shaped and cannot be replayed; keep this work directory and either drop the name " +
          "from the selection or reseed against a fresh chain",
      );
    }

    const registration = {
      label: run.label,
      owner: batcher,
      // Several scenarios turn on a short lease; a blanket duration erases the
      // expiry and grace behaviour they exist to exercise.
      duration: BigInt(row.scenario.v1.registration.duration_seconds),
      secret: deterministicSecret(run.fixtureId),
      resolver: zeroAddress,
      data: [] as Hex[],
      reverseRecord: 0,
      referrer: zeroHash,
    };
    const commitment = (await client.readContract({
      address: v1.controller.address,
      abi: v1.controller.abi,
      functionName: "makeCommitment",
      args: [registration],
    })) as Hex;
    registrations.push({ run, registration, commitment });
  }

  const commitBatchSize = Math.max(
    1,
    parseNumber(process.env.MIGRATION_FIXTURE_COMMIT_BATCH_SIZE, 80),
  );
  const registerBatchSize = Math.max(
    1,
    parseNumber(process.env.MIGRATION_FIXTURE_REGISTER_BATCH_SIZE, 12),
  );

  for (const batch of chunk(registrations, commitBatchSize)) {
    const commitments = batch.map((x) => x.commitment);
    const hash = await wallet.writeContract({
      address: batcher,
      abi: Artifact_MigrationFixtureBatcher.abi,
      functionName: "commitBatch",
      args: [commitments],
      gas: await bufferedGas(client, {
        address: batcher,
        abi: Artifact_MigrationFixtureBatcher.abi,
        functionName: "commitBatch",
        args: [commitments],
        account: wallet.account,
      }),
    });
    await receipt(client, hash, `commit batch (${batch.length})`);
    for (const x of batch) x.run.seedTransactions.push(hash);
  }

  if (registrations.length) {
    const minAge = (await client.readContract({
      address: v1.controller.address,
      abi: v1.controller.abi,
      functionName: "minCommitmentAge",
    })) as bigint;
    await waitCommitmentAge(opts, minAge + 1n);
  }

  for (const batch of chunk(registrations, registerBatchSize)) {
    const values: bigint[] = [];
    for (const x of batch) {
      const price = (await client.readContract({
        address: v1.controller.address,
        abi: v1.controller.abi,
        functionName: "rentPrice",
        args: [x.run.label, x.registration.duration],
      })) as { base: bigint; premium: bigint };
      values.push(withPriceBuffer(price.base + price.premium));
    }
    const args = [batch.map((x) => x.registration), values] as const;
    const value = values.reduce((a, b) => a + b, 0n);
    const hash = await wallet.writeContract({
      address: batcher,
      abi: Artifact_MigrationFixtureBatcher.abi,
      functionName: "registerBatch",
      args,
      value,
      gas: await bufferedGas(client, {
        address: batcher,
        abi: Artifact_MigrationFixtureBatcher.abi,
        functionName: "registerBatch",
        args,
        value,
        account: wallet.account,
      }),
    });
    await receipt(client, hash, `register batch (${batch.length})`);
    for (const x of batch) x.run.seedTransactions.push(hash);
  }

  const perName = new Map<string, PlannedCall[]>();
  for (const run of pending) {
    perName.set(
      run.fixtureId,
      planSetupSteps(rowById.get(run.fixtureId)!, ctx),
    );
  }
  const byId = new Map(pending.map((r) => [r.fixtureId, r]));
  // A name the corpus asks nothing further of is shaped by its registration
  // alone, and never reaches the executor to report itself finished.
  for (const run of pending) {
    if (!perName.get(run.fixtureId)?.length) run.setupComplete = true;
  }

  // The registrations have landed, so record them before shaping any state. An
  // interrupted run then knows which names it created, and which of those it
  // had not finished with.
  seeded.names = [
    ...seeded.names.filter((n) => !byId.has(n.fixtureId)),
    ...pending,
  ];
  saveRunState(opts, seeded);

  await executePlannedCalls(
    executor,
    perName,
    (fixtureId, hash) => {
      byId.get(fixtureId)?.seedTransactions.push(hash);
    },
    (fixtureId) => {
      const run = byId.get(fixtureId);
      if (run) run.setupComplete = true;
      saveRunState(opts, seeded);
    },
  );

  const state = seeded;
  state.fixtureDigest = fixtureDigest(rows);
  state.actorAddresses = Object.fromEntries(
    actors.map((a) => [a.alias, a.account.address]),
  );
  saveRunState(opts, state);
  const csv = writePremigrationCsv(opts, rows, state);

  console.log(`seeded ${state.names.length} fixture names on v1`);
  console.log(`batcher: ${batcher}`);
  console.log(`run state: ${runStatePath(opts)}`);
  console.log(
    `premigration CSV: ${csv.path} (${csv.labels.length} of ${state.names.length} names reserved on v2)`,
  );
  console.log(
    `next: bun run migration -- premigration run --csv-file ${csv.path}`,
  );
  return csv;
}

/// Reads the shaped V1 state back off-chain and compares every seeded name with
/// the pre-migration state its scenario declares — wrapper form, burned fuses,
/// ownership across the three V1 registries, resolver, TTL and records. Run it
/// after `seed-v1` and before pre-migration, so a name whose limitations were
/// not applied is caught while it can still be reshaped.
export async function verifyV1(opts: CommonOptions): Promise<void> {
  const state = loadRunState(opts);
  if (!state) {
    throw new Error(
      `no fixture run state at ${runStatePath(opts)}; run "fixture seed-v1" first`,
    );
  }
  const { client } = clients(opts);
  const seeded = new Set(state.names.map((n) => n.fixtureId));
  const rows = loadFixture(opts).filter((r) => seeded.has(r.fixture_id));
  if (!rows.length) {
    throw new Error(
      "no seeded names in this selection; widen the selection or seed it first",
    );
  }

  const v1 = v1Addresses(opts);
  const result = await verifySeededV1State(
    client,
    rows,
    refContext(opts, state.fixtureContracts),
    {
      registry: v1.registry.address,
      baseRegistrar: v1.base.address,
      nameWrapper: v1.wrapper.address,
    },
  );

  const byForm: Record<string, { names: number; failing: number }> = {};
  const failingIds = new Set(result.issues.map((i) => i.fixtureId));
  for (const row of rows) {
    const form =
      state.names.find((n) => n.fixtureId === row.fixture_id)?.form ?? "?";
    const entry = (byForm[form] ??= { names: 0, failing: 0 });
    entry.names += 1;
    if (failingIds.has(row.fixture_id)) entry.failing += 1;
  }

  const reportPath = join(
    resolve(opts.workDir),
    "fixture-v1-verification.json",
  );
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        names: result.names,
        checks: result.checks,
        byForm,
        issues: result.issues,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        names: result.names,
        checks: result.checks,
        failingNames: failingIds.size,
        issues: result.issues.length,
        byField: result.byField,
        byForm,
        report: reportPath,
      },
      null,
      2,
    ),
  );

  for (const issue of result.issues.slice(0, 25)) {
    console.log(
      `  ${issue.fixtureId} (${issue.form}) ${issue.field}: expected ${issue.expected}, got ${issue.actual}`,
    );
  }
  if (result.issues.length > 25) {
    console.log(`  ... ${result.issues.length - 25} more in ${reportPath}`);
  }
  if (result.issues.length) {
    throw new Error(
      `${failingIds.size}/${result.names} seeded names do not match their declared pre-migration state`,
    );
  }
  console.log("all seeded names match their declared pre-migration state");
}

async function fundActorAccounts(
  opts: CommonOptions,
  floor: string,
): Promise<void> {
  await requireWriteableChain(opts);
  const { chain, client, wallet } = clients(opts);
  const actors = accounts(opts);
  await fundActors(
    {
      opts,
      chain,
      client,
      wallet,
      batcher: zeroAddress,
      actors: new Map(actors.map((a) => [a.alias, a])),
    },
    floor,
  );
  for (const a of actors) {
    const balance = await client.getBalance({ address: a.account.address });
    console.log(`  ${a.alias} ${a.account.address} ${balance}`);
  }
}

/// Seeds the corpus and proves the shaped state, as one step for the rehearsal
/// orchestrators.
///
/// Ordering: this must run **after phase 1**, not before it. A third of the
/// corpus approves `MigrationHelper` as an operator while shaping its V1 state,
/// so planning those names resolves a V2 deployment that phase 1 is what
/// creates. Seeding still has to finish before phase 3 closes V1 registration.
///
/// The labels returned are the ones pre-migration reserves, not everything
/// seeded. A rehearsal folds them into its own CSV rather than reading the
/// emitted one, so taking them from the same filter is what keeps a rehearsal
/// reserving the same set as a standalone run: seeded names that model a v2
/// state other than `RESERVED` stay unreserved, as their scenarios require.
export async function runFixtureSeedStage(
  opts: CommonOptions,
): Promise<{ labels: string[]; premigrationCsv: string }> {
  console.log("fixture: seeding the ENSv1 corpus");
  const { path: premigrationCsv, labels } = await seedV1(opts);
  console.log("fixture: verifying the shaped V1 state");
  await verifyV1(opts);

  return { labels, premigrationCsv };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function addCommon(command: Command): Command {
  return command
    .requiredOption("--network <network>", "sepolia or mainnet")
    .option("--rpc-url <url>", "RPC URL")
    .option("--chain-id <id>", "Chain ID override")
    .requiredOption("--fixture-root <path>", "Weighted fixture bundle root")
    .requiredOption("--work-dir <path>", "Run/checkpoint directory")
    .option("--deployments-dir <path>", "V2 deployments root", "./deployments")
    .option("--deployment-network <name>", "V2 deployment namespace")
    .option("--v1-deployments-dir <path>", "V1 deployments root")
    .option("--v1-deployment-network <name>", "V1 deployment namespace")
    .option("--private-key <key>", "Fixture operator private key")
    .option("--v1-owner <address>", "Canonical V1 owner address")
    .option(
      "--v1-owner-key <key>",
      "V1 owner / prior renewer owner private key",
    )
    .option("--actor-mnemonic <mnemonic>", "Dedicated fixture actor mnemonic")
    .option("--limit <count>", "Limit selected fixture instances")
    .option("--tiers <tiers>", "Comma-separated popularity tiers")
    .option(
      "--scenarios <scenarios>",
      "Comma-separated execution scenarios, e.g. live_now",
    )
    .option("--fixture-ids <ids>", "Comma-separated fixture IDs")
    .option(
      "--replicas-per-vector <count>",
      "Keep at most N replicas of each source scenario",
    )
    .option(
      "--rpc-state-controls",
      "Enable impersonation/time control RPC methods",
      false,
    );
}

/// Gate every fixture action that writes to the chain.
///
/// The corpus is test scaffolding: it registers names and shapes their state
/// with real transactions, so it must never touch live mainnet. A mainnet
/// *fork* is fine, and is what a full dress rehearsal uses, so the network check
/// turns on the absence of RPC state controls rather than on the network alone.
/// That flag is caller-asserted, so it is then proved against the endpoint
/// before the first transaction rather than trusted.
///
/// Read-only actions do not call this: refusing them would only push operators
/// into passing the state-control flag to run a dry run, which is the very
/// assertion this exists to distrust.
async function requireWriteableChain(opts: CommonOptions): Promise<void> {
  if (opts.network === "mainnet" && !opts.rpcStateControls) {
    throw new Error(
      "refusing to run the fixture corpus against live mainnet; use a fork or Tenderly virtual testnet (--rpc-state-controls)",
    );
  }
  await assertStateControls(opts);
}

function normalizeOptions(raw: any): CommonOptions {
  const network = raw.network as "sepolia" | "mainnet";
  if (network !== "sepolia" && network !== "mainnet") {
    throw new Error(`unsupported network: ${raw.network}`);
  }
  const rpcUrl =
    raw.rpcUrl ??
    process.env[network === "sepolia" ? "SEPOLIA_RPC_URL" : "MAINNET_RPC_URL"];
  if (!rpcUrl)
    throw new Error("missing --rpc-url or network RPC environment variable");
  return { ...raw, network, rpcUrl } as CommonOptions;
}

/// Adds the fixture subcommands to a parent command. Shared by this script's
/// own CLI and by the `fixture` group in migration.ts, so the two can never
/// drift apart on options or behaviour.
export function addFixtureSubcommands(program: Command): Command {
  program.addCommand(
    addCommon(
      new Command("verify").description(
        "Offline: validate the selection and plan every scenario's calls",
      ),
    ).action((raw) => verify(normalizeOptions(raw))),
  );
  program.addCommand(
    addCommon(
      new Command("fund-actors").description(
        "Top up the fixture actor accounts",
      ),
    )
      .option("--floor <eth>", "Minimum balance per actor", "0.5")
      .action((raw) => fundActorAccounts(normalizeOptions(raw), raw.floor)),
  );
  program.addCommand(
    addCommon(
      new Command("deploy-fixtures").description(
        "Deploy the batcher and the fixture.* corpus contracts",
      ),
    ).action((raw) => deployFixtures(normalizeOptions(raw))),
  );
  program.addCommand(
    addCommon(
      new Command("seed-v1").description(
        "Register the corpus on v1 and shape each name's pre-migration state (before phase 3)",
      ),
    ).action(async (raw) => {
      await seedV1(normalizeOptions(raw));
    }),
  );
  program.addCommand(
    addCommon(
      new Command("verify-v1").description(
        "After seed-v1: read the shaped V1 state back and check it against each scenario",
      ),
    ).action((raw) => verifyV1(normalizeOptions(raw))),
  );
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  loadDotEnv(resolve(".env"));
  const program = addFixtureSubcommands(
    new Command("migration-fixture").description(
      "Seed the weighted ENSv1 migration fixture and carry it through pre-migration.",
    ),
  );
  await program.parseAsync(argv);
}

if (import.meta.main) {
  await main();
}
