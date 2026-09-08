import type { Address, Hex } from "viem";
import type { HDAccount } from "viem/accounts";

export const DAY = 86_400n;

/// NameWrapper fuse bits, keyed by the names the corpus uses.
export const FUSES = {
  CANNOT_UNWRAP: 1,
  CANNOT_BURN_FUSES: 2,
  CANNOT_TRANSFER: 4,
  CANNOT_SET_RESOLVER: 8,
  CANNOT_SET_TTL: 16,
  CANNOT_CREATE_SUBDOMAIN: 32,
  CANNOT_APPROVE: 64,
  PARENT_CANNOT_CONTROL: 1 << 16,
  IS_DOT_ETH: 1 << 17,
  CAN_EXTEND_EXPIRY: 1 << 18,
} as const;

export type FuseName = keyof typeof FUSES;

/// Owner-controlled fuses are the only ones `wrapETH2LD` accepts directly; the
/// parent-controlled bits live in the upper half of the bitmap.
export const OWNER_CONTROLLED_MASK = 0xffff;

/// The V1 forms the corpus tags each scenario with.
export const V1_FORMS = [
  "unwrapped",
  "wrapped_unlocked",
  "wrapped_locked",
  "locked_child",
  "emancipated_child",
  "ordinary_child",
] as const;
export type V1Form = (typeof V1_FORMS)[number];

/// Migration routes present in `scenario.migration.route`.
export const ROUTES = [
  "unlocked_controller",
  "locked_controller",
  "migration_helper",
  "wrapper_registry_receiver",
  "eth_renewer_v1",
  "graveyard",
] as const;
export type Route = (typeof ROUTES)[number];

export type ExecutionScenario = "live_now" | "fork_only" | "live_delayed";
export type ExpectedResult = "success" | "revert";

export type JsonDeployment = { address: Address; abi: readonly any[] };

export type RecordSpec = {
  kind: "addr" | "text" | "contenthash";
  coin_type?: number;
  key?: string;
  value?: string;
  /// Contenthash records carry their bytes here rather than in `value`.
  value_hex?: string;
  value_actor?: string;
};

export type SetupStep = Record<string, any> & { action: string };

export type Scenario = {
  scenario_id: string;
  layer: string;
  name: string;
  top_level_label: string;
  child_label: string | null;
  tags: string[];
  execution: {
    scenario: ExecutionScenario;
    /// How the scenario expects time to be reached: `none` for a state any
    /// chain already offers, otherwise a controlled or awaited clock.
    clock?: string;
    expected_result: ExpectedResult;
    expected_error: string | null;
    safe_on_public_sepolia: boolean;
  };
  actors: Record<string, string>;
  v1: {
    registration: Record<string, any> & {
      label: string;
      owner_actor: string;
      duration_seconds: number;
      resolver_ref?: string;
      records?: RecordSpec[];
    };
    setup_steps: SetupStep[];
    expected_pre_migration: Record<string, any> | null;
    parent_fixture: Record<string, any> | null;
  };
  v2_premigration: { profile: string; [k: string]: any };
  migration: {
    route: Route;
    caller_ref?: string;
    payload: {
      label: string;
      owner_ref: string;
      subregistry_ref: string;
      resolver_ref: string;
    };
    batch: { batch_id: string; [k: string]: any } | null;
    steps: SetupStep[];
  };
  post_migration: { profile: string; steps: SetupStep[] };
};

export type FixtureEnvelope = {
  fixture_version: number;
  fixture_id: string;
  source_scenario_id: string;
  replica_index: number;
  replica_count: number;
  popularity_tier: string;
  label: string;
  name: string;
  scenario: Scenario;
};

export type FixtureActor = { alias: string; account: HDAccount };

export type FixtureRunName = {
  fixtureId: string;
  sourceScenarioId: string;
  label: string;
  name: string;
  ownerAlias: string;
  owner: Address;
  form: V1Form;
  wrapped: boolean;
  locked: boolean;
  fuses: number;
  route: Route;
  batchId: string | null;
  expectedResult: ExpectedResult;
  seedTransactions: Hex[];
  /// Whether every setup call for this name landed. A name is recorded as soon
  /// as it is registered, so an interrupted run can tell a finished name from
  /// one whose state is only part-shaped.
  setupComplete: boolean;
};

export type FixtureRunState = {
  version: 2;
  chainId: number;
  fixtureRoot: string;
  fixtureDigest: Hex;
  createdAt: string;
  updatedAt: string;
  batcher: Address;
  /// Addresses of the deployed `fixture.*` corpus contracts, keyed by bare name.
  fixtureContracts: Record<string, Address>;
  actorAddresses: Record<string, Address>;
  names: FixtureRunName[];
};

export type CommonOptions = {
  network: "sepolia" | "mainnet";
  rpcUrl: string;
  chainId?: string;
  fixtureRoot: string;
  workDir: string;
  deploymentsDir: string;
  deploymentNetwork?: string;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  privateKey?: Hex;
  v1OwnerKey?: Hex;
  v1Owner?: Address;
  actorMnemonic?: string;
  limit?: string;
  tiers?: string;
  fixtureIds?: string;
  replicasPerVector?: string;
  scenarios?: string;
  rpcStateControls?: boolean;
};

export type BatchCall = {
  target: Address;
  value: bigint;
  data: Hex;
  allowFailure: boolean;
};
