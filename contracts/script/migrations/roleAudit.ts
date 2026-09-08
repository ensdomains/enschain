// Audits who holds which roles on the v2 registries.
//
// The authoritative value is always a live `roles()` call at a `getResource()`-
// resolved resource, never a replay of `EACRolesChanged`. The event log cannot
// reconstruct the matrix, because several things change effective authority without
// emitting it at all:
//
//   - a name expiring bumps the resource id, orphaning every grant against the old
//     one with no transaction and no event;
//   - unregistering or re-registering bumps it the same way;
//   - an ERC-1155 operator inherits the token owner's roles through
//     `isApprovedForAll`, which is a different event entirely.
//
// Logs are therefore used only to discover *which addresses to ask about*. What they
// hold is then read from the chain.

import { ROLES } from "../deploy-constants.js";

// Every role bit with a readable name, derived from the same flag table the deploy
// scripts grant from, so a new role cannot be silently omitted from an audit.
function flattenRoleNames(
  flags: Record<string, unknown>,
  prefix: string[] = [],
): Array<[bigint, string]> {
  const named: Array<[bigint, string]> = [];
  for (const [key, value] of Object.entries(flags)) {
    if (typeof value === "bigint") {
      named.push([value, [...prefix, key].join("_")]);
    } else if (value && typeof value === "object") {
      named.push(
        ...flattenRoleNames(value as Record<string, unknown>, [...prefix, key]),
      );
    }
  }
  return named;
}

// `ALL` is a mask rather than a single role, and the ADMIN tree is folded in with an
// explicit suffix so a bitmap reads as "REGISTRAR | REGISTRAR_ADMIN".
const ROLE_BIT_NAMES: Array<[bigint, string]> = [
  ...flattenRoleNames({ REGISTRY: ROLES.REGISTRY }),
  ...flattenRoleNames({ RESOLVER: ROLES.RESOLVER }),
  ...flattenRoleNames({ ORACLE: ROLES.ORACLE }),
  ...flattenRoleNames({ ADDRESS_SET: ROLES.ADDRESS_SET }),
  ...flattenRoleNames({ REGISTRY: ROLES.ADMIN.REGISTRY }).map(
    ([bit, name]) => [bit, `${name}_ADMIN`] as [bigint, string],
  ),
  ...flattenRoleNames({ RESOLVER: ROLES.ADMIN.RESOLVER }).map(
    ([bit, name]) => [bit, `${name}_ADMIN`] as [bigint, string],
  ),
  ...flattenRoleNames({ ORACLE: ROLES.ADMIN.ORACLE }).map(
    ([bit, name]) => [bit, `${name}_ADMIN`] as [bigint, string],
  ),
  ...flattenRoleNames({ ADDRESS_SET: ROLES.ADMIN.ADDRESS_SET }).map(
    ([bit, name]) => [bit, `${name}_ADMIN`] as [bigint, string],
  ),
];

// Renders a bitmap using whichever role vocabulary the contract uses. A registry and
// a resolver reuse the same bit positions for different meanings, so the caller says
// which family applies rather than every name being tried at once.
export function describeRoleBitmap(
  bitmap: bigint,
  family: "REGISTRY" | "RESOLVER" | "ORACLE" | "ADDRESS_SET" = "REGISTRY",
): string {
  if (bitmap === 0n) return "(none)";

  const prefix = `${family}_`;
  const names: string[] = [];
  let described = 0n;
  for (const [bit, name] of ROLE_BIT_NAMES) {
    if (!name.startsWith(prefix) || (bitmap & bit) !== bit) continue;
    names.push(name.slice(prefix.length));
    described |= bit;
  }

  // Anything left over is a bit this build has no name for — surfaced rather than
  // dropped, so an audit never silently ignores a role it does not recognise.
  const unknown = bitmap & ~described;
  if (unknown !== 0n) names.push(`unknown(0x${unknown.toString(16)})`);
  return names.join(" | ");
}

export type RoleHolder = {
  /** Contract the roles live on. */
  contract: string;
  address: string;
  /** Resource the roles are scoped to: the root, or a specific token. */
  scope: string;
  account: string;
  roles: bigint;
};

export type RoleExpectation = {
  contract: string;
  scope: string;
  account: string;
  roles: bigint;
};

export type RoleAuditFinding =
  | { kind: "unexpected"; holder: RoleHolder; extra: bigint }
  | { kind: "missing"; expectation: RoleExpectation; absent: bigint };

// Compares what the chain reports against what the deployment intends.
//
// Both directions matter and they fail differently. An account holding more than it
// should is a privilege that was never revoked; an account holding less is a step
// that silently did not happen. Neither is visible from a single spot-check of one
// address, which is all the migration verifies today.
export function diffRoleMatrix(
  holders: RoleHolder[],
  expectations: RoleExpectation[],
): RoleAuditFinding[] {
  const key = (contract: string, scope: string, account: string) =>
    `${contract}|${scope}|${account.toLowerCase()}`;

  const expected = new Map<string, RoleExpectation>();
  for (const expectation of expectations) {
    const id = key(
      expectation.contract,
      expectation.scope,
      expectation.account,
    );
    const previous = expected.get(id);
    expected.set(
      id,
      previous
        ? { ...expectation, roles: previous.roles | expectation.roles }
        : expectation,
    );
  }

  const findings: RoleAuditFinding[] = [];

  for (const holder of holders) {
    const id = key(holder.contract, holder.scope, holder.account);
    const allowed = expected.get(id)?.roles ?? 0n;
    const extra = holder.roles & ~allowed;
    if (extra !== 0n) findings.push({ kind: "unexpected", holder, extra });
  }

  for (const [id, expectation] of expected) {
    if (expectation.roles === 0n) continue;
    const holder = holders.find(
      (candidate) =>
        key(candidate.contract, candidate.scope, candidate.account) === id,
    );
    const held = holder?.roles ?? 0n;
    const absent = expectation.roles & ~held;
    if (absent !== 0n) findings.push({ kind: "missing", expectation, absent });
  }

  return findings;
}

export function describeRoleFinding(finding: RoleAuditFinding): string {
  if (finding.kind === "unexpected") {
    return `${finding.holder.contract} [${finding.holder.scope}] ${finding.holder.account} holds unexpected ${describeRoleBitmap(finding.extra)}`;
  }
  return `${finding.expectation.contract} [${finding.expectation.scope}] ${finding.expectation.account} is missing ${describeRoleBitmap(finding.absent)}`;
}
