import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAddress,
  isAddress,
  parseEther,
  zeroAddress,
  type Address,
} from "viem";

import {
  FUSES,
  PREMIGRATION_BONUS_PERIOD,
  SEC_PER_DAY,
  STATUS,
} from "./deploy-constants.js";
import { main as preMigrationMain } from "./preMigration.js";
import {
  buildMainArgs,
  createCSVFile,
  verifyV2State,
} from "./preMigrationUtils.js";
import type { DevnetEnvironment } from "./setup.js";
import { idFromLabel, namehash } from "../test/utils/utils.js";

// Curated real-mainnet .eth 2LDs sourced from morticia's e2e scenario config
// (test/e2e/test-e2e-mainnet-fork-config.json). Chosen to span every migration
// criterion in ten names: unwrapped, wrapped-locked, and wrapped-but-unlocked,
// so the frontend has both migration paths and the notable fuse edge cases.
// Only labels are pinned; every live property (wrap state, owner, fuses,
// expiry) is read from the fork at runtime, so the set survives any fork block.
const CURATED_NAMES: { label: string; note: string }[] = [
  {
    label: "swissborg",
    note: "normal unwrapped happy-path (alphabetic, resolver set)",
  },
  { label: "00relayer", note: "unwrapped, leading-zero label, small subtree" },
  { label: "2718", note: "unwrapped, all-numeric label, multi-subname" },
  { label: "$beep", note: "wrapped-locked, special '$' char, minimal subtree" },
  {
    label: "agi",
    note: "wrapped-locked, carries a locked child + third-party child",
  },
  {
    label: "ethscriptions",
    note: "wrapped-locked, burn-address owner, emancipated child",
  },
  {
    label: "holer",
    note: "wrapped-but-UNLOCKED/emancipated (no CANNOT_UNWRAP)",
  },
  { label: "analyzes", note: "wrapped-locked, shared batch owner" },
  { label: "daomarketplace", note: "wrapped-locked, shared batch owner" },
  {
    label: "alertbot",
    note: "wrapped-locked + CANNOT_TRANSFER (reassignment skipped)",
  },
];

export interface PreMigrateDevnetOptions {
  // A devnet named account key (deployer/owner/user/user2) or a raw address to
  // receive v1 ownership of the reserved names. When unset, names are left
  // reserved-only (still owned by their real forked mainnet owners).
  reassignOwnerTo?: string;
  // Override the curated label set (for tests and smoke runs).
  labels?: string[];
}

// The BaseRegistrar ERC-721 id is the labelhash; the NameWrapper ERC-1155 id
// is the namehash of the full 2LD.
function nameWrapperId(label: string): bigint {
  return BigInt(namehash(`${label}.eth`));
}

function resolveTarget(env: DevnetEnvironment, keyOrAddress: string): Address {
  if (keyOrAddress in env.namedAccounts) {
    return env.namedAccounts[
      keyOrAddress as keyof DevnetEnvironment["namedAccounts"]
    ].address;
  }
  if (isAddress(keyOrAddress)) {
    return getAddress(keyOrAddress);
  }
  throw new Error(
    `--preMigrateOwner must be a named account (${Object.keys(
      env.namedAccounts,
    ).join(", ")}) or an address, got: ${keyOrAddress}`,
  );
}

async function fund(env: DevnetEnvironment, address: Address): Promise<void> {
  await env.client.setBalance({ address, value: parseEther("100") });
}

