import { namehash, type Address } from "viem";

import {
  isChild,
  isLocked,
  isWrapped,
  migrationRoute,
  preMigrationOwnerAlias,
  resolveOptionalRef,
  resolveRef,
  v1Form,
  type RefContext,
} from "./scenario.js";
import { labelhashOf, tokenIdOf } from "./plan.js";
import type { FixtureEnvelope, Route, V1Form } from "./types.js";

/// `LibMigration.Data` as the controllers and MigrationHelper expect it.
export type MigrationData = {
  label: string;
  owner: Address;
  subregistry: Address;
  resolver: Address;
};

export type MigrationTarget = {
  row: FixtureEnvelope;
  fixtureId: string;
  label: string;
  name: string;
  form: V1Form;
  route: Route;
  /// Actor that holds the name on V1 and must therefore sign, or have approved
  /// the helper. This is the owner MigrationHelper reads back on-chain.
  v1OwnerAlias: string;
  /// Actor that submits the transaction for non-helper routes.
  callerAlias: string;
  data: MigrationData;
  batchId: string | null;
};

/// Builds the migration payload from the scenario rather than inferring it.
/// The subregistry and resolver are scenario-specified; defaulting them to zero
/// and reading the resolver off the V1 registry silently drops the custom
/// subregistry and unsupported-resolver cases.
export function migrationTarget(
  row: FixtureEnvelope,
  ctx: RefContext,
): MigrationTarget {
  const scenario = row.scenario;
  const payload = scenario.migration.payload;
  const form = v1Form(scenario);
  const v1OwnerAlias = preMigrationOwnerAlias(scenario);
  const callerRef = scenario.migration.caller_ref ?? `actor.${v1OwnerAlias}`;
  return {
    row,
    fixtureId: row.fixture_id,
    label: payload.label,
    name: scenario.name,
    form,
    route: migrationRoute(scenario),
    v1OwnerAlias,
    callerAlias: callerRef.startsWith("actor.")
      ? callerRef.slice("actor.".length)
      : callerRef,
    batchId: scenario.migration.batch?.batch_id ?? null,
    data: {
      label: payload.label,
      owner: resolveRef(payload.owner_ref, ctx),
      subregistry: resolveOptionalRef(payload.subregistry_ref, ctx),
      resolver: resolveOptionalRef(payload.resolver_ref, ctx),
    },
  };
}

export type HelperArgs = {
  unwrapped: MigrationData[];
  unlockedGroups: MigrationData[][];
  lockedGroups: MigrationData[][];
  lockedChildren: { parentName: string; groups: MigrationData[][] }[];
};

function groupByOwner(targets: MigrationTarget[]): MigrationData[][] {
  const buckets = new Map<string, MigrationData[]>();
  for (const t of targets) {
    const bucket = buckets.get(t.v1OwnerAlias);
    if (bucket) bucket.push(t.data);
    else buckets.set(t.v1OwnerAlias, [t.data]);
  }
  return [...buckets.values()];
}

/// Partitions one atomic batch into MigrationHelper's four buckets.
///
/// `MigrationHelper._transferWrapped` reads each token's owner from the
/// NameWrapper and reverts `WrappedOwnerMismatch` unless every member of a
/// group shares it, so each wrapped bucket is sub-partitioned by the V1 owner.
/// A third of the corpus batches span more than one owner. Splitting into
/// several groups inside a single `migrate` call keeps the batch atomic — it is
/// still one transaction — while satisfying the per-group constraint.
export function buildHelperArgs(targets: MigrationTarget[]): HelperArgs {
  const unwrapped: MigrationData[] = [];
  const unlocked: MigrationTarget[] = [];
  const locked: MigrationTarget[] = [];
  const childrenByParent = new Map<string, MigrationTarget[]>();

  for (const t of targets) {
    if (!isWrapped(t.form)) {
      unwrapped.push(t.data);
      continue;
    }
    if (isChild(t.form)) {
      const parent = t.name.split(".").slice(1).join(".");
      const list = childrenByParent.get(parent);
      if (list) list.push(t);
      else childrenByParent.set(parent, [t]);
      continue;
    }
    if (isLocked(t.form)) locked.push(t);
    else unlocked.push(t);
  }

  return {
    unwrapped,
    unlockedGroups: groupByOwner(unlocked),
    lockedGroups: groupByOwner(locked),
    lockedChildren: [...childrenByParent.entries()].map(
      ([parentName, members]) => ({
        parentName,
        groups: groupByOwner(members),
      }),
    ),
  };
}

/// Every V1 owner appearing in a helper call must have approved the helper,
/// because `migrate` runs as a single sender. Batch members carry per-member
/// callers spanning several actors, so the approval set is the union of the
/// batch's V1 owners — not just the actors whose route names the helper.
export function actorsNeedingHelperApproval(
  targets: MigrationTarget[],
): Set<string> {
  const aliases = new Set<string>();
  for (const t of targets) {
    if (t.batchId || t.route === "migration_helper" || isChild(t.form)) {
      aliases.add(t.v1OwnerAlias);
    }
  }
  return aliases;
}

/// Splits the selected rows into helper batches and individually-routed names.
export function partitionMigration(targets: MigrationTarget[]): {
  batches: { batchId: string; members: MigrationTarget[] }[];
  singles: MigrationTarget[];
} {
  const batches = new Map<string, MigrationTarget[]>();
  const singles: MigrationTarget[] = [];
  for (const t of targets) {
    if (t.batchId) {
      const list = batches.get(t.batchId);
      if (list) list.push(t);
      else batches.set(t.batchId, [t]);
    } else {
      singles.push(t);
    }
  }
  return {
    batches: [...batches.entries()].map(([batchId, members]) => ({
      batchId,
      members,
    })),
    singles,
  };
}
