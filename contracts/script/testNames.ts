import { encodeFunctionData, namehash, zeroAddress } from "viem";

import { MAX_EXPIRY, ROLES, STATUS } from "./deploy-constants.js";
import { dnsEncodeName, dnsDecodeName } from "../test/utils/utils.js";
import type { DevnetEnvironment } from "./setup.js";
import {
  trackGas,
  displayGasReport,
  resetGasTracker,
} from "./testNames/gas.js";
import {
  getNameData,
  createSubname,
  linkName,
  transferName,
  changeRole,
  reserveName,
  unregisterName,
} from "./testNames/registry.js";
import {
  registerTestNames,
  reregisterName,
  renewName,
} from "./testNames/registrar.js";
import { showName, formatStatus } from "./testNames/display.js";
import { ADDR_ABI } from "../test/utils/resolver-abis.js";

// Re-export all utilities for external consumers
export {
  showName,
  createSubname,
  linkName,
  renewName,
  transferName,
  changeRole,
  registerTestNames,
  reregisterName,
  reserveName,
  unregisterName,
};

const ONE_DAY_SECONDS = 86400;

/**
 * Set up test names with various states and configurations for development/testing
 */
export async function testNames(env: DevnetEnvironment) {
  resetGasTracker();

  console.log("\n========== Starting testNames with Gas Tracking ==========\n");

  // Register reregister
  await registerTestNames(env, ["reregister"], { trackGas: true });
  // Re-register reregister (with time warp, do first to avoid expiring other names)
  await reregisterName(env, "reregister");

  // Register all other test names with default 28 day expiry
  await registerTestNames(
    env,
    [
      "test",
      "alias",
      "example",
      "demo",
      "newowner",
      "renew",
      "parent",
      "changerole",
      "unregistered",
    ],
    { trackGas: true },
  );

  // Transfer newowner.eth to user
  const transferReceipt = await transferName(
    env,
    "newowner.eth",
    env.namedAccounts.user.address,
  );
  trackGas("transfer(newowner)", transferReceipt);

  // Renew renew.eth for 365 days
  const renewReceipt = await renewName(env, "renew.eth", 365);
  trackGas("renew(renew)", renewReceipt);

  // Register alias.eth pointing to test.eth's resolver, then set alias
  console.log("\nCreating alias: alias.eth → test.eth");
  const testNameData = await getNameData(env, "test.eth");
  if (!testNameData || testNameData.resolver === zeroAddress) {
    throw new Error("test.eth has no resolver set");
  }

  const aliasTx = await env.waitFor(
    env.namedAccounts.owner.resolver.write.linkToNode([
      dnsEncodeName("alias.eth"),
      namehash("test.eth"),
    ]),
  );
  trackGas("link(alias→test)", aliasTx);
  console.log("✓ alias.eth → test.eth alias created");

  // Create sub2.parent.eth with 1-year expiry to demonstrate subname expiration
  const { timestamp } = await env.client.getBlock();
  const sub2Names = await createSubname(env, "sub2.parent.eth", {
    expiry: timestamp + BigInt(365 * ONE_DAY_SECONDS),
  });

  await createSubname(env, "sub2.parent.eth");

  // Create remaining subname levels (sub2 already exists, will be skipped)
  const deeperNames = await createSubname(env, "wallet.sub1.sub2.parent.eth");

  // Verify setParent works by checking both findCanonicalRegistry and findCanonicalName.
  // These only work when setParent is correctly set on every UserRegistry in the chain.
  // findCanonicalRegistry: walks top-down to find the registry, then verifies bottom-up.
  // findCanonicalName: walks bottom-up from a registry to root, building the DNS name.
  const namesWithSubregistries = [
    "parent.eth",
    "sub2.parent.eth",
    "sub1.sub2.parent.eth",
  ];
  for (const name of namesWithSubregistries) {
    const canonicalRegistry =
      await env.v2.UniversalHelper.read.findCanonicalRegistry([
        dnsEncodeName(name),
      ]);
    if (canonicalRegistry === zeroAddress) {
      throw new Error(
        `findCanonicalRegistry failed for ${name} — setParent may be missing`,
      );
    }

    const canonicalNameBytes =
      await env.v2.UniversalHelper.read.findCanonicalName([canonicalRegistry]);
    const canonicalName =
      canonicalNameBytes && canonicalNameBytes !== "0x"
        ? dnsDecodeName(canonicalNameBytes)
        : "";
    if (canonicalName !== name) {
      throw new Error(
        `findCanonicalName mismatch for ${name}: got "${canonicalName}"`,
      );
    }
    console.log(
      `✓ setParent verified: ${name} ↔ ${canonicalRegistry.slice(0, 9)}..`,
    );
  }

  // Link sub1.sub2.parent.eth to parent.eth with different label (creates linked.parent.eth with shared children)
  // Now wallet.linked.parent.eth and wallet.sub1.sub2.parent.eth will be the same token
  await linkName(env, "sub1.sub2.parent.eth", "linked.parent.eth");

  // With PermissionedResolver (node-keyed), children of linked names need an alias so
  // that wallet.linked.parent.eth resolves to the same records as wallet.sub1.sub2.parent.eth
  await env.namedAccounts.owner.resolver.write.linkToNode([
    dnsEncodeName("sub1.sub2.parent.eth"),
    namehash("linked.parent.eth"),
  ]);
  console.log(
    "✓ Set alias on wallet resolver: linked.parent.eth → sub1.sub2.parent.eth",
  );

  // Change roles on changerole.eth
  const roleReceipts = await changeRole(
    env,
    "changerole.eth",
    env.namedAccounts.user.address,
    ROLES.REGISTRY.SET_RESOLVER,
    ROLES.REGISTRY.SET_SUBREGISTRY,
  );
  for (const receipt of roleReceipts) {
    trackGas("changeRole(changerole)", receipt);
  }

  // Reserve a name (no owner, no token minted)
  {
    const name = "reserved.eth";
    const reserveReceipt = await reserveName(env, name);
    trackGas(`reserve(${name})`, reserveReceipt);
  }

  // Register then unregister a name
  // note: no one has permissions to unregister an .eth 2LD
  {
    const name = "sub.unregistered.eth";
    await createSubname(env, name);
    const unregisterReceipt = await unregisterName(
      env,
      name,
      env.namedAccounts.owner,
    );
    trackGas(`unregister(${name})`, unregisterReceipt);
  }

  const allNames = [
    "test.eth",
    "example.eth",
    "demo.eth",
    "newowner.eth",
    "renew.eth",
    "reregister.eth",
    "parent.eth",
    "changerole.eth",
    "alias.eth",
    "sub.alias.eth",
    "reserved.eth",
    "unregistered.eth",
    "sub.unregistered.eth",
    ...sub2Names,
    ...deeperNames,
    "linked.parent.eth",
    "wallet.linked.parent.eth",
  ];

  await showName(env, allNames);

  // Verify all names are properly registered
  await verifyNames(env, allNames);

  // Display gas report at the end
  displayGasReport();
}

