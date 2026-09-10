import { type Hex, zeroAddress } from "viem";
import type { DevnetAccount, DevnetEnvironment } from "../setup.js";
import {
  COIN_TYPE_ETH,
  dnsEncodeName,
  idFromLabel,
  namehash,
} from "../../test/utils/utils.js";
import { formatExpiry } from "./display.js";
import { trackGas } from "./gas.js";
import { MAX_EXPIRY } from "../deploy-constants.js";

const ONE_DAY_SECONDS = 86400;

function secret(i: number): Hex {
  return `0x${(i + 1).toString(16).padStart(64, "0")}`;
}

/**
 * Register names via the ETHRegistrar commit-reveal flow with batched commits.
 * Commits all names, does one time warp, then registers all.
 */
export async function registerTestNames(
  env: DevnetEnvironment,
  labels: string[],
  options: {
    account?: DevnetAccount;
    durationInDays?: number;
    trackGas?: boolean;
  } = {},
) {
  const account = options.account ?? env.namedAccounts.owner;
  const shouldTrackGas = options.trackGas ?? false;
  const durationInDays = options.durationInDays ?? 28;
  const duration = BigInt(durationInDays * ONE_DAY_SECONDS);
  const paymentToken = env.erc20.MockUSDC.address;
  const referrer =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  // use account's resolver (already deployed by devnet)
  const { resolver } = account;
  if (shouldTrackGas)
    trackGas("deployPermissionedResolver", resolver.deploymentReceipt);

  // Step 1: Commit all names
  for (let i = 0; i < labels.length; i++) {
    const commitment = await env.v2.ETHRegistrar.read.makeCommitment([
      labels[i],
      account.address,
      secret(i),
      zeroAddress,
      resolver.address,
      duration,
      referrer,
    ]);
    const receipt = await env.waitFor(
      env.v2.ETHRegistrar.write.commit([commitment], {
        account,
      }),
    );
    if (shouldTrackGas) {
      trackGas(`commit(${labels[i]})`, receipt);
    }
  }

  // Step 2: Single time warp past minCommitmentAge
  const minAge = await env.v2.ETHRegistrar.read.MIN_COMMITMENT_AGE();
  await env.sync({ warpSec: Number(minAge) + 1 });

  // Step 3: Approve total payment
  let totalPrice = 0n;
  for (const label of labels) {
    const [base, premium] =
      await env.v2.StandardRentPriceOracle.read.getRegisterPrice([
        label,
        MAX_EXPIRY,
        duration,
        paymentToken,
      ]);
    totalPrice += base + premium;
  }

  const balance = await env.erc20.MockUSDC.read.balanceOf([account.address]);
  if (balance < totalPrice) {
    await env.erc20.MockUSDC.write.mint(
      [account.address, totalPrice - balance + 1000000n],
      { account },
    );
  }
  await env.erc20.MockUSDC.write.approve(
    [env.v2.ETHRegistrar.address, totalPrice],
    { account },
  );

  // Step 4: Register all names
  for (let i = 0; i < labels.length; i++) {
    const receipt = await env.waitFor(
      env.v2.ETHRegistrar.write.register(
        [
          labels[i],
          account.address,
          secret(i),
          zeroAddress,
          resolver.address,
          duration,
          paymentToken,
          referrer,
        ],
        { account },
      ),
    );
    if (shouldTrackGas) trackGas(`register(${labels[i]})`, receipt);

    // Set resolver records
    const name = dnsEncodeName(`${labels[i]}.eth`);
    const setAddrReceipt = await env.waitFor(
      resolver.write.setAddress([name, COIN_TYPE_ETH, account.address]),
    );
    if (shouldTrackGas) trackGas(`setAddr(${labels[i]})`, setAddrReceipt);

    const setTextReceipt = await env.waitFor(
      resolver.write.setText([name, "description", `${labels[i]}.eth`]),
    );
    if (shouldTrackGas) trackGas(`setText(${labels[i]})`, setTextReceipt);
  }
}

/**
 * Re-register a name after it has expired (includes time warp)
 */
