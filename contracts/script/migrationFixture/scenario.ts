import { getAddress, zeroAddress, type Address } from "viem";

import {
  FUSES,
  OWNER_CONTROLLED_MASK,
  ROUTES,
  V1_FORMS,
  type ExecutionScenario,
  type ExpectedResult,
  type FuseName,
  type Route,
  type Scenario,
  type V1Form,
} from "./types.js";

/// Deployment artifacts whose corpus reference name differs from their filename.
const V1_NAME_ALIASES: Record<string, string> = {
  BaseRegistrar: "BaseRegistrarImplementation",
};

/// Everything the corpus can point at by symbolic name.
export type RefContext = {
  actors: Map<string, Address>;
  fixtureContracts: Record<string, Address>;
  v1Address: (name: string) => Address;
  v2Address: (name: string) => Address;
};

/// Resolves the `v1.*` / `v2.*` / `fixture.*` / `actor.*` / `zero_address`
/// scheme from ACTION_REFERENCE.md. Bare names are treated as actor aliases,
/// which is how `expected_pre_migration` and every `*_actor` field spell them.
export function resolveRef(
  ref: string | null | undefined,
  ctx: RefContext,
): Address {
  if (ref === null || ref === undefined) return zeroAddress;
  const value = ref.trim();
  if (!value || value === "zero_address") return zeroAddress;
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return getAddress(value as Address);

  const [scope, ...rest] = value.split(".");
  const name = rest.join(".");

  switch (scope) {
    case "v1":
      return ctx.v1Address(V1_NAME_ALIASES[name] ?? name);
    case "v2":
      return ctx.v2Address(name);
    case "fixture": {
      const address = ctx.fixtureContracts[name];
      if (!address) {
        throw new Error(
          `unresolved fixture contract "${name}"; deploy corpus fixtures first`,
        );
      }
      return address;
    }
    case "actor":
      return requireActor(name, ctx);
    default:
      return requireActor(value, ctx);
  }
}

function requireActor(alias: string, ctx: RefContext): Address {
  const address = ctx.actors.get(alias);
  if (!address) throw new Error(`unknown actor alias "${alias}"`);
  return address;
}

/// A reference is optional when the corpus models "no contract here"; callers
/// that must have a real address should use `resolveRef` directly.
export function resolveOptionalRef(
  ref: string | null | undefined,
  ctx: RefContext,
): Address {
  return ref ? resolveRef(ref, ctx) : zeroAddress;
}

export function executionScenario(scenario: Scenario): ExecutionScenario {
  const value = scenario.execution?.scenario;
  if (!value)
    throw new Error(`${scenario.scenario_id}: missing execution.scenario`);
  return value;
}

/// Reads the declared outcome. The previous implementation only honoured an
/// explicit value when it spelled a failure and otherwise fell through to a
/// substring scan, which misread 14.6% of the corpus as reverting.
export function expectedResult(scenario: Scenario): ExpectedResult {
  const result = scenario.execution?.expected_result;
  if (result !== "success" && result !== "revert") {
    throw new Error(
      `${scenario.scenario_id}: missing or invalid execution.expected_result (${result})`,
    );
  }
  return result;
}

export function migrationRoute(scenario: Scenario): Route {
  const route = scenario.migration?.route;
  if (!route || !ROUTES.includes(route)) {
    throw new Error(
      `${scenario.scenario_id}: unknown migration.route (${route})`,
    );
  }
  return route;
}

/// The V1 form is carried as one of a known set of tags. Deriving it from tags
/// rather than substring-matching the serialised scenario avoids the
/// "unwrapped".includes("wrapped") and "unlocked".includes("locked") collisions
/// that previously mislabelled half the corpus.
export function v1Form(scenario: Scenario): V1Form {
  const matches = (scenario.tags ?? []).filter((tag): tag is V1Form =>
    (V1_FORMS as readonly string[]).includes(tag),
  );
  if (matches.length !== 1) {
    throw new Error(
      `${scenario.scenario_id}: expected exactly one V1 form tag, found [${matches.join(", ")}]`,
    );
  }
  return matches[0];
}

export function isWrapped(form: V1Form): boolean {
  return form !== "unwrapped";
}

export function isLocked(form: V1Form): boolean {
  return form === "wrapped_locked" || form === "locked_child";
}

export function isChild(form: V1Form): boolean {
  return form.endsWith("_child");
}

export function fusesFromNames(names: readonly string[] | undefined): number {
  let bitmap = 0;
  for (const name of names ?? []) {
    const bit = FUSES[name as FuseName];
    if (bit === undefined) throw new Error(`unknown fuse name "${name}"`);
    bitmap |= bit;
  }
  return bitmap;
}

/// Prefers the precomputed bitmap and cross-checks it against the fuse names,
/// so a generator change that desynchronises the two is caught rather than
/// silently halving the burned fuse set.
export function resolveFuses(source: Record<string, any>): number {
  const names = source.fuses ?? source.fuse_names;
  const fromNames = fusesFromNames(names);
  if (source.fuse_bitmap === undefined || source.fuse_bitmap === null) {
    return fromNames;
  }
  const declared = Number(source.fuse_bitmap);
  if (!Number.isSafeInteger(declared)) {
    throw new Error(`invalid fuse_bitmap "${source.fuse_bitmap}"`);
  }
  if (names && declared !== fromNames) {
    throw new Error(
      `fuse_bitmap ${declared} disagrees with fuse names [${names.join(", ")}] (${fromNames})`,
    );
  }
  return declared;
}

export function ownerControlledFuses(bitmap: number): number {
  return bitmap & OWNER_CONTROLLED_MASK;
}

/// Terminal wrapper state for a scenario, taken from its form tag and the fuse
/// bitmap its expected pre-migration state declares.
export function wrapperState(scenario: Scenario): {
  form: V1Form;
  wrapped: boolean;
  locked: boolean;
  fuses: number;
} {
  const form = v1Form(scenario);
  const pre = scenario.v1?.expected_pre_migration ?? {};
  const fuses = resolveFuses(pre as any);
  return { form, wrapped: isWrapped(form), locked: isLocked(form), fuses };
}

/// The actor that holds the name on V1 immediately before migration. This is
/// the owner MigrationHelper reads back from NameWrapper/BaseRegistrar, and the
/// one batch groups must agree on.
export function preMigrationOwnerAlias(scenario: Scenario): string {
  const pre = scenario.v1?.expected_pre_migration ?? {};
  const alias =
    pre.wrapper_owner_ref ??
    pre.registry_owner_ref ??
    pre.base_registrar_owner_ref ??
    scenario.actors?.pre_migration_owner ??
    scenario.actors?.initial_owner ??
    scenario.v1?.registration?.owner_actor;
  if (!alias) {
    throw new Error(
      `${scenario.scenario_id}: cannot determine pre-migration owner`,
    );
  }
  return stripActorPrefix(alias);
}

export function stripActorPrefix(ref: string): string {
  return ref.startsWith("actor.") ? ref.slice("actor.".length) : ref;
}

export function batchId(scenario: Scenario): string | null {
  return scenario.migration?.batch?.batch_id ?? null;
}
