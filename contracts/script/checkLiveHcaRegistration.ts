import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { generatePrivateKey } from "viem/accounts";

import { SEPOLIA_USDC } from "./deploy-constants.ts";

const FLOWS = [
  "same-chain",
  "same-chain-usdc",
  "same-session",
  "cross-chain",
  "cross-chain-upfront-permit",
  "cross-chain-wallet-funded",
] as const;
type Flow = (typeof FLOWS)[number];
type StringEnv = Record<string, string | undefined>;

const FLOW_HELP: Record<Flow, string> = {
  "same-chain": "sponsored same-chain registration",
  "same-chain-usdc": "same-chain registration paid from wallet USDC",
  "same-session":
    "one session authorization used for same-chain and cross-chain registration",
  "cross-chain": "deferred cross-chain registration with two wallet signatures",
  "cross-chain-upfront-permit":
    "cross-chain registration that pulls its source budget at commit",
  "cross-chain-wallet-funded":
    "cross-chain registration after a wallet funding transaction",
};

const contractsRoot = fileURLToPath(new URL("..", import.meta.url));
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

type Refund = { token: string; exchangeRate: string; overhead: string };
type FeePayment = {
  token: string;
  balanceBefore: string;
  fundedBeforeExecution?: string;
  balanceAfter: string;
  totalCharge: string;
  protocolSpend: string;
  executionFee: string;
};
type SessionRoute = {
  transactionHash: string;
  setupOps: number;
  mode: string;
  gasUsed: string;
  gasRefunds: Refund[];
  feePayment?: FeePayment;
};
type CrossChainRoute = {
  claimTransactionHash: string;
  fillTransactionHash: string;
  sourceSetupOps: number;
  recipientSetupOps: number;
  sourceWalletSignatures: number;
  destinationReusesPermit2Signature: boolean;
  sourcePullViaNexus?: boolean;
  sourcePermitViaEip2612?: boolean;
  sourcePullAmount?: string;
  sourcePermit2Amount?: string;
  using7579: boolean;
  mode: string;
  settlementLayer: string;
  fundingMethod: string;
  sponsored?: boolean;
  feeAsset?: string;
  claimGasUsed: string;
  fillGasUsed: string;
  gasUsed: string;
};
type CrossChainPreparation = {
  deploymentTransactionHash: string;
  commitTransactionHash: string;
  deploymentGasUsed: string;
  commitGasUsed: string;
  gasUsed: string;
};
type VerifiedRegistration = {
  name: string;
  ownerHasResolverRoles: boolean;
  hcaHasResolverRoles: boolean;
  defaultPrimary: string;
  universalAddress: string;
};
type RegistrationSummary = {
  initialState: "new" | "existing";
  names: [string, string];
  owner: string;
  hca: string;
  resolver: string;
  permissionId: string;
  ownerKeySource: string;
  wallet?: {
    address: string;
    nativeBalanceBefore: string;
    nativeBalanceAfter: string;
    transactionCountBefore: number;
    transactionCountAfter: number;
  };
  sameChainFunding: {
    source: "wallet EIP-2612 permit";
    amountPulled: string;
    walletBalanceBeforePull: string;
    walletBalanceAfter: string;
    hcaBalanceBefore: string;
    hcaBalanceAfter: string;
    executionCharge: string;
    allowanceAfter: string;
  };
  walletInteractions:
    | {
        paymentPermitSignatures: number;
        ownerIntentSignatures: number;
        postCommitWalletInteractions: number;
        total: number;
      }
    | {
        paymentPermitSignatures: number;
        multiChainSessionSignatures: number;
        postCommitWalletInteractions: number;
        total: number;
      }
    | {
        sourceFundingTransactions: number;
        permit2Signatures: number;
        additionalHcaOwnerSignatures: number;
        total: number;
      };
  crossChain?: {
    sourceChain: number;
    targetChain: number;
    sourceToken: string;
    targetToken: string;
    source: {
      wallet: string;
      sourceAccount: string;
      circleFaucetRequested: boolean;
      provisioningSource: "existing" | "circle" | "operator";
      provisioningTransactionHashes: string[];
      provisioningGasUsed: string;
      walletNativeBalance: string;
      walletBalanceBefore: string;
      walletBalanceAfter: string;
      sourceAccountBalanceBefore: string;
      sourceAccountBalanceAfter: string;
      permit2AllowanceBefore: string;
      fundingTransactionHash: string;
      fundingGasUsed: string;
      walletTransactions: number;
    };
  };
  funding?: {
    source: "Base Sepolia Permit2 + Across";
    amount: string;
    crossChainBalance: string;
    testProvisionedAmount: string;
    provisioningTransactionHash?: string;
    gasUsed: string;
  };
  flows: {
    newUser:
      | [SessionRoute, SessionRoute]
      | [CrossChainPreparation, CrossChainRoute];
    existingUser: [SessionRoute, SessionRoute];
  };
  verified: VerifiedRegistration;
};