export async function reregisterName(
  env: DevnetEnvironment,
  label: string,
  account = env.namedAccounts.owner,
) {
  console.log(
    `\n=== Testing Re-registration of Expired Name: ${label}.eth ===`,
  );

  const initialExpiry = await env.v2.ETHRegistry.read.findExpiry([label]);
  console.log(
    `Initial expiry: ${new Date(Number(initialExpiry) * 1000).toISOString()}`,
  );

  const [minRegDur, gracePeriod, premiumPeriod] = await Promise.all([
    env.v2.ETHRegistrar.read.MIN_REGISTER_DURATION(),
    env.v2.ETHRegistrar.read.GRACE_PERIOD(),
    env.v2.StandardRentPriceOracle.read.PREMIUM_PERIOD(),
  ]);
  const warpSeconds = minRegDur + gracePeriod + premiumPeriod;

  console.log(`\nTime warping ${warpSeconds} seconds...`);
  await env.sync({ warpSec: Number(warpSeconds) });

  console.log(
    `\nCurrent onchain timestamp: ${await env.client.getBlock().then((b) => formatExpiry(b.timestamp))}`,
  );
  console.log(`\nCurrent onchain expiry: ${formatExpiry(initialExpiry)}`);

  // Verify name is available for re-registration
  const isAvailable = await env.v2.ETHRegistrar.read.isAvailable([label]);
  console.log(`Name available for re-registration: ${isAvailable}`);

  if (!isAvailable) {
    throw new Error(`${label}.eth should be available after expiry`);
  }

  // Re-register via commit-reveal
  console.log(`\nRe-registering ${label}.eth...`);

  await registerTestNames(env, [label], {
    account,
    durationInDays: 28,
  });

  // Verify re-registration succeeded
  const reregisteredExpiry = await env.v2.ETHRegistry.read.getExpiry([
    idFromLabel(label),
  ]);
  console.log(`New expiry: ${formatExpiry(reregisteredExpiry)}`);

  if (reregisteredExpiry <= initialExpiry) {
    throw new Error(
      `Re-registration failed: new expiry (${reregisteredExpiry}) should be greater than initial expiry (${initialExpiry})`,
    );
  }

  console.log(
    `✓ Re-registration successful! Expiry extended from ${initialExpiry} to ${reregisteredExpiry}`,
  );
}

/**
 * Renew a name via the ETHRegistrar
 */
export async function renewName(
  env: DevnetEnvironment,
  name: string,
  durationInDays: number,
  account = env.namedAccounts.owner,
) {
  const label = name.split(".")[0];

  const expiry = await env.v2.ETHRegistry.read.getExpiry([idFromLabel(label)]);

  console.log(`\nRenewing ${name}...`);
  console.log(`Current expiry: ${formatExpiry(expiry)}`);
  console.log(`Extending by: ${durationInDays} days`);

  const duration = BigInt(durationInDays * ONE_DAY_SECONDS);
  const paymentToken = env.erc20.MockUSDC.address;

  const price = await env.v2.ETHRegistrar.read.getRenewPrice([
    label,
    duration,
    paymentToken,
  ]);

  console.log(`Renewal price: ${price}`);

  const balance = await env.erc20.MockUSDC.read.balanceOf([account.address]);
  console.log(`Current balance: ${balance}`);

  if (balance < price) {
    const amountToMint = price - balance + 1000000n;
    console.log(`Minting ${amountToMint} tokens...`);
    await env.erc20.MockUSDC.write.mint([account.address, amountToMint], {
      account,
    });
  }

  await env.erc20.MockUSDC.write.approve([env.v2.ETHRegistrar.address, price], {
    account,
  });

  const receipt = await env.waitFor(
    env.v2.ETHRegistrar.write.renew(
      [{ label, duration, referrer: namehash("referrer") }, paymentToken],
      { account },
    ),
  );

  const newExpiry = await env.v2.ETHRegistry.read.getExpiry([
    idFromLabel(label),
  ]);
  console.log(`New expiry: ${formatExpiry(newExpiry)}`);
  console.log(`✓ Renewal completed`);

  return receipt;
}
