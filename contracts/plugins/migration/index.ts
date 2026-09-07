import { emptyTask, task } from "hardhat/config";
import type { HardhatPlugin } from "hardhat/types/plugins";

// Intentionally real, long-lived .eth names: the resolution smoke checks should
// exercise names that actually exist on the target network with stable records.
const DEFAULT_VERIFY_SMOKE_NAMES = "raffy.eth,vitalik.eth,nick.eth";

const plugin: HardhatPlugin = {
  id: "ens-migration",
  tasks: [
    emptyTask("migration", "Run ENS migration operations").build(),
    task(["migration", "snapshot"], "Create an RPC state snapshot")
      .addOption({
        name: "file",
        description: "Optional file to write the snapshot id",
        defaultValue: "",
      })
      .setAction(() => import("./tasks/snapshot.ts"))
      .build(),
    task(["migration", "revert"], "Revert an RPC state snapshot")
      .addOption({
        name: "snapshotId",
        description: "Snapshot id returned by evm_snapshot",
        defaultValue: "",
      })
      .addOption({
        name: "file",
        description: "File containing the snapshot id",
        defaultValue: "",
      })
      .setAction(() => import("./tasks/revert.ts"))
      .build(),
    task(
      ["migration", "verify-all"],
      "Verify final migration wiring and resolution",
    )
      .addOption({
        name: "migrationNetwork",
        description: "Migration network: sepolia or mainnet",
        defaultValue: "sepolia",
      })
      .addOption({
        name: "deploymentNetwork",
        description: "Deployment directory network name",
        defaultValue: "",
      })
      .addOption({
        name: "deploymentsDir",
        description: "Root directory for v2 deployments",
        defaultValue: "./deployments",
      })
      .addOption({
        name: "names",
        description: "Comma-separated .eth names for resolution smoke checks",
        defaultValue: DEFAULT_VERIFY_SMOKE_NAMES,
      })
      .addOption({
        name: "topUrp",
        description: "Top UniversalResolverProxy address",
        defaultValue: "",
      })
      .setAction(() => import("./tasks/verify-all.ts"))
      .build(),
    task(
      ["migration", "batch-registrar-owner"],
      "Print and optionally verify the BatchRegistrar owner",
    )
      .addOption({
        name: "migrationNetwork",
        description: "Migration network: sepolia or mainnet",
        defaultValue: "sepolia",
      })
      .addOption({
        name: "deploymentNetwork",
        description: "Deployment directory network name",
        defaultValue: "",
      })
      .addOption({
        name: "deploymentsDir",
        description: "Root directory for v2 deployments",
        defaultValue: "./deployments",
      })
      .addOption({
        name: "batchRegistrar",
        description: "BatchRegistrar address",
        defaultValue: "",
      })
      .addOption({
        name: "expectedOwner",
        description: "Expected BatchRegistrar owner",
        defaultValue: "",
      })
      .addOption({
        name: "chainId",
        description: "Chain id override",
        defaultValue: "",
      })
      .setAction(() => import("./tasks/batch-registrar-owner.ts"))
      .build(),
    task(["migration", "fork-full"], "Run the full phased migration rehearsal")
      .addOption({
        name: "migrationNetwork",
        description: "Migration network: sepolia or mainnet",
        defaultValue: "sepolia",
      })
      .addOption({
        name: "csvFile",
        description: "Registration CSV",
        defaultValue: "",
      })
      .addOption({
        name: "batchSize",
        description: "Names per pre-migration batch",
        defaultValue: "",
      })
      .addOption({
        name: "initialLimit",
        description: "Optional cap before disabling v1 registrars",
        defaultValue: "",
      })
      .addOption({
        name: "finishLimit",
        description: "Optional cap after disabling v1 registrars",
        defaultValue: "",
      })
      .addOption({
        name: "workDir",
        description: "Directory for fork logs, checkpoints, and generated CSV",
        defaultValue: "",
      })
      .addOption({
        name: "resumeFromPhase",
        description: "Resume the full rehearsal from phase 2",
        defaultValue: "",
      })
      .addOption({
        name: "deploymentsDir",
        description: "Root directory for deployment files",
        defaultValue: "./deployments",
      })
      .addOption({
        name: "deploymentNetwork",
        description: "Deployment directory network name",
        defaultValue: "",
      })
      .addOption({
        name: "v1DeploymentsDir",
        description: "Root directory for v1 deployment files",
        defaultValue: "",
      })
      .addOption({
        name: "v1DeploymentNetwork",
        description: "V1 deployment directory network name",
        defaultValue: "",
      })
      .addOption({
        name: "snapshotFile",
        description: "Optional file to write a pre-rehearsal snapshot id",
        defaultValue: "",
      })
      .addOption({
        name: "deployer",
        description:
          "Migration deployer address; defaults to the configured Hardhat account",
        defaultValue: "",
      })
      .addOption({
        name: "owner",
        description:
          "Migration owner/admin address; defaults to the configured Hardhat account",
        defaultValue: "",
      })
      .addOption({
        name: "v1Owner",
        description:
          "V1 owner address; defaults to the network-configured v1 owner",
        defaultValue: "",
      })
      .addOption({
        name: "urManager",
        description:
          "Managed URP admin address; defaults to the configured Hardhat account",
        defaultValue: "",
      })
      .addOption({
        name: "chainId",
        description: "Chain id override",
        defaultValue: "",
      })
      .addOption({
        name: "port",
        description: "Local Anvil port",
        defaultValue: "",
      })
      .addFlag({
        name: "direct",
        description:
          "Use the configured Hardhat network directly instead of starting Anvil",
      })
      .addFlag({
        name: "saveDeployments",
        description: "Persist deployment files",
      })
      .addFlag({
        name: "includeTestnetPremigrationRegistrar",
        description: "Deploy the testnet v1 premigration registrar helper",
      })
      .addFlag({
        name: "debugRpc",
        description: "Log JSON-RPC error responses",
      })
      .addFlag({
        name: "keepAnvil",
        description: "Leave the local Anvil process running",
      })
      .addFlag({
        name: "requireFullCoverage",
        description:
          "Fail instead of silently running a reduced set of smoke checks",
      })
      .addOption({
        name: "resolutionNames",
        description:
          "Extra comma-separated names to snapshot and re-check across the phase 7 cutover",
        defaultValue: "",
      })
      .setAction(() => import("./tasks/fork-full.ts"))
      .build(),
    task(
      ["migration", "clean-testnet"],
      "Deploy fresh testnet v1 and run the full phased migration",
    )
      .addOption({
        name: "migrationNetwork",
        description: "Migration network: sepolia",
        defaultValue: "sepolia",
      })
      .addOption({
        name: "csvFile",
        description:
          "Optional registration CSV to seed in addition to generated smoke labels",
        defaultValue: "",
      })
      .addOption({
        name: "batchSize",
        description: "Names per pre-migration batch",
        defaultValue: "",
      })
      .addOption({
        name: "initialLimit",
        description: "Optional cap before disabling v1 registrars",
        defaultValue: "",
      })
      .addOption({
        name: "finishLimit",
        description: "Optional cap after disabling v1 registrars",
        defaultValue: "",
      })
      .addOption({
        name: "workDir",
        description:
          "Directory for clean deploy logs, checkpoints, and generated CSV",
        defaultValue: "",
      })
      .addOption({
        name: "deploymentsDir",
        description: "Root directory for v2 deployment files",
        defaultValue: "./deployments",
      })
      .addOption({
        name: "deploymentNetwork",
        description:
          "Deployment namespace for v2 files; defaults to sepolia-clean-<timestamp>",
        defaultValue: "",
      })
      .addOption({
        name: "v1DeploymentsDir",
        description: "Root directory for v1 deployment files",
        defaultValue: "./deployments/v1",
      })
      .addOption({
        name: "v1DeploymentNetwork",
        description:
          "Deployment namespace for v1 files; defaults to the v2 namespace",
        defaultValue: "",
      })
      .addOption({
        name: "snapshotFile",
        description:
          "Optional file to write a pre-phase snapshot id after v1 deployment",
        defaultValue: "",
      })
      .addOption({
        name: "deployer",
        description:
          "Migration deployer address; defaults to the configured Hardhat account",
        defaultValue: "",
      })
      .addOption({
        name: "owner",
        description: "Migration owner/admin address; defaults to the deployer",
        defaultValue: "",
      })
      .addOption({
        name: "v1Owner",
        description:
          "V1 owner address; defaults to the network-configured v1 owner",
        defaultValue: "",
      })
      .addOption({
        name: "urManager",
        description: "Managed URP admin address; defaults to the deployer",
        defaultValue: "",
      })
      .addOption({
        name: "chainId",
        description: "Chain id override",
        defaultValue: "",
      })
      .addFlag({
        name: "resumeExistingDeployments",
        description:
          "Resume a clean testnet namespace that already has deployment files",
      })
      .addFlag({
        name: "debugRpc",
        description: "Log JSON-RPC error responses",
      })
      .setAction(() => import("./tasks/clean-testnet.ts"))
      .build(),
    task(
      ["migration", "smoke-v2-registrar"],
      "Register a fresh .eth name through the enabled v2 registrar",
    )
      .addOption({
        name: "migrationNetwork",
        description: "Migration network: sepolia or mainnet",
        defaultValue: "sepolia",
      })
      .addOption({
        name: "deploymentNetwork",
        description: "Deployment directory network name",
        defaultValue: "",
      })
      .addOption({
        name: "deploymentsDir",
        description: "Root directory for v2 deployment files",
        defaultValue: "./deployments",
      })
      .addOption({
        name: "label",
        description: "Optional label to register without .eth",
        defaultValue: "",
      })
      .addOption({
        name: "owner",
        description: "Name owner; defaults to the configured Hardhat account",
        defaultValue: "",
      })
      .addOption({
        name: "chainId",
        description: "Chain id override",
        defaultValue: "",
      })
      .addFlag({
        name: "rpcStateControls",
        description: "Use fork RPC time controls for the commitment wait",
      })
      .setAction(() => import("./tasks/smoke-v2-registrar.ts"))
      .build(),
    task(
      ["migration", "set-v1-reverse-default-resolver"],
      "Point the v1 ReverseRegistrar default resolver at v1 PublicResolver",
    )
      .addOption({
        name: "migrationNetwork",
        description: "Migration network: sepolia or mainnet",
        defaultValue: "sepolia",
      })
      .addOption({
        name: "v1DeploymentsDir",
        description: "Root directory for v1 deployment files",
        defaultValue: "./deployments/v1",
      })
      .addOption({
        name: "v1DeploymentNetwork",
        description: "V1 deployment directory network name",
        defaultValue: "",
      })
      .addOption({
        name: "chainId",
        description: "Chain id override",
        defaultValue: "",
      })
      .addOption({
        name: "privateKey",
        description:
          "V1 owner private key (defaults to SEPOLIA_V1_OWNER_KEY/V1_OWNER_KEY, then the Hardhat account)",
        defaultValue: "",
      })
      .setAction(() => import("./tasks/set-v1-reverse-default-resolver.ts"))
      .build(),
    task(["migration", "deploy-v2"], "Deploy the v2 migration contracts")
      .addOption({
        name: "migrationNetwork",
        description: "Migration network: sepolia or mainnet",
        defaultValue: "sepolia",
      })
      .addOption({
        name: "deploymentsDir",
        description: "Root directory for v2 deployments",
        defaultValue: "./deployments",
      })
      .addOption({
        name: "deploymentNetwork",
        description: "Deployment directory network name",
        defaultValue: "",
      })
      .addOption({
        name: "v1DeploymentsDir",
        description: "Root directory for v1 deployment files",
        defaultValue: "",
      })
      .addOption({
        name: "v1DeploymentNetwork",
        description: "V1 deployment directory network name",
        defaultValue: "",
      })
      .addOption({
        name: "snapshotFile",
        description: "Optional file to write a pre-deploy snapshot id",
        defaultValue: "",
      })
      .addFlag({
        name: "saveDeployments",
        description: "Persist deployment files",
      })
      .addFlag({
        name: "includeTestnetPremigrationRegistrar",
        description: "Deploy the testnet v1 premigration registrar helper",
      })
      .addFlag({
        name: "deferV1OwnerTransactions",
        description:
          "Record v1-owner transactions instead of broadcasting them (requires --deferred-v1-owner-transactions-file)",
      })
      .addOption({
        name: "deferredV1OwnerTransactionsFile",
        description:
          "JSONL file for deferred v1-owner transactions (required when deferring)",
        defaultValue: "",
      })
      .addOption({
        name: "tags",
        description:
          "Comma-separated deploy tags to run instead of the default v2 migration tags",
        defaultValue: "",
      })
      .addFlag({
        name: "impersonateLegacyOwner",
        description: "Impersonate the v1 owner on a fork",
      })
      .addFlag({
        name: "debugRpc",
        description: "Log JSON-RPC error responses",
      })
      .addOption({
        name: "chainId",
        description: "Chain id override",
        defaultValue: "",
      })
      .addOption({
        name: "deployer",
        description: "Deployer account address",
        defaultValue: "",
      })
      .addOption({
        name: "owner",
        description: "Owner/admin address",
        defaultValue: "",
      })
      .addOption({
        name: "urManager",
        description: "Managed URP admin address",
        defaultValue: "",
      })
      .addOption({
        name: "v1Owner",
        description:
          "v1 owner address for v1 writes; defaults to the network-configured v1 owner",
        defaultValue: "",
      })
      .setAction(() => import("./tasks/deploy-v2.ts"))
      .build(),
    task(["migration", "premigration-run"], "Run pre-migration reservations")
      .addOption({
        name: "migrationNetwork",
        description: "Migration network: sepolia or mainnet",
        defaultValue: "sepolia",
      })
      .addOption({
        name: "deploymentsDir",
        description: "Root directory for v2 deployments",
        defaultValue: "./deployments",
      })
      .addOption({
        name: "deploymentNetwork",
        description: "Deployment directory network name",
        defaultValue: "",
      })
      .addOption({
        name: "v1DeploymentsDir",
        description: "Root directory for v1 deployment files",
        defaultValue: "",
      })
      .addOption({
        name: "v1DeploymentNetwork",
        description: "V1 deployment directory network name",
        defaultValue: "",
      })
      .addOption({
        name: "csvFile",
        description: "Pre-migration CSV",
        defaultValue: "",
      })
      .addOption({
        name: "mainnetRpcUrl",
        description: "RPC URL for v1 expiry reads",
        defaultValue: "",
      })
      .addOption({
        name: "batchSize",
        description: "Names per batch",
        defaultValue: "50",
      })
      .addOption({
        name: "limit",
        description: "Maximum names to process",
        defaultValue: "",
      })
      .addOption({
        name: "bonusPeriodDays",
        description:
          "Days added to each name's v1 expiry to compute its v2 expiry",
        defaultValue: "",
      })
      .addOption({
        name: "workDir",
        description: "Directory for checkpoints and logs",
        defaultValue: "",
      })
      .addFlag({
        name: "dryRun",
        description: "Simulate without transactions",
      })
      .addFlag({
        name: "resume",
        description: "Resume from checkpoint",
      })
      .setAction(() => import("./tasks/premigration-run.ts"))
      .build(),
  ],
};

export default plugin;
