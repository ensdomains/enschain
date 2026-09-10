#!/usr/bin/env bun

import { Command } from "commander";
import { getContract, isAddress, type Address, type Hex } from "viem";
import { waitForSuccessfulTransactionReceipt } from "../test/utils/waitForSuccessfulTransactionReceipt.js";
import { DEPLOYMENT_ROLES, ROLES } from "./deploy-constants.js";
import { bold, cyan, dim, green, Logger, red, yellow } from "./logger.js";
import { createV2Clients, loadArtifact } from "./scriptUtils.js";

class PrepareLogger extends Logger {
  line(msg: string): void {
    this.raw(msg);
  }
}

const ROLE_NAMES: Array<[bigint, string]> = [
  [ROLES.REGISTRY.REGISTRAR, "ROLE_REGISTRAR"],
  [ROLES.ADMIN.REGISTRY.REGISTRAR, "ROLE_REGISTRAR_ADMIN"],
  [ROLES.REGISTRY.REGISTER_RESERVED, "ROLE_REGISTER_RESERVED"],
  [ROLES.ADMIN.REGISTRY.REGISTER_RESERVED, "ROLE_REGISTER_RESERVED_ADMIN"],
  [ROLES.REGISTRY.RENEW, "ROLE_RENEW"],
  [ROLES.ADMIN.REGISTRY.RENEW, "ROLE_RENEW_ADMIN"],
];

function describeRoles(bitmap: bigint): string {
  const matched = ROLE_NAMES.filter(([bit]) => (bitmap & bit) === bit).map(
    ([, name]) => name,
  );
  return matched.length ? matched.join(" | ") : "(none)";
}

type Op =
  | { kind: "grant"; label: string; account: Address; roles: bigint }
  | { kind: "revoke"; label: string; account: Address; roles: bigint };

interface Config {
  rpcUrl: string;
  registryAddress: Address;
  batchRegistrarAddress: Address;
  ethRegistrarAddress: Address;
  unlockedMigrationControllerAddress: Address;
  lockedMigrationControllerAddress: Address;
  privateKey: Hex | null;
  execute: boolean;
}

function requireAddress(value: string | undefined, flag: string): Address {
  if (!value || !isAddress(value)) {
    throw new Error(`${flag} must be a valid 0x-prefixed address`);
  }
  return value as Address;
}

function parseArgs(argv: string[]): Config {
  const program = new Command()
    .name("prepareMigration")
    .description(
      "Prepare .eth PermissionedRegistry for live migration: fully decommission BatchRegistrar (revoke all its roles) and grant registration and renewal roles to ETHRegistrar plus the reservation-promotion role to both migration controllers.",
    )
    .requiredOption("--rpc-url <url>", "JSON-RPC endpoint")
    .requiredOption("--registry <address>", ".eth PermissionedRegistry address")
    .requiredOption("--batch-registrar <address>", "BatchRegistrar address")
    .requiredOption("--eth-registrar <address>", "ETHRegistrar address")
    .requiredOption(
      "--unlocked-migration-controller <address>",
      "UnlockedMigrationController address",
    )
    .requiredOption(
      "--locked-migration-controller <address>",
      "LockedMigrationController address",
    )
    .option(
      "--private-key <hex>",
      "signer private key (required with --execute)",
    )
    .option("--execute", "broadcast transactions (default: dry run)", false)
    .parse(argv);

  const opts = program.opts();
  const privateKey = opts.privateKey
    ? ((opts.privateKey.startsWith("0x")
        ? opts.privateKey
        : `0x${opts.privateKey}`) as Hex)
    : null;

  if (opts.execute && !privateKey) {
    throw new Error("--execute requires --private-key");
  }

  return {
    rpcUrl: opts.rpcUrl,
    registryAddress: requireAddress(opts.registry, "--registry"),
    batchRegistrarAddress: requireAddress(
      opts.batchRegistrar,
      "--batch-registrar",
    ),
    ethRegistrarAddress: requireAddress(opts.ethRegistrar, "--eth-registrar"),
    unlockedMigrationControllerAddress: requireAddress(
      opts.unlockedMigrationController,
      "--unlocked-migration-controller",
    ),
    lockedMigrationControllerAddress: requireAddress(
      opts.lockedMigrationController,
      "--locked-migration-controller",
    ),
    privateKey,
    execute: !!opts.execute,
  };
}

