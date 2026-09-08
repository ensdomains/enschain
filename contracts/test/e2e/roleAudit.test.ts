import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDeploymentNamespace } from "../utils/deploymentArtifacts.js";
import { getAddress, type Address } from "viem";

import { DEPLOYMENT_ROLES, ROLES } from "../../script/deploy-constants.js";
import { verifyV2Roles } from "../../script/migrate.js";
import { idFromLabel } from "../utils/utils.js";

const TEST_TIMEOUT_MS = 120_000;
const NETWORK = "mainnet";
const NAMESPACE = "mainnet";

// Contracts the audit expects to find, mirroring what the deploy scripts grant.
const AUDITED_DEPLOYMENTS = [
  "RootRegistry",
  "ETHRegistry",
  "ETHRegistrar",
  "BatchRegistrar",
  "ETHRenewerV1",
  "UnlockedMigrationController",
  "LockedMigrationController",
] as const;

describe("v2 role audit", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;
  const workDir = mkdtempSync(join(tmpdir(), "role-audit-"));
  const deploymentsDir = join(workDir, "v2");

  setupEnv({ resetOnEach: true });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // Writes the deployment records the audit resolves addresses from. Only contracts
  // this devnet actually deployed are written, so the audit sees the real set.
  function writeDeploymentArtifacts() {
    rmSync(deploymentsDir, { recursive: true, force: true });
    writeDeploymentNamespace(
      deploymentsDir,
      NAMESPACE,
      AUDITED_DEPLOYMENTS.flatMap((name) => {
        const deployment = env.rocketh.deployments[name];
        return deployment ? [[name, deployment] as const] : [];
      }),
    );
  }

  function audit(overrides: Record<string, unknown> = {}) {
    return verifyV2Roles({
      network: NETWORK,
      rpcUrl: `http://${env.hostPort}`,
      chainId: "1",
      deploymentsDir,
      deploymentNetwork: NAMESPACE,
      deployer: env.namedAccounts.deployer.address,
      owner: env.namedAccounts.owner.address,
      fromBlock: "0",
      ...overrides,
    });
  }

  it(
    "reads role holders live and reports them against the deployment's intent",
    async () => {
      writeDeploymentArtifacts();

      const findings = await audit({ reportOnly: true });

      // The devnet grants its deployer REGISTRAR so fixtures can register `ens.eth`
      // (script/setup.ts). Production grants only REGISTRAR_ADMIN, so the audit
      // should surface this as a privilege the deployment does not intend — which is
      // precisely the class of leftover grant it exists to find.
      const deployerFinding = findings.find(
        (finding) =>
          finding.kind === "unexpected" &&
          finding.holder.contract === "ETHRegistry" &&
          getAddress(finding.holder.account as Address) ===
            getAddress(env.namedAccounts.deployer.address),
      );
      expect(deployerFinding).toBeDefined();
      expect(
        deployerFinding && "extra" in deployerFinding
          ? deployerFinding.extra
          : 0n,
      ).toBe(ROLES.REGISTRY.REGISTRAR);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "catches a stray role grant that no per-address spot check would look for",
    async () => {
      writeDeploymentArtifacts();
      const stranger = getAddress(
        "0x000000000000000000000000000000000000beef",
      ) as Address;

      const before = await audit({ reportOnly: true });
      expect(
        before.some(
          (finding) =>
            finding.kind === "unexpected" &&
            getAddress(finding.holder.account as Address) === stranger,
        ),
      ).toBe(false);

      // Grant a role to an address the deployment knows nothing about.
      await env.v2.ETHRegistry.write.grantRootRoles(
        [ROLES.REGISTRY.REGISTRAR, stranger],
        { account: env.namedAccounts.deployer },
      );

      await expect(audit()).rejects.toThrow(/role audit failed/);

      const after = await audit({ reportOnly: true });
      const finding = after.find(
        (candidate) =>
          candidate.kind === "unexpected" &&
          getAddress(candidate.holder.account as Address) === stranger,
      );
      expect(finding).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "audits the token-scoped grants the deployment makes, not just the root",
    async () => {
      writeDeploymentArtifacts();

      // `register` grants its bitmap at the token's resource, so the `.eth` and
      // `.reverse` grants are invisible to a root-only sweep.
      const findings = await audit({ reportOnly: true });
      for (const scope of ["eth", "reverse"]) {
        expect(
          findings.some(
            (finding) =>
              finding.kind === "missing" && finding.expectation.scope === scope,
          ),
        ).toBe(false);
      }

      // Revoking the .eth grant is now visible. Before the scoped sweep the audit
      // read only resource 0 and reported success over exactly this state.
      const ethResource = await env.v2.RootRegistry.read.getResource([
        idFromLabel("eth"),
      ]);
      await env.v2.RootRegistry.write.revokeRoles(
        [
          ethResource,
          DEPLOYMENT_ROLES.ETH_TOKEN,
          env.namedAccounts.deployer.address,
        ],
        { account: env.namedAccounts.deployer },
      );

      const after = await audit({ reportOnly: true });
      const missing = after.find(
        (finding) =>
          finding.kind === "missing" && finding.expectation.scope === "eth",
      );
      expect(missing).toBeDefined();
      expect(missing && "absent" in missing ? missing.absent : 0n).toBe(
        DEPLOYMENT_ROLES.ETH_TOKEN,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "catches a stray grant scoped to a token rather than the root",
    async () => {
      writeDeploymentArtifacts();
      const stranger = getAddress(
        "0x000000000000000000000000000000000000cafe",
      ) as Address;

      const reverseResource = await env.v2.RootRegistry.read.getResource([
        idFromLabel("reverse"),
      ]);
      await env.v2.RootRegistry.write.grantRoles(
        [reverseResource, ROLES.REGISTRY.SET_RESOLVER, stranger],
        { account: env.namedAccounts.owner },
      );

      const findings = await audit({ reportOnly: true });
      const finding = findings.find(
        (candidate) =>
          candidate.kind === "unexpected" &&
          getAddress(candidate.holder.account as Address) === stranger,
      );
      expect(finding).toBeDefined();
      expect(finding && "holder" in finding ? finding.holder.scope : "").toBe(
        "reverse",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "catches admin bits left behind when only the regular roles were revoked",
    async () => {
      writeDeploymentArtifacts();
      const batchRegistrar = env.rocketh.deployments.BatchRegistrar;
      if (!batchRegistrar) return;

      // Grant admin bits the deployment never intends BatchRegistrar to hold. A
      // hasRootRoles(REGISTRAR|RENEW) spot check reads this as disabled.
      await env.v2.ETHRegistry.write.grantRootRoles(
        [ROLES.ADMIN.REGISTRY.REGISTRAR, batchRegistrar.address],
        { account: env.namedAccounts.deployer },
      );

      // Audited as the pre-handoff state, where BatchRegistrar legitimately holds
      // REGISTRAR | RENEW to seed reservations. Only the admin bit is unaccounted
      // for, which is exactly the leftover a per-address spot check cannot see.
      const preHandoff = await audit({ reportOnly: true, preHandoff: true });
      const adminLeftover = preHandoff.find(
        (candidate) =>
          candidate.kind === "unexpected" &&
          getAddress(candidate.holder.account as Address) ===
            getAddress(batchRegistrar.address),
      );
      expect(adminLeftover).toBeDefined();
      expect(
        adminLeftover && "extra" in adminLeftover ? adminLeftover.extra : 0n,
      ).toBe(ROLES.ADMIN.REGISTRY.REGISTRAR);

      // Audited as the final state, phase 6 should have stripped BatchRegistrar
      // entirely, so its seeding roles are reported alongside the admin bit.
      const findings = await audit({ reportOnly: true });
      const finding = findings.find(
        (candidate) =>
          candidate.kind === "unexpected" &&
          getAddress(candidate.holder.account as Address) ===
            getAddress(batchRegistrar.address),
      );
      expect(finding).toBeDefined();
      const extra = finding && "extra" in finding ? finding.extra : 0n;
      expect(extra & ROLES.ADMIN.REGISTRY.REGISTRAR).toBe(
        ROLES.ADMIN.REGISTRY.REGISTRAR,
      );
      expect(extra & DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT).toBe(
        DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT,
      );
    },
    TEST_TIMEOUT_MS,
  );
});