type UpfrontPermitSummary = {
  initialState: "new" | "existing";
  names: [string, string];
  owner: string;
  hca: string;
  walletInteractions: {
    sourceFundingTransactions: number;
    sourcePermitSignatures: number;
    permit2Signatures: number;
    additionalHcaOwnerSignatures: number;
    total: number;
  };
  crossChain: {
    targetAmount: string;
    targetToken: string;
    source: {
      sourceType: "nexus";
      nexusFundingMode: "permit-pull";
      wallet: string;
      sourceAccount: string;
      walletNativeBalance: string;
      walletNativeBalanceAfterClaim: string;
      walletBalanceBefore: string;
      walletBalanceAfter: string;
      walletBalanceAfterClaim: string;
      sourceAccountBalanceBefore: string;
      sourceAccountBalanceAfter: string;
      sourceAccountBalanceAfterClaim: string;
      routeSourceAmount: string;
      walletToSourceAllowanceBefore: string;
      walletToSourceAllowanceAfterClaim: string;
      permitNonceBefore: string;
      permitNonceAfterClaim: string;
      permitSignatureCount: number;
      fundingAction: "EIP-2612 permit";
      walletTransactions: number;
    };
  };
  flows: {
    newUser: [CrossChainRoute, SessionRoute];
    existingUser: [SessionRoute, SessionRoute];
  };
  funding: {
    source: "cross-chain USDC";
    hcaBalanceAfterCrossChain: string;
    operatorTopUp: string;
  };
  verified: VerifiedRegistration;
};

type DeferredRoute = {
  resumed?: boolean;
  claimTransactionHash: string;
  fillTransactionHash: string;
  sourceWalletSignatures?: number;
  destinationReusesPermit2Signature?: boolean;
  sourceSignedBySession?: boolean;
  destinationSignedBySession?: boolean;
  walletSignatures?: number;
};
type DeferredSummary = {
  flow: string;
  owner: string;
  sourceNexus: string;
  hca: string;
  walletInteractions: {
    eip2612PermitSignatures: number;
    multiChainSessionSignatures: number;
    permit2OwnerSignatures: number;
    walletTransactions: number;
    postCommitWalletInteractions: number;
    total: number;
  };
  funds: {
    totalPermit: string;
    pulledAtCommit: string;
    leftInWalletAfterCommit: string;
    permitAllowanceAfterCommit: string;
    pulledAtReveal: string;
    leftInWalletAfterReveal: string;
    permitAllowanceAfterReveal: string;
    deliveredAtCommit: string;
    deliveredAtReveal: string;
  };
  sessions: {
    sourcePermissionId: string;
    destinationPermissionId: string;
    ownerAuthorizationReused?: boolean;
    sourcePolicyInstalledAtCommit: boolean;
    destinationAuthorizationStateless: boolean;
  };
  routes: { commit: DeferredRoute; reveal: DeferredRoute };
};

type LiveState = {
  labels: string[];
  secrets: string[];
  sessionKey?: string;
  validUntil?: number;
};

function usage(): string {
  return [
    "Usage: bun run check:hca-live -- <flow>",
    "",
    "Flows:",
    ...FLOWS.map((flow) => `  ${flow.padEnd(29)} ${FLOW_HELP[flow]}`),
  ].join("\n");
}

function selectedFlow(): Flow {
  const [arg, ...rest] = process.argv.slice(2);
  if (arg === "--help" || arg === "-h") {
    console.log(usage());
    process.exit(0);
  }
  if (rest.length > 0 || !FLOWS.includes(arg as Flow)) {
    throw new Error(usage());
  }
  return arg as Flow;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string) {
  if (!env[name]) throw new Error(`${name} is required for the live HCA check`);
}

function sourceChainEnv(env: NodeJS.ProcessEnv) {
  const sourceChain = env.HCA_SOURCE_CHAIN ?? "base-sepolia";
  if (!new Set(["base-sepolia", "arbitrum-sepolia"]).has(sourceChain)) {
    throw new Error(
      "HCA_SOURCE_CHAIN must be base-sepolia or arbitrum-sepolia",
    );
  }
  env.HCA_SOURCE_CHAIN = sourceChain;
  env.HCA_SOURCE_RPC_URL ??=
    sourceChain === "base-sepolia"
      ? (env.BASE_SEPOLIA_RPC_URL ??
        env.SEPOLIA_RPC_URL?.replace("eth-sepolia", "base-sepolia"))
      : env.ARBITRUM_SEPOLIA_RPC_URL;
  requireEnv(env, "HCA_SOURCE_RPC_URL");
  return sourceChain;
}

function ordinaryOwner(
  flow: Flow,
  source: StringEnv = process.env as unknown as StringEnv,
) {
  const supplied = source.HCA_OWNER_KEY?.trim();
  if ((flow === "same-chain" || flow === "same-chain-usdc") && !supplied) {
    throw new Error(
      "HCA_OWNER_KEY must be a fresh Sepolia wallet funded with USDC for same-chain proofs",
    );
  }
  return {
    key: supplied ?? generatePrivateKey(),
    source: supplied ? "supplied" : "generated",
    generated: !supplied,
  } as const;
}