function buildOps(cfg: Config): Op[] {
  return [
    {
      kind: "revoke",
      label: "BatchRegistrar",
      account: cfg.batchRegistrarAddress,
      // Revoke every bit granted at static deploy plus admin counterparts and
      // REGISTER_RESERVED pair so the post-state is unambiguously empty.
      roles:
        DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT |
        ROLES.ADMIN.REGISTRY.REGISTRAR |
        ROLES.ADMIN.REGISTRY.RENEW |
        DEPLOYMENT_ROLES.MIGRATION_CONTROLLER_ROOT |
        ROLES.ADMIN.REGISTRY.REGISTER_RESERVED,
    },
    {
      kind: "grant",
      label: "ETHRegistrar",
      account: cfg.ethRegistrarAddress,
      roles: DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT,
    },
    {
      kind: "grant",
      label: "UnlockedMigrationController",
      account: cfg.unlockedMigrationControllerAddress,
      roles: DEPLOYMENT_ROLES.MIGRATION_CONTROLLER_ROOT,
    },
    {
      kind: "grant",
      label: "LockedMigrationController",
      account: cfg.lockedMigrationControllerAddress,
      roles: DEPLOYMENT_ROLES.MIGRATION_CONTROLLER_ROOT,
    },
  ];
}

// Admin bits needed to grant/revoke a given role bitmap: each low-128 role bit
// requires its paired admin bit at (bit << 128); admin bits are self-admin.
function requiredAdminBits(roles: bigint): bigint {
  const LOW_MASK = (1n << 128n) - 1n;
  const low = roles & LOW_MASK;
  const high = roles & ~LOW_MASK;
  return (low << 128n) | high;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const cfg = parseArgs(argv);
  const logger = new PrepareLogger();

  const { abi: registryAbi } = loadArtifact("PermissionedRegistry");
  const { publicClient, walletClient, account } = await createV2Clients({
    rpcUrl: cfg.rpcUrl,
    privateKey: cfg.privateKey,
  });

  const registryRead = getContract({
    abi: registryAbi,
    address: cfg.registryAddress,
    client: publicClient,
  });
  const registryWrite = walletClient
    ? getContract({
        abi: registryAbi,
        address: cfg.registryAddress,
        client: walletClient,
      })
    : null;

  const ops = buildOps(cfg);

  logger.header("Prepare-Migration");
  logger.config("RPC", cfg.rpcUrl);
  logger.config("Registry", cfg.registryAddress);
  logger.config("Signer", account?.address ?? "(none — dry run)");
  logger.config("Mode", cfg.execute ? "EXECUTE" : "DRY RUN");

  logger.header("Planned operations");
  for (const op of ops) {
    const current = (await registryRead.read.roles([0n, op.account])) as bigint;
    logger.line(
      `${op.kind === "grant" ? green("+ GRANT ") : red("- REVOKE")} ${bold(op.label)} ${dim(op.account)}`,
    );
    logger.line(`    roles: ${describeRoles(op.roles)}`);
    logger.line(dim(`    current on-chain: ${describeRoles(current)}`));
  }

  if (account) {
    logger.header("Signer admin-role pre-flight");
    const signerRoles = (await registryRead.read.roles([
      0n,
      account.address,
    ])) as bigint;
    logger.line(dim(`    signer root roles: ${describeRoles(signerRoles)}`));
    let missing = 0n;
    for (const op of ops) {
      const lacks = requiredAdminBits(op.roles) & ~signerRoles;
      if (lacks !== 0n) {
        logger.error(
          `signer missing admin bits for ${op.label} ${op.kind}: ${describeRoles(lacks)}`,
        );
        missing |= lacks;
      }
    }
    if (missing !== 0n) {
      throw new Error("signer lacks required admin roles; aborting");
    }
    logger.success("signer holds all required admin roles");
  }

  if (!cfg.execute || !registryWrite) {
    logger.header("Dry run complete");
    logger.line(yellow("no transactions broadcast; pass --execute to proceed"));
    return;
  }

  logger.header("Executing");
  for (const op of ops) {
    logger.line(
      cyan(`→ ${op.kind.toUpperCase()} ${op.label} ${dim(op.account)}`),
    );
    const fn = op.kind === "grant" ? "grantRootRoles" : "revokeRootRoles";
    const hash = await (registryWrite.write as any)[fn]([op.roles, op.account]);
    logger.line(dim(`    tx: ${hash}`));
    await waitForSuccessfulTransactionReceipt(publicClient, { hash });
    logger.success(`${op.label} ${op.kind} confirmed`);
  }

  logger.header("Final state");
  for (const op of ops) {
    const after = (await registryRead.read.roles([0n, op.account])) as bigint;
    logger.line(`${bold(op.label)} ${dim(op.account)}`);
    logger.line(dim(`    roles: ${describeRoles(after)}`));
  }
  logger.success("prepare-migration complete");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