// Move v1 ownership of a reserved name to `target` so a fixed devnet wallet
// owns it and can drive the migration in-app. Anvil autoImpersonate lets us
// send from the real owner directly. Returns how the name was handled.
async function reassignOwner(
  env: DevnetEnvironment,
  label: string,
  target: Address,
): Promise<"wrapped" | "unwrapped" | "skipped"> {
  const [wrapperOwner, fuses] = await env.v1.NameWrapper.read.getData([
    nameWrapperId(label),
  ]);

  if (wrapperOwner !== zeroAddress) {
    if ((Number(fuses) & FUSES.CANNOT_TRANSFER) !== 0) {
      console.log(
        `  ⊘ ${label}.eth: CANNOT_TRANSFER burned — left reserve-only`,
      );
      return "skipped";
    }
    await fund(env, wrapperOwner);
    await env.waitFor(
      env.v1.NameWrapper.write.safeTransferFrom(
        [wrapperOwner, target, nameWrapperId(label), 1n, "0x"],
        { account: wrapperOwner },
      ),
    );
    return "wrapped";
  }

  const labelId = idFromLabel(label);
  const registrant = await env.v1.BaseRegistrar.read.ownerOf([labelId]);
  if (registrant === zeroAddress) {
    console.log(`  ⊘ ${label}.eth: no v1 owner — left reserve-only`);
    return "skipped";
  }
  await fund(env, registrant);
  await env.waitFor(
    env.v1.BaseRegistrar.write.transferFrom([registrant, target, labelId], {
      account: registrant,
    }),
  );
  // Align the ENS registry record with the new token owner. Non-fatal.
  try {
    await fund(env, target);
    await env.waitFor(
      env.v1.BaseRegistrar.write.reclaim([labelId, target], {
        account: target,
      }),
    );
  } catch (err) {
    console.log(`  ! ${label}.eth: reclaim skipped (${err})`);
  }
  return "unwrapped";
}

// Pre-migrate the curated names on a running fork devnet: reserve them on v2
// (RESERVED state, ENSV1Resolver fallback) and optionally reassign v1 ownership
// to a devnet account. Intended to be called after env.activateV2() in fork mode.
export async function preMigrateDevnetNames(
  env: DevnetEnvironment,
  opts: PreMigrateDevnetOptions = {},
): Promise<void> {
  // Resolve the reassignment target up front so a bad value fails before the
  // reservation work.
  const target = opts.reassignOwnerTo
    ? resolveTarget(env, opts.reassignOwnerTo)
    : undefined;

  const names = opts.labels
    ? opts.labels.map((label) => ({ label, note: "override" }))
    : CURATED_NAMES;
  const labels = names.map((n) => n.label);
  console.log(`\n========== Pre-migrating ${labels.length} names ==========`);
  for (const { label, note } of names) {
    console.log(`  • ${label}.eth — ${note}`);
  }

  const csvPath = join(
    tmpdir(),
    `devnet-premigrate-${env.client.chain.id}.csv`,
  );
  createCSVFile(csvPath, labels);
  // Mirror the DAO pre-migration by extending each v2 expiry with the
  // production bonus period, so names within the v1 grace period (or expiring
  // during testing) stay RESERVED on v2 rather than reading back as AVAILABLE.
  await preMigrationMain(
    buildMainArgs(env, csvPath, {
      limit: labels.length,
      bonusPeriodDays: Number(PREMIGRATION_BONUS_PERIOD / SEC_PER_DAY),
    }),
  );

  if (target) {
    console.log(`\nReassigning v1 ownership to ${target}...`);
    // Default anvil accounts carry an EIP-7702 delegation on mainnet; the
    // ERC-1155 acceptance check reverts against delegated code, so clear it and
    // let the target receive wrapped names as a plain EOA.
    await env.client.setCode({ address: target, bytecode: "0x" });
  }

  const summary: {
    Name: string;
    Status: string;
    Reassigned: string;
  }[] = [];
  for (const { label } of names) {
    const { status } = await verifyV2State(env, label);
    const statusLabel =
      status === STATUS.RESERVED
        ? "reserved"
        : status === STATUS.REGISTERED
          ? "registered"
          : "available";

    let reassigned = "—";
    if (target) {
      if (status === STATUS.RESERVED) {
        try {
          reassigned = await reassignOwner(env, label, target);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ✗ ${label}.eth: reassignment failed — ${msg}`);
          reassigned = "failed";
        }
      } else {
        reassigned = "skipped (not reserved)";
      }
    }
    summary.push({
      Name: `${label}.eth`,
      Status: statusLabel,
      Reassigned: reassigned,
    });
  }

  console.table(summary);
}