function deferredOwner(
  source: StringEnv = process.env as unknown as StringEnv,
) {
  const ownerKeyFile = source.HCA_OWNER_KEY_FILE?.trim();
  let key = source.HCA_OWNER_KEY?.trim();
  if (!key && ownerKeyFile && existsSync(ownerKeyFile)) {
    key = readFileSync(ownerKeyFile, "utf8").trim();
  }
  if (!key) {
    key = generatePrivateKey();
    if (ownerKeyFile) {
      writeFileSync(ownerKeyFile, `${key}\n`, { mode: 0o600 });
    }
  }

  const stateFile =
    source.HCA_LIVE_STATE_FILE?.trim() ||
    (ownerKeyFile ? `${ownerKeyFile}.state.json` : undefined);
  let state: LiveState | undefined;
  if (stateFile && existsSync(stateFile)) {
    state = JSON.parse(readFileSync(stateFile, "utf8")) as LiveState;
  }
  if (!state) {
    const run = BigInt(generatePrivateKey())
      .toString(36)
      .padStart(8, "0")
      .slice(-8);
    state = {
      labels: [`hca${run}a`, `hca${run}b`],
      secrets: [generatePrivateKey(), generatePrivateKey()],
      sessionKey: generatePrivateKey(),
      validUntil: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    };
    if (stateFile) {
      writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    }
  }
  if (!state.sessionKey) {
    state.sessionKey = generatePrivateKey();
    if (stateFile) {
      writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    }
  }
  return { key, state, stateFile };
}

function sameSessionOwner() {
  if (!process.env.HCA_OWNER_KEY_FILE?.trim()) {
    throw new Error(
      "HCA_OWNER_KEY_FILE is required for the same-session live proof",
    );
  }
  const result = deferredOwner();
  if (
    !result.stateFile ||
    !result.state.sessionKey ||
    !result.state.validUntil
  ) {
    throw new Error("the same-session live state is incomplete");
  }

  const prefix = result.state.labels[0]?.slice(0, -1);
  if (!prefix) throw new Error("the same-session live state has no label");
  const suffixes = ["a", "b", "c", "d"];
  for (let index = result.state.labels.length; index < 4; index += 1) {
    result.state.labels.push(`${prefix}${suffixes[index]}`);
    result.state.secrets.push(generatePrivateKey());
  }
  if (
    result.state.labels.length < 4 ||
    result.state.secrets.length < 4 ||
    new Set(result.state.labels.slice(0, 4)).size !== 4
  ) {
    throw new Error("the same-session live state needs four unique labels");
  }
  writeFileSync(result.stateFile, `${JSON.stringify(result.state)}\n`, {
    mode: 0o600,
  });
  return {
    ...result,
    signatureFile:
      process.env.HCA_MULTI_CHAIN_SESSION_SIGNATURE_FILE?.trim() ||
      `${result.stateFile}.session-signature`,
  };
}