// ========== Verification ==========

async function verifyNames(env: DevnetEnvironment, names: string[]) {
  console.log("\n========== Verifying Names ==========\n");
  const errors: string[] = [];
  const remainder = new Set(names);

  // Names that are reserved (no owner, no token)
  for (const name of ["reserved.eth"]) {
    remainder.delete(name);
    const data = await getNameData(env, name);
    if (data?.status !== STATUS.RESERVED) {
      errors.push(
        `${name}: expected RESERVED status (${formatStatus(STATUS.RESERVED)}), got ${formatStatus(data?.status)}`,
      );
    }
  }

  // Names that were unregistered (back to AVAILABLE)
  for (const name of ["sub.unregistered.eth"]) {
    remainder.delete(name);
    const data = await getNameData(env, name);
    if (data?.status !== STATUS.AVAILABLE) {
      errors.push(
        `${name}: expected AVAILABLE status (${formatStatus(STATUS.AVAILABLE)}), got ${formatStatus(data?.status)}`,
      );
    }
  }

  // Names that resolve only via alias (not directly registered in registry)
  for (const name of ["sub.alias.eth"]) {
    remainder.delete(name);
    try {
      const addrCall = encodeFunctionData({
        abi: ADDR_ABI,
        functionName: "addr",
        args: [namehash(name)],
      });
      // Verify alias resolution via UniversalResolver
      await env.v2.UniversalResolver.read.resolve([
        dnsEncodeName(name),
        addrCall,
      ]);
    } catch (e) {
      errors.push(`${name}: alias resolution failed — ${e}`);
    }
  }

  for (const name of remainder) {
    const data = await getNameData(env, name);
    if (data?.status !== STATUS.REGISTERED) {
      errors.push(
        `${name}: not registered (status: ${formatStatus(data?.status)})`,
      );
      continue;
    }
    if (data.resolver === zeroAddress) {
      errors.push(`${name}: no resolver set`);
    }
    // Check expiry is in the future
    if (data.expiry && data.expiry !== MAX_EXPIRY) {
      const currentTimestamp = await env.client
        .getBlock()
        .then((b) => b.timestamp);
      if (data.expiry <= currentTimestamp) {
        errors.push(
          `${name}: expired (expiry=${data.expiry}, now=${currentTimestamp})`,
        );
      }
    }
  }

  // Verify specific ownership expectations
  {
    const name = "newowner.eth";
    const data = await getNameData(env, name);
    if (data?.owner !== env.namedAccounts.user.address) {
      errors.push(
        `${name}: expected owner ${env.namedAccounts.user.address}, got ${data?.owner}`,
      );
    }
  }

  if (errors.length) {
    console.error("Verification FAILED:");
    for (const err of errors) {
      console.error(`  ✗ ${err}`);
    }
    throw new Error(`Name verification failed with ${errors.length} error(s)`);
  } else {
    console.log(`✓ All ${names.length} names verified successfully`);
  }
}
