import { describe, expect, it } from "bun:test";

import { DEPLOYMENT_ROLES, ROLES } from "../../script/deploy-constants.js";
import {
  describeRoleBitmap,
  describeRoleFinding,
  diffRoleMatrix,
  type RoleExpectation,
  type RoleHolder,
} from "../../script/migrations/roleAudit.js";

const DEPLOYER = "0x0000000000000000000000000000000000000001";
const REGISTRAR = "0x0000000000000000000000000000000000000002";
const STRANGER = "0x0000000000000000000000000000000000000003";

function holder(overrides: Partial<RoleHolder> = {}): RoleHolder {
  return {
    contract: "ETHRegistry",
    address: "0x00000000000000000000000000000000000000ff",
    scope: "root",
    account: REGISTRAR,
    roles: DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT,
    ...overrides,
  };
}

function expectation(
  overrides: Partial<RoleExpectation> = {},
): RoleExpectation {
  return {
    contract: "ETHRegistry",
    scope: "root",
    account: REGISTRAR,
    roles: DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT,
    ...overrides,
  };
}

describe("describeRoleBitmap", () => {
  it("names each bit in a registry bitmap", () => {
    const described = describeRoleBitmap(DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT);
    expect(described).toContain("REGISTRAR");
    expect(described).toContain("RENEW");
  });

  it("distinguishes an admin bit from its regular counterpart", () => {
    expect(describeRoleBitmap(ROLES.ADMIN.REGISTRY.REGISTRAR)).toBe(
      "REGISTRAR_ADMIN",
    );
    expect(describeRoleBitmap(ROLES.REGISTRY.REGISTRAR)).toBe("REGISTRAR");
  });

  it("reports an unrecognised bit rather than dropping it", () => {
    // Bit 44 is inside the role space but carries no name in this build.
    expect(describeRoleBitmap(1n << 44n)).toContain("unknown");
  });

  it("reads the empty bitmap as no roles", () => {
    expect(describeRoleBitmap(0n)).toBe("(none)");
  });

  it("uses the vocabulary of the contract family, since bits are reused", () => {
    // Bit 0 is REGISTRAR on a registry and SET_ADDRESS on a resolver.
    expect(describeRoleBitmap(1n << 0n, "REGISTRY")).toBe("REGISTRAR");
    expect(describeRoleBitmap(1n << 0n, "RESOLVER")).toBe("SET_ADDRESS");
  });
});

describe("diffRoleMatrix", () => {
  it("passes when holders match expectations exactly", () => {
    expect(diffRoleMatrix([holder()], [expectation()])).toEqual([]);
  });

  it("reports an account holding a role nobody granted it", () => {
    const findings = diffRoleMatrix(
      [holder({ account: STRANGER })],
      [expectation()],
    );

    expect(findings).toHaveLength(2);
    const unexpected = findings.find((f) => f.kind === "unexpected");
    expect(unexpected).toBeDefined();
    expect(describeRoleFinding(unexpected!)).toContain(STRANGER);
    expect(describeRoleFinding(unexpected!)).toContain("unexpected");
  });

  it("reports an extra role on an account that legitimately holds others", () => {
    const findings = diffRoleMatrix(
      [
        holder({
          roles:
            DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT | ROLES.REGISTRY.SET_PARENT,
        }),
      ],
      [expectation()],
    );

    expect(findings).toHaveLength(1);
    expect(describeRoleFinding(findings[0])).toContain("SET_PARENT");
  });

  it("reports an expected grant that was never made", () => {
    const findings = diffRoleMatrix([], [expectation()]);

    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("missing");
    expect(describeRoleFinding(findings[0])).toContain("missing");
  });

  it("reports a partially-revoked grant", () => {
    // Registrar/renew were revoked but the admin bits were left behind — the case a
    // single hasRootRoles spot-check reads as "disabled".
    const findings = diffRoleMatrix(
      [holder({ roles: ROLES.ADMIN.REGISTRY.REGISTRAR })],
      [expectation({ roles: 0n })],
    );

    expect(findings).toHaveLength(1);
    expect(describeRoleFinding(findings[0])).toContain("REGISTRAR_ADMIN");
  });

  it("treats scopes independently, so a token grant is not read as a root grant", () => {
    const findings = diffRoleMatrix(
      [holder({ scope: "eth" })],
      [expectation({ scope: "root" })],
    );

    expect(findings.map((f) => f.kind).sort()).toEqual([
      "missing",
      "unexpected",
    ]);
  });

  it("compares accounts case-insensitively", () => {
    const findings = diffRoleMatrix(
      [holder({ account: REGISTRAR.toUpperCase() })],
      [expectation({ account: REGISTRAR.toLowerCase() })],
    );

    expect(findings).toEqual([]);
  });

  it("unions multiple expectations for one account", () => {
    const findings = diffRoleMatrix(
      [
        holder({
          account: DEPLOYER,
          roles: ROLES.REGISTRY.REGISTRAR | ROLES.REGISTRY.RENEW,
        }),
      ],
      [
        expectation({ account: DEPLOYER, roles: ROLES.REGISTRY.REGISTRAR }),
        expectation({ account: DEPLOYER, roles: ROLES.REGISTRY.RENEW }),
      ],
    );

    expect(findings).toEqual([]);
  });
});