function liveEnv(
  flow: Flow,
  source: StringEnv = process.env as unknown as StringEnv,
) {
  const env = { ...source };
  env.DEPLOYMENT_NETWORK ??= "sepolia";
  env.HCA_DEPLOYMENT_NETWORK ??= env.DEPLOYMENT_NETWORK;
  env.V1_DEPLOYMENT_NETWORK ??= "sepolia";
  env.HCA_EXPECT_DEFAULT_REVERSE_FALLBACK = "1";
  env.HCA_TEST_PAYMENT_TOKEN ??= SEPOLIA_USDC;
  env.RHINESTONE_API_KEY ??=
    env.RHINESTONE_SDK_API_KEY ?? env.VITE_RHINESTONE_API_KEY;

  for (const name of [
    "HCA_CROSS_CHAIN",
    "HCA_CROSS_CHAIN_SOURCE",
    "HCA_CROSS_CHAIN_NEXUS_FUNDING",
    "HCA_DEFER_CROSS_CHAIN_FUNDING",
    "HCA_SAME_CHAIN_USER_PAID_USDC",
    "HCA_USER_PAID_USDC",
  ]) {
    delete env[name];
  }
  delete env.HCA_GENERATE_OWNER;
  delete env.HCA_DRY_RUN_ONLY;

  if (flow === "cross-chain") {
    const { key, state } = deferredOwner(source);
    sourceChainEnv(env);
    env.HCA_OWNER_KEY = key;
    env.HCA_LABELS = state.labels.join(",");
    env.HCA_SECRETS = state.secrets.join(",");
    env.HCA_SESSION_KEY = state.sessionKey;
    if (state.validUntil) {
      env.HCA_SESSION_VALID_UNTIL ??= String(state.validUntil);
    }
    env.HCA_OWNER_KEY_SOURCE = "fresh live-test wallet";
    env.HCA_EXPECT_INITIAL_STATE ??=
      env.HCA_RESUME_DEFERRED === "1" ? "existing" : "new";
    env.HCA_SPONSORED = "0";
    env.HCA_FEE_ASSET = "USDC";
    env.HCA_USER_PAID_USDC = "1";
    env.HCA_CROSS_CHAIN = "1";
    env.HCA_CROSS_CHAIN_SOURCE = "nexus";
    env.HCA_CROSS_CHAIN_NEXUS_FUNDING = "permit-pull";
    env.HCA_DEFER_CROSS_CHAIN_FUNDING = "1";
    env.HCA_WAIT_FOR_SOURCE_USDC ??= "1";
    env.HCA_CROSS_CHAIN_SOURCE_AMOUNT ??= "40000000";
    env.HCA_CROSS_CHAIN_COMMIT_SOURCE_AMOUNT ??= "20000000";
    env.HCA_CROSS_CHAIN_COMMIT_TARGET_AMOUNT ??= "1";
    env.HCA_CROSS_CHAIN_TARGET_AMOUNT ??= "900000";
    env.HCA_MAX_REFUND_AMOUNT ??= "50000000";
  } else {
    delete env.HCA_RESUME_DEFERRED;
    const owner = ordinaryOwner(flow, source);
    env.HCA_OWNER_KEY = owner.key;
    env.HCA_OWNER_KEY_SOURCE = owner.source;
    env.HCA_EXPECT_INITIAL_STATE ??=
      owner.generated ||
      flow === "same-chain-usdc" ||
      flow === "cross-chain-upfront-permit"
        ? "new"
        : "either";

    if (flow === "same-chain") {
      env.HCA_SPONSORED = "1";
    } else if (flow === "same-chain-usdc") {
      sourceChainEnv(env);
      env.HCA_SPONSORED = "0";
      env.HCA_FEE_ASSET = "USDC";
      env.HCA_SAME_CHAIN_USER_PAID_USDC = "1";
      env.HCA_SAME_CHAIN_USDC_BUDGET ??= "20000000";
      env.HCA_MAX_REFUND_AMOUNT ??= "50000000";
      env.HCA_SESSION_GAS_LIMIT ??= "1200000";
      env.HCA_CROSS_CHAIN_SOURCE_AMOUNT ??= "40000000";
      env.HCA_CROSS_CHAIN_COMMIT_SOURCE_AMOUNT ??= "20000000";
      env.HCA_CROSS_CHAIN_COMMIT_TARGET_AMOUNT ??= "1";
      env.HCA_CROSS_CHAIN_TARGET_AMOUNT ??= "900000";
    } else {
      const sourceChain = sourceChainEnv(env);
      env.HCA_CROSS_CHAIN = "1";
      env.HCA_CROSS_CHAIN_SOURCE = "nexus";
      env.HCA_CROSS_CHAIN_NEXUS_FUNDING =
        flow === "cross-chain-upfront-permit" ? "permit-pull" : "prefund";

      if (flow === "cross-chain-upfront-permit") {
        env.HCA_SPONSORED = "0";
        env.HCA_FEE_ASSET = "USDC";
        env.HCA_USER_PAID_USDC = "1";
        env.HCA_CROSS_CHAIN_SOURCE_AMOUNT ??=
          sourceChain === "base-sepolia" ? "20000000" : "28000000";
        env.HCA_CROSS_CHAIN_TARGET_AMOUNT ??= "14000000";
      } else {
        env.HCA_SPONSORED = "1";
        requireEnv(env, "CIRCLE_API_KEY");
      }
    }
  }

  requireEnv(env, "SEPOLIA_RPC_URL");
  requireEnv(env, "DEPLOYER_KEY");
  requireEnv(env, "RHINESTONE_API_KEY");
  return env;
}

function timeoutFor(flow: Flow) {
  if (flow === "cross-chain") return 1_800_000;
  if (flow === "cross-chain-upfront-permit") return 1_200_000;
  if (flow === "cross-chain-wallet-funded") return 900_000;
  return 420_000;
}

async function copyOutput(
  stream: ReadableStream<Uint8Array>,
  destination: Bun.BunFile,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    output += text;
    await destination.write(text);
  }
  output += decoder.decode();
  return output;
}

async function compile() {
  const proc = Bun.spawn(["bun", "run", "compile", "--quiet"], {
    cwd: contractsRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`contract compilation failed with exit code ${exitCode}`);
  }
}

async function runLive(flow: Flow, env = liveEnv(flow)) {
  const proc = Bun.spawn(["bun", "script/liveHcaRhinestoneRegistration.ts"], {
    cwd: contractsRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), timeoutFor(flow));
  const [stdout, stderr, exitCode] = await Promise.all([
    copyOutput(proc.stdout, Bun.stdout),
    copyOutput(proc.stderr, Bun.stderr),
    proc.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) {
    throw new Error(
      `${flow} live proof failed with exit code ${exitCode}\n${stderr}`,
    );
  }
  return stdout;
}

function parseSummary<T>(stdout: string): T {
  const trimmed = stdout.trim();
  const start = trimmed.lastIndexOf("\n{");
  return JSON.parse(start === -1 ? trimmed : trimmed.slice(start + 1)) as T;
}

function assertVerified(summary: {
  owner: string;
  names: [string, string];
  verified: VerifiedRegistration;
}) {
  assert.equal(summary.verified.name, summary.names[1]);
  assert.equal(summary.verified.defaultPrimary, summary.names[1]);
  assert.equal(summary.verified.ownerHasResolverRoles, true);
  assert.equal(summary.verified.hcaHasResolverRoles, true);
  assert.equal(
    summary.verified.universalAddress.toLowerCase(),
    summary.owner.toLowerCase(),
  );
}

function assertSameChain(
  flow: Flow,
  summary: RegistrationSummary,
  printResult = true,
) {
  assert.deepEqual(
    summary.walletInteractions,
    flow === "same-chain-usdc"
      ? {
          paymentPermitSignatures: 1,
          multiChainSessionSignatures: 1,
          postCommitWalletInteractions: 0,
          total: 2,
        }
      : {
          paymentPermitSignatures: 1,
          ownerIntentSignatures: 1,
          postCommitWalletInteractions: 0,
          total: 2,
        },
  );
  const funding = summary.sameChainFunding;
  const amountPulled = BigInt(funding.amountPulled);
  assert(amountPulled > 0n);
  assert.equal(
    BigInt(funding.walletBalanceBeforePull) -
      BigInt(funding.walletBalanceAfter),
    amountPulled,
  );
  assert.equal(
    BigInt(funding.hcaBalanceAfter) -
      BigInt(funding.hcaBalanceBefore) +
      BigInt(funding.executionCharge),
    amountPulled,
  );
  assert.equal(BigInt(funding.allowanceAfter), 0n);

  const routes = [
    ...summary.flows.newUser,
    ...summary.flows.existingUser,
  ] as SessionRoute[];
  assert.deepEqual(
    routes.map(({ setupOps }) => setupOps),
    [1, 0, 0, 0],
  );
  for (const route of routes)
    assert.match(route.transactionHash, TRANSACTION_HASH);

  if (flow === "same-chain-usdc") {
    assert(summary.wallet);
    assert.equal(
      summary.wallet.address.toLowerCase(),
      summary.owner.toLowerCase(),
    );
    assert.equal(BigInt(summary.wallet.nativeBalanceBefore), 0n);
    assert.equal(BigInt(summary.wallet.nativeBalanceAfter), 0n);
    assert.equal(summary.wallet.transactionCountBefore, 0);
    assert.equal(summary.wallet.transactionCountAfter, 0);
    assert.equal(
      BigInt(routes[0]!.feePayment!.totalCharge),
      BigInt(funding.executionCharge),
    );
    for (const route of routes) {
      assert(route.gasRefunds.length > 0);
      assert(BigInt(route.feePayment!.executionFee) > 0n);
      assert.equal(
        BigInt(route.feePayment!.balanceBefore) +
          BigInt(route.feePayment!.fundedBeforeExecution!) -
          BigInt(route.feePayment!.balanceAfter),
        BigInt(route.feePayment!.totalCharge),
      );
    }
  }
  assertVerified(summary);

  const [firstCommit, firstReveal] = summary.flows.newUser as SessionRoute[];
  const [secondCommit, secondReveal] = summary.flows.existingUser;
  if (printResult) {
    console.log(
      JSON.stringify(
        {
          liveProof: "passed",
          flow,
          owner: summary.owner,
          hca: summary.hca,
          resolver: summary.resolver,
          names: summary.names,
          walletInteractions: summary.walletInteractions,
          transactions: {
            firstCommit: firstCommit!.transactionHash,
            firstReveal: firstReveal!.transactionHash,
            secondCommit: secondCommit.transactionHash,
            secondReveal: secondReveal.transactionHash,
          },
          verified: summary.verified,
        },
        null,
        2,
      ),
    );
  }
}

function assertWalletFundedCrossChain(summary: RegistrationSummary) {
  assert.deepEqual(summary.walletInteractions, {
    sourceFundingTransactions: 1,
    permit2Signatures: 1,
    additionalHcaOwnerSignatures: 0,
    total: 2,
  });
  assert(summary.crossChain);
  const source = summary.crossChain.source;
  assert.equal(BigInt(source.walletBalanceAfter), 0n);
  assert.equal(BigInt(source.sourceAccountBalanceBefore), 0n);
  assert.equal(BigInt(source.permit2AllowanceBefore), 0n);
  assert.equal(source.walletTransactions, 1);
  assert.equal(
    BigInt(source.sourceAccountBalanceAfter),
    BigInt(source.walletBalanceBefore),
  );
  assert.equal(source.wallet.toLowerCase(), summary.owner.toLowerCase());
  assert.match(source.fundingTransactionHash, TRANSACTION_HASH);
  assert(BigInt(source.fundingGasUsed) > 0n);

  const preparation = summary.flows.newUser[0] as CrossChainPreparation;
  assert.match(preparation.deploymentTransactionHash, TRANSACTION_HASH);
  assert.match(preparation.commitTransactionHash, TRANSACTION_HASH);
  assert(BigInt(preparation.deploymentGasUsed) > 0n);
  assert(BigInt(preparation.commitGasUsed) > 0n);

  const registration = summary.flows.newUser[1] as CrossChainRoute;
  assert.equal(registration.sourceSetupOps, 1);
  assert.equal(registration.recipientSetupOps, 0);
  assert.equal(registration.sourceWalletSignatures, 1);
  assert.equal(registration.destinationReusesPermit2Signature, true);
  assert.equal(registration.using7579, true);
  assert.equal(registration.settlementLayer, "ACROSS");
  assert.equal(registration.fundingMethod, "PERMIT2");
  assert.equal(registration.mode.slice(4, 6), "01");
  assert.match(registration.claimTransactionHash, TRANSACTION_HASH);
  assert.match(registration.fillTransactionHash, TRANSACTION_HASH);

  assert(summary.funding);
  assert.equal(
    BigInt(summary.funding.crossChainBalance) +
      BigInt(summary.funding.testProvisionedAmount),
    BigInt(summary.funding.amount),
  );
  if (BigInt(summary.funding.testProvisionedAmount) > 0n) {
    assert.match(
      summary.funding.provisioningTransactionHash!,
      TRANSACTION_HASH,
    );
    assert(BigInt(summary.funding.gasUsed) > 0n);
  }
  for (const route of summary.flows.existingUser) {
    assert.equal(route.setupOps, 0);
    assert.match(route.transactionHash, TRANSACTION_HASH);
  }
  assertVerified(summary);

  console.log(
    JSON.stringify(
      {
        liveProof: "passed",
        flow: "cross-chain-wallet-funded",
        owner: summary.owner,
        hca: summary.hca,
        names: summary.names,
        walletInteractions: summary.walletInteractions,
        sourceFundingTransactionHash: source.fundingTransactionHash,
        permissionlessPreparation: {
          deploymentTransactionHash: preparation.deploymentTransactionHash,
          commitTransactionHash: preparation.commitTransactionHash,
        },
        crossChainRegistration: {
          claimTransactionHash: registration.claimTransactionHash,
          fillTransactionHash: registration.fillTransactionHash,
          claimGasUsed: registration.claimGasUsed,
          fillGasUsed: registration.fillGasUsed,
        },
        sessionTransactions: summary.flows.existingUser.map(
          ({ transactionHash }) => transactionHash,
        ),
        verified: summary.verified,
      },
      null,
      2,
    ),
  );
}

function assertUpfrontPermit(summary: UpfrontPermitSummary) {
  assert.equal(summary.initialState, "new");
  assert.deepEqual(summary.walletInteractions, {
    sourceFundingTransactions: 0,
    sourcePermitSignatures: 1,
    permit2Signatures: 1,
    additionalHcaOwnerSignatures: 0,
    total: 2,
  });

  const source = summary.crossChain.source;
  const [crossChainCommit, firstReveal] = summary.flows.newUser;
  assert.equal(source.sourceType, "nexus");
  assert.equal(source.nexusFundingMode, "permit-pull");
  assert.equal(source.wallet.toLowerCase(), summary.owner.toLowerCase());
  assert.equal(BigInt(source.walletNativeBalance), 0n);
  assert.equal(BigInt(source.walletNativeBalanceAfterClaim), 0n);
  assert.equal(source.walletBalanceBefore, source.walletBalanceAfter);
  assert.equal(
    BigInt(source.walletBalanceAfterClaim),
    BigInt(source.walletBalanceBefore) - BigInt(source.routeSourceAmount),
  );
  assert.equal(BigInt(source.sourceAccountBalanceBefore), 0n);
  assert.equal(BigInt(source.sourceAccountBalanceAfter), 0n);
  assert.equal(
    BigInt(source.sourceAccountBalanceAfterClaim),
    BigInt(source.routeSourceAmount) -
      BigInt(crossChainCommit.sourcePermit2Amount!),
  );
  assert.equal(BigInt(source.walletToSourceAllowanceBefore), 0n);
  assert.equal(BigInt(source.walletToSourceAllowanceAfterClaim), 0n);
  assert.equal(
    BigInt(source.permitNonceAfterClaim),
    BigInt(source.permitNonceBefore) + 1n,
  );
  assert.equal(source.permitSignatureCount, 1);
  assert.equal(source.fundingAction, "EIP-2612 permit");
  assert.equal(source.walletTransactions, 0);

  assert.equal(crossChainCommit.sourceSetupOps, 1);
  assert.equal(crossChainCommit.recipientSetupOps, 1);
  assert.equal(crossChainCommit.sourceWalletSignatures, 1);
  assert.equal(crossChainCommit.destinationReusesPermit2Signature, true);
  assert.equal(crossChainCommit.sourcePullViaNexus, true);
  assert.equal(crossChainCommit.sourcePermitViaEip2612, true);
  assert.equal(crossChainCommit.sourcePullAmount, source.routeSourceAmount);
  assert(BigInt(crossChainCommit.sourcePermit2Amount!) > 0n);
  assert(
    BigInt(crossChainCommit.sourcePermit2Amount!) <=
      BigInt(crossChainCommit.sourcePullAmount!),
  );
  assert.equal(crossChainCommit.using7579, true);
  assert.equal(crossChainCommit.settlementLayer, "ACROSS");
  assert.equal(crossChainCommit.fundingMethod, "PERMIT2");
  assert.equal(crossChainCommit.sponsored, false);
  assert.equal(crossChainCommit.feeAsset, "USDC");
  assert.match(crossChainCommit.claimTransactionHash, TRANSACTION_HASH);
  assert.match(crossChainCommit.fillTransactionHash, TRANSACTION_HASH);

  const targetToken = summary.crossChain.targetToken.toLowerCase();
  for (const route of [firstReveal, ...summary.flows.existingUser]) {
    assert.match(route.transactionHash, TRANSACTION_HASH);
    assert.equal(route.setupOps, 0);
    assert(route.gasRefunds.length > 0);
    for (const refund of route.gasRefunds) {
      assert.equal(refund.token.toLowerCase(), targetToken);
      assert(BigInt(refund.exchangeRate) > 0n);
      assert(BigInt(refund.overhead) > 0n);
    }
    assert.equal(route.feePayment!.token.toLowerCase(), targetToken);
    assert(BigInt(route.feePayment!.executionFee) > 0n);
    assert.equal(
      BigInt(route.feePayment!.balanceBefore) -
        BigInt(route.feePayment!.balanceAfter),
      BigInt(route.feePayment!.totalCharge),
    );
  }
  assert.equal(summary.funding.source, "cross-chain USDC");
  assert.equal(
    summary.funding.hcaBalanceAfterCrossChain,
    summary.crossChain.targetAmount,
  );
  assert.equal(BigInt(summary.funding.operatorTopUp), 0n);
  assertVerified(summary);

  console.log(
    JSON.stringify(
      {
        liveProof: "passed",
        flow: "cross-chain-upfront-permit",
        owner: summary.owner,
        hca: summary.hca,
        names: summary.names,
        walletInteractions: summary.walletInteractions,
        sourceUsdcBudget: source.routeSourceAmount,
        sourceUsdcSpent: crossChainCommit.sourcePermit2Amount,
        sourceUsdcResidual: source.sourceAccountBalanceAfterClaim,
        targetUsdcDelivered: summary.crossChain.targetAmount,
        claimTransactionHash: crossChainCommit.claimTransactionHash,
        fillTransactionHash: crossChainCommit.fillTransactionHash,
        sessionTransactions: [
          firstReveal.transactionHash,
          ...summary.flows.existingUser.map(
            ({ transactionHash }) => transactionHash,
          ),
        ],
        verified: summary.verified,
      },
      null,
      2,
    ),
  );
}

function assertDeferred(summary: DeferredSummary, printResult = true) {
  assert.equal(summary.flow, "cross-chain deferred registration funding");
  assert.deepEqual(summary.walletInteractions, {
    eip2612PermitSignatures: 1,
    multiChainSessionSignatures: 1,
    permit2OwnerSignatures: 0,
    walletTransactions: 0,
    postCommitWalletInteractions: 0,
    total: 2,
  });
  assert.equal(
    BigInt(summary.funds.permitAllowanceAfterCommit),
    BigInt(summary.funds.totalPermit) - BigInt(summary.funds.pulledAtCommit),
  );
  assert(
    BigInt(summary.funds.leftInWalletAfterCommit) >=
      BigInt(summary.funds.permitAllowanceAfterCommit),
  );
  assert.equal(
    BigInt(summary.funds.permitAllowanceAfterReveal),
    BigInt(summary.funds.totalPermit) -
      BigInt(summary.funds.pulledAtCommit) -
      BigInt(summary.funds.pulledAtReveal),
  );
  assert.equal(
    BigInt(summary.funds.leftInWalletAfterReveal),
    BigInt(summary.funds.leftInWalletAfterCommit) -
      BigInt(summary.funds.pulledAtReveal),
  );
  assert.equal(summary.funds.deliveredAtCommit, "1");
  assert(BigInt(summary.funds.deliveredAtReveal) > 1n);
  assert.equal(summary.sessions.sourcePolicyInstalledAtCommit, true);
  assert.equal(summary.sessions.destinationAuthorizationStateless, true);
  assert.equal(summary.routes.commit.sourceSignedBySession, true);
  assert.equal(summary.routes.commit.destinationSignedBySession, true);
  assert.equal(summary.routes.commit.walletSignatures, 0);
  assert.equal(summary.routes.reveal.sourceSignedBySession, true);
  assert.equal(summary.routes.reveal.destinationSignedBySession, true);
  assert.equal(summary.routes.reveal.walletSignatures, 0);
  for (const route of [summary.routes.commit, summary.routes.reveal].filter(
    (candidate) => !candidate.resumed,
  )) {
    assert.match(route.claimTransactionHash, TRANSACTION_HASH);
    assert.match(route.fillTransactionHash, TRANSACTION_HASH);
  }

  if (printResult) {
    console.log(
      JSON.stringify(
        {
          liveProof: "passed",
          flow: "cross-chain",
          owner: summary.owner,
          sourceNexus: summary.sourceNexus,
          hca: summary.hca,
          walletInteractions: summary.walletInteractions,
          funds: summary.funds,
          routes: summary.routes,
        },
        null,
        2,
      ),
    );
  }
}

async function runSameSessionProof() {
  const { key, state, signatureFile } = sameSessionOwner();
  const common = {
    ...process.env,
    HCA_OWNER_KEY: key,
    HCA_SESSION_KEY: state.sessionKey!,
    HCA_SESSION_VALID_UNTIL: String(state.validUntil),
    HCA_MAX_REFUND_AMOUNT: "50000000",
    HCA_CROSS_CHAIN_SOURCE_AMOUNT: "40000000",
    HCA_CROSS_CHAIN_COMMIT_SOURCE_AMOUNT: "20000000",
    HCA_CROSS_CHAIN_COMMIT_TARGET_AMOUNT: "1",
    HCA_CROSS_CHAIN_TARGET_AMOUNT: "900000",
  } as unknown as StringEnv;

  const sameChainEnv = liveEnv("same-chain-usdc", common);
  sameChainEnv.HCA_LABELS = state.labels.slice(0, 2).join(",");
  sameChainEnv.HCA_SECRETS = state.secrets.slice(0, 2).join(",");
  sameChainEnv.HCA_EXPECT_INITIAL_STATE = "new";
  sameChainEnv.HCA_MULTI_CHAIN_SESSION_SIGNATURE_FILE = signatureFile;
  delete sameChainEnv.HCA_MULTI_CHAIN_SESSION_SIGNATURE;

  const sameChain = parseSummary<RegistrationSummary>(
    await runLive("same-chain-usdc", sameChainEnv),
  );
  assertSameChain("same-chain-usdc", sameChain, false);

  const sessionSignature = readFileSync(signatureFile, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{170}$/.test(sessionSignature)) {
    throw new Error(
      "the same-chain route did not save its session authorization",
    );
  }

  const crossChainEnv = liveEnv("cross-chain", {
    ...common,
    HCA_EXPECT_INITIAL_STATE: "existing",
    HCA_MULTI_CHAIN_SESSION_SIGNATURE: sessionSignature,
  });
  crossChainEnv.HCA_LABELS = state.labels.slice(2, 4).join(",");
  crossChainEnv.HCA_SECRETS = state.secrets.slice(2, 4).join(",");
  crossChainEnv.HCA_EXPECT_INITIAL_STATE = "existing";
  crossChainEnv.HCA_MULTI_CHAIN_SESSION_SIGNATURE = sessionSignature;

  const crossChain = parseSummary<DeferredSummary>(
    await runLive("cross-chain", crossChainEnv),
  );
  assertDeferred(crossChain, false);

  assert.equal(crossChain.owner.toLowerCase(), sameChain.owner.toLowerCase());
  assert.equal(crossChain.hca.toLowerCase(), sameChain.hca.toLowerCase());
  assert.equal(
    crossChain.sessions.destinationPermissionId.toLowerCase(),
    sameChain.permissionId.toLowerCase(),
  );
  assert.equal(crossChain.sessions.ownerAuthorizationReused, true);
  assert.equal(readFileSync(signatureFile, "utf8").trim(), sessionSignature);

  const [firstCommit, firstReveal] = sameChain.flows.newUser as SessionRoute[];
  console.log(
    JSON.stringify(
      {
        liveProof: "passed",
        flow: "same session authorization, either registration route",
        owner: sameChain.owner,
        hca: sameChain.hca,
        permissionId: sameChain.permissionId,
        sessionSignedBeforeRouteChoice: true,
        sessionAuthorizationReused: true,
        sameChain: {
          walletInteractions: sameChain.walletInteractions,
          commitTransactionHash: firstCommit!.transactionHash,
          revealTransactionHash: firstReveal!.transactionHash,
        },
        crossChain: {
          walletInteractions: crossChain.walletInteractions,
          walletSignaturesDuringThisRun: 1,
          commitClaimTransactionHash:
            crossChain.routes.commit.claimTransactionHash,
          commitFillTransactionHash:
            crossChain.routes.commit.fillTransactionHash,
          revealClaimTransactionHash:
            crossChain.routes.reveal.claimTransactionHash,
          revealFillTransactionHash:
            crossChain.routes.reveal.fillTransactionHash,
        },
      },
      null,
      2,
    ),
  );
}

const flow = selectedFlow();
await compile();
if (flow === "same-session") {
  await runSameSessionProof();
} else if (flow === "cross-chain") {
  const stdout = await runLive(flow);
  assertDeferred(parseSummary<DeferredSummary>(stdout));
} else if (flow === "cross-chain-upfront-permit") {
  const stdout = await runLive(flow);
  assertUpfrontPermit(parseSummary<UpfrontPermitSummary>(stdout));
} else {
  const stdout = await runLive(flow);
  const summary = parseSummary<RegistrationSummary>(stdout);
  const expectedOwnerSource = process.env.HCA_OWNER_KEY
    ? "supplied"
    : "generated";
  if (expectedOwnerSource === "generated")
    assert.equal(summary.initialState, "new");
  assert.equal(summary.ownerKeySource, expectedOwnerSource);
  if (flow === "cross-chain-wallet-funded") {
    assertWalletFundedCrossChain(summary);
  } else {
    assertSameChain(flow, summary);
  }
}
