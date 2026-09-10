import { describe, it } from "bun:test";
import {
  createRhinestoneAccount,
  type RhinestoneAccountConfig,
  type Session,
} from "@rhinestone/sdk";
import { getPermissionId } from "@rhinestone/sdk/smart-sessions";
import {
  type Account,
  type Address,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbiParameters,
  parseSignature,
  recoverMessageAddress,
  recoverTypedDataAddress,
  size,
  slice,
  toHex,
  type Hex,
  zeroAddress,
  zeroHash,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";

import artifacts from "../../script/artifacts.js";
import { ROLES, STATUS } from "../../script/deploy-constants.js";
import { expect, expectVar } from "../utils/expectVar.js";
import {
  COIN_TYPE_ETH,
  dnsEncodeName,
  getReverseName,
  idFromLabel,
  namehash,
} from "../utils/utils.js";
import { bundleCalls, makeResolutions } from "../utils/resolutions.js";

const REGISTRATION_DURATION = 28n * 86400n;
const BURNER_SESSION_SIGNER_KEY =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HCA_USER_SALT = 0n;
const ERC7579_ERC1271_MODE = `0x0201${"00".repeat(30)}` as Hex;
const MOCK_ORCHESTRATOR_URL = "https://hca-orchestrator.invalid";
const MOCK_BUNDLER_URL = "https://hca-bundler.invalid";
const SMART_SESSION_EMISSARY = "0xad568B3F825A8d5FFc06DD3253526B64D810Ae89";

type HCAExecution = {
  target: Address;
  value: bigint;
  callData: Hex;
};

type MockIntentInput = {
  account: {
    address: Address;
    accountType: string;
    setupOps: { to: Address; data: Hex }[];
  };
  destinationChainId: number;
  destinationExecutions: { to: Address; value: string; data: Hex }[];
  recipient?: {
    address: Address;
    accountType: string;
    setupOps: { to: Address; data: Hex }[];
  };
};

type MockRouteOptions = {
  arbiter: Address;
  fundingMethod: "NO_FUNDING" | "PERMIT2";
  settlementLayer: "INTENT_EXECUTOR" | "ACROSS";
  sourceToken?: Address;
  sourceAmount?: bigint;
  gasRefund?: {
    token: Address;
    exchangeRate: bigint;
    overhead: bigint;
  };
  nonce?: bigint;
  targetExecutionNonce?: bigint;
};

type JsonRpcRequest = {
  id: number | string;
  method: string;
  params?: unknown[];
};

function mockIntentRoute(
  input: MockIntentInput,
  {
    arbiter,
    fundingMethod,
    settlementLayer,
    sourceToken = zeroAddress,
    sourceAmount = 0n,
    gasRefund,
    nonce = 1n,
    targetExecutionNonce = 2n,
  }: MockRouteOptions,
) {
  const tokenId = BigInt(sourceToken).toString();
  const amount = sourceAmount.toString();
  const recipient = input.recipient ?? input.account;
  return {
    intentOp: {
      sponsor: zeroAddress,
      nonce: nonce.toString(),
      targetExecutionNonce: targetExecutionNonce.toString(),
      expires: (BigInt(Math.floor(Date.now() / 1000)) + 3600n).toString(),
      elements: [
        {
          arbiter,
          chainId: input.destinationChainId.toString(),
          idsAndAmounts: [[tokenId, amount]],
          spendTokens: [[tokenId, amount]],
          beforeFill: false,
          mandate: {
            recipient: recipient.address,
            tokenOut: [[tokenId, amount]],
            destinationChainId: input.destinationChainId.toString(),
            fillDeadline: (
              BigInt(Math.floor(Date.now() / 1000)) + 1800n
            ).toString(),
            destinationOps: {
              vt: ERC7579_ERC1271_MODE,
              ops: input.destinationExecutions,
            },
            preClaimOps: { vt: ERC7579_ERC1271_MODE, ops: [] },
            qualifier: {
              settlementContext: {
                settlementLayer,
                fundingMethod,
                using7579: true,
                ...(gasRefund && {
                  gasRefund: {
                    token: gasRefund.token,
                    exchangeRate: gasRefund.exchangeRate.toString(),
                    overhead: gasRefund.overhead.toString(),
                  },
                }),
              },
              encodedVal: zeroHash,
            },
            minGas: "0",
          },
        },
      ],
      serverSignature: "0x",
      signedMetadata: {
        fees: {},
        quotes: {},
        tokenPrices: {},
        opGasParams: { estimatedCalldataSize: 0 },
        gasPrices: {},
        account: { ...input.account, accountContext: {} },
        ...(input.recipient && {
          recipient: { ...input.recipient, accountContext: {} },
        }),
      },
    },
    intentCost: {},
  };
}

async function withMockedIntentRoute<T>(
  options: MockRouteOptions,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === `${MOCK_ORCHESTRATOR_URL}/intents/route`) {
      return Response.json(mockIntentRoute(body as MockIntentInput, options));
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("Standalone HCA", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;

  // The devnet deploy scripts deploy the local HCA stack and register its
  // implementation with the default reverse adapter.
  const stack = {
    factory: env.hca.StandaloneHCAFactory,
    executor: env.hca.MockRegistrationIntentExecutor,
    hcaImplementation: env.hca.StandaloneHCAImplementation,
    validator: env.hca.HCAOwnerAndSessionValidator,
  };

  setupEnv({ resetOnEach: true });

  async function standaloneConfig(
    owner: Account,
  ): Promise<RhinestoneAccountConfig> {
    return {
      account: {
        type: "hca",
        version: "ens-standalone-1.1.0",
        factory: stack.factory.address,
        implementation: stack.hcaImplementation.address,
        validator: stack.validator.address,
        verifiableFactory: env.v2.VerifiableFactory.address,
        proxyLogic: await env.v2.VerifiableFactory.read.proxyLogic(),
        userSalt: HCA_USER_SALT,
      },
      owners: {
        type: "ecdsa",
        accounts: [owner],
        module: stack.validator.address,
      },
      experimental_sessions: {
        enabled: true,
        module: stack.validator.address,
      },
    };
  }

  function sdkConfig() {
    return {
      auth: { mode: "apiKey" as const, apiKey: "test" },
      provider: {
        type: "custom" as const,
        urls: { [env.client.chain.id]: `http://${env.hostPort}` },
      },
    };
  }

  function computeOwnerBoundHcaSalt(
    owner: Address,
    implementation: Address,
    userSalt: bigint,
  ): bigint {
    return BigInt(
      keccak256(
        encodeAbiParameters(parseAbiParameters("uint256,address,address"), [
          userSalt,
          owner,
          implementation,
        ]),
      ),
    );
  }

  function computeHcaAddress(
    owner: Address,
    userSalt = HCA_USER_SALT,
  ): Address {
    const deploymentSalt = computeOwnerBoundHcaSalt(
      owner,
      stack.hcaImplementation.address,
      userSalt,
    );
    return env.computeVerifiableProxyAddress(
      stack.factory.address,
      deploymentSalt,
    );
  }

  async function operationData(
    executions: HCAExecution[],
    session = true,
  ): Promise<Hex> {
    return env.client.readContract({
      address: stack.executor.address,
      abi: stack.executor.abi,
      functionName: session ? "encodeSessionOperation" : "encodeOperation",
      args: [executions],
    }) as Promise<Hex>;
  }

  async function signRhinestoneMessage(
    signer: Account,
    digest: Hex,
  ): Promise<Hex> {
    if (!signer.signMessage) {
      throw new Error("HCA e2e signer must support message signing");
    }
    const signature = await signer.signMessage({ message: { raw: digest } });
    const v = Number.parseInt(signature.slice(-2), 16) + 4;
    return `${signature.slice(0, -2)}${v.toString(16).padStart(2, "0")}` as Hex;
  }

  async function buildSessionSignature({
    hca,
    nonce,
    authorization,
    sessionKey,
    executions,
  }: {
    hca: Address;
    nonce: bigint;
    authorization: { permissionId: Hex; proof: Hex };
    sessionKey: Account;
    executions: HCAExecution[];
  }): Promise<Hex> {
    const data = await operationData(executions);
    const digest = (await env.client.readContract({
      address: stack.executor.address,
      abi: stack.executor.abi,
      functionName: "singleChainDigest",
      args: [hca, nonce, executions],
    })) as Hex;
    return encodePacked(
      [
        "address",
        "bytes1",
        "bytes32",
        "bytes",
        "uint256",
        "address",
        "uint96",
        "uint96",
        "uint48",
        "bytes",
        "bytes",
      ],
      [
        zeroAddress,
        "0x05",
        authorization.permissionId,
        authorization.proof,
        nonce,
        zeroAddress,
        0n,
        0n,
        0,
        data,
        await signRhinestoneMessage(sessionKey, digest),
      ],
    );
  }

  async function createSessionAuthorization({
    hca,
    owner,
    sessionKey,
    validUntil,
    resolver,
    refundToken = env.erc20.MockUSDC.address,
    maxRefundExchangeRate = 1n,
    maxRefundGasOverhead = 0,
    maxRefundAmount = 1n,
  }: {
    hca: Address;
    owner: Account;
    sessionKey: Account;
    validUntil: number;
    resolver: Address;
    refundToken?: Address;
    maxRefundExchangeRate?: bigint;
    maxRefundGasOverhead?: number;
    maxRefundAmount?: bigint;
  }) {
    const code = await env.client.getCode({ address: hca });
    const sessionNonce =
      code && code !== "0x"
        ? (
            (await env.client.readContract({
              address: hca,
              abi: stack.hcaImplementation.abi,
              functionName: "ownerAndSessionNonce",
            })) as readonly [Address, bigint]
          )[1]
        : 0n;
    const salt = keccak256(
      encodeAbiParameters(
        [
          { type: "uint96" },
          { type: "uint48" },
          { type: "address" },
          { type: "address" },
          { type: "uint96" },
          { type: "uint48" },
          { type: "uint96" },
        ],
        [
          sessionNonce,
          validUntil,
          resolver,
          refundToken,
          maxRefundExchangeRate,
          maxRefundGasOverhead,
          maxRefundAmount,
        ],
      ),
    );
    const session: Session = {
      chain: env.client.chain,
      account: hca,
      salt,
      owners: { type: "ecdsa", accounts: [sessionKey] },
    };
    const account = await createRhinestoneAccount({
      ...sdkConfig(),
      ...(await standaloneConfig(owner)),
      ...(code && code !== "0x" && { initData: { address: hca } }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if ((body as JsonRpcRequest | undefined)?.method === "eth_call") {
        const request = body as JsonRpcRequest;
        const call = request.params?.[0] as { to?: Address } | undefined;
        if (call?.to?.toLowerCase() === SMART_SESSION_EMISSARY.toLowerCase()) {
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: zeroHash,
          });
        }
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;
    let details;
    try {
      details = await account.experimental_getSessionDetails([session]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const userSignature = await account.experimental_signEnableSession(details);
    if (
      size(userSignature) !== 85 ||
      slice(userSignature, 0, 20).toLowerCase() !== zeroAddress.toLowerCase()
    ) {
      throw new Error("unexpected HCA owner session authorization");
    }
    const parsed = parseSignature(slice(userSignature, 20));
    const ownerV = parsed.v ?? BigInt(27 + (parsed.yParity ?? 0));
    const packedSessions = details.hashesAndChainIds.map(
      ({ chainId, sessionDigest }) =>
        encodePacked(["uint64", "bytes32"], [BigInt(chainId), sessionDigest]),
    );
    const proof = concat([
      encodePacked(
        [
          "address",
          "uint48",
          "uint96",
          "address",
          "address",
          "uint96",
          "uint48",
          "uint96",
          "uint8",
          "uint8",
        ],
        [
          sessionKey.address,
          validUntil,
          sessionNonce,
          resolver,
          refundToken,
          maxRefundExchangeRate,
          maxRefundGasOverhead,
          maxRefundAmount,
          0,
          details.hashesAndChainIds.length,
        ],
      ),
      ...packedSessions,
      parsed.r,
      parsed.s,
      toHex(ownerV, { size: 1 }),
    ]);
    return {
      permissionId: getPermissionId(session),
      proof,
      session,
      enableData: {
        userSignature,
        hashesAndChainIds: details.hashesAndChainIds,
        sessionToEnableIndex: 0,
        hcaSessionNonce: sessionNonce,
        hcaSessionConfig: {
          sessionKey: sessionKey.address,
          validUntil,
          resolver,
          refundToken,
          maxRefundExchangeRate,
          maxRefundGasOverhead,
          maxRefundAmount,
        },
      },
    };
  }

  async function executeOwnerIntent({
    hca,
    owner,
    executions,
  }: {
    hca: Address;
    owner: Account;
    executions: HCAExecution[];
  }) {
    const data = await operationData(executions, false);
    const signature = encodePacked(
      ["address", "bytes"],
      [zeroAddress, await signRhinestoneMessage(owner, keccak256(data))],
    );
    await env.waitFor(
      stack.executor.write.execute([hca, executions, signature]),
    );
  }

  // Local E2E deploys separately. A sponsored production route can put deployment and
  // commitment in one intent fill.
  async function deployHCAAndCommit({
    label,
    owner,
    resolver,
    walletPaid = false,
  }: {
    label: string;
    owner: Account;
    resolver: Address;
    walletPaid?: boolean;
  }) {
    const hca = computeHcaAddress(owner.address);
    const commitment = await env.v2.ETHRegistrar.read.makeCommitment([
      label,
      owner.address,
      zeroHash,
      zeroAddress,
      resolver,
      REGISTRATION_DURATION,
      zeroHash,
    ]);

    const hcaCodeBefore = await env.client.getCode({ address: hca });
    const needsDeployment = !hcaCodeBefore || hcaCodeBefore === "0x";
    if (needsDeployment) {
      await env.waitFor(
        stack.factory.write.deploy(
          [owner.address, stack.hcaImplementation.address, HCA_USER_SALT],
          {
            account: walletPaid ? owner : env.namedAccounts.deployer,
          },
        ),
      );
    }

    if (walletPaid) {
      await executeHcaByOwner({
        hca,
        owner,
        executions: [
          {
            target: env.v2.ETHRegistrar.address,
            value: 0n,
            callData: encodeFunctionData({
              abi: env.v2.ETHRegistrar.abi,
              functionName: "commit",
              args: [commitment],
            }),
          },
        ],
      });
    } else {
      await env.waitFor(env.v2.ETHRegistrar.write.commit([commitment]));
    }

    const hcaCodeAfter = await env.client.getCode({ address: hca });
    expectVar({ hcaCodeAfter }).not.toBeUndefined();

    const hcaOwner = (await env.client.readContract({
      address: hca,
      abi: stack.hcaImplementation.abi,
      functionName: "owner",
      args: [],
    })) as Address;
    expectVar({ hcaOwner }).toEqualAddress(owner.address);

    const commitTime = await env.v2.ETHRegistrar.read.commitmentAt([
      commitment,
    ]);
    expectVar({ commitTime }).toBeGreaterThan(0n);

    return { hca, deployed: needsDeployment };
  }

  async function buildRegistrationExecutions({
    label,
    owner,
    hca,
    resolver,
    resolverSalt,
    price,
  }: {
    label: string;
    owner: Account;
    hca: Address;
    resolver: Address;
    resolverSalt: bigint;
    price: bigint;
  }): Promise<HCAExecution[]> {
    const name = `${label}.eth`;
    const executions: HCAExecution[] = [];

    const resolverCode = await env.client.getCode({ address: resolver });
    const deploysResolver = !resolverCode || resolverCode === "0x";
    if (deploysResolver) {
      const encodedName = dnsEncodeName(name);
      const resolverCalls = [
        encodeFunctionData({
          abi: artifacts.PermissionedResolver.abi,
          functionName: "setAddress",
          args: [encodedName, COIN_TYPE_ETH, owner.address],
        }),
        encodeFunctionData({
          abi: artifacts.PermissionedResolver.abi,
          functionName: "setText",
          args: [encodedName, "avatar", `https://euc.li/${name}`],
        }),
      ];
      executions.push({
        target: env.v2.VerifiableFactory.address,
        value: 0n,
        callData: encodeFunctionData({
          abi: artifacts.VerifiableFactory.abi,
          functionName: "deployProxy",
          args: [
            env.v2.PermissionedResolverImpl.address,
            resolverSalt,
            encodeFunctionData({
              abi: artifacts.PermissionedResolver.abi,
              functionName: "initialize",
              args: [
                [
                  { account: hca, roleBitmap: ROLES.ALL },
                  { account: owner.address, roleBitmap: ROLES.ALL },
                ],
                resolverCalls,
              ],
            }),
          ],
        }),
      });
    }

    executions.push(
      {
        target: env.erc20.MockUSDC.address,
        value: 0n,
        callData: encodeFunctionData({
          abi: env.erc20.MockUSDC.abi,
          functionName: "approve",
          args: [env.v2.ETHRegistrar.address, price],
        }),
      },
      {
        target: env.v2.ETHRegistrar.address,
        value: 0n,
        callData: encodeFunctionData({
          abi: env.v2.ETHRegistrar.abi,
          functionName: "register",
          args: [
            label,
            owner.address,
            zeroHash,
            zeroAddress,
            resolver,
            REGISTRATION_DURATION,
            env.erc20.MockUSDC.address,
            zeroHash,
          ],
        }),
      },
      ...(!deploysResolver
        ? [
            {
              target: resolver,
              value: 0n,
              callData: encodeFunctionData({
                abi: artifacts.PermissionedResolver.abi,
                functionName: "setAddress",
                args: [dnsEncodeName(name), COIN_TYPE_ETH, owner.address],
              }),
            },
            {
              target: resolver,
              value: 0n,
              callData: encodeFunctionData({
                abi: artifacts.PermissionedResolver.abi,
                functionName: "setText",
                args: [dnsEncodeName(name), "avatar", `https://euc.li/${name}`],
              }),
            },
          ]
        : []),
      {
        target: env.shared.DefaultReverseRegistrarAdapter.address,
        value: 0n,
        callData: encodeFunctionData({
          abi: env.shared.DefaultReverseRegistrarAdapter.abi,
          functionName: "setNameWithHCA",
          args: [owner.address, name],
        }),
      },
    );

    return executions;
  }

  async function prepareRegistration(
    label: string,
    owner: Account,
    { walletPaid = false }: { walletPaid?: boolean } = {},
  ) {
    const hca = computeHcaAddress(owner.address);
    const resolverSalt = env.computeOwnedResolverSalt(hca);
    const resolver = env.computeVerifiableProxyAddress(hca, resolverSalt);

    const [basePrice, premiumPrice] =
      await env.v2.ETHRegistrar.read.getRegisterPrice([
        label,
        REGISTRATION_DURATION,
        env.erc20.MockUSDC.address,
      ]);
    const price = basePrice + premiumPrice;

    await deployHCAAndCommit({ label, owner, resolver, walletPaid });
    await env.erc20.MockUSDC.write.mint([hca, price], {
      account: env.namedAccounts.deployer,
    });
    await env.sync({ warpSec: 61 });

    const executions = await buildRegistrationExecutions({
      label,
      owner,
      hca,
      resolver,
      resolverSalt,
      price,
    });

    return { executions, hca, price, resolver };
  }

  async function executeHcaIntent({
    hca,
    nonce,
    executions,
    signature,
  }: {
    hca: Address;
    nonce: bigint;
    executions: HCAExecution[];
    signature: Hex;
  }) {
    await env.waitFor(
      stack.executor.write.executeWithSession([
        hca,
        executions,
        nonce,
        signature,
      ]),
    );
  }

  async function executeHcaByOwner({
    hca,
    owner,
    executions,
  }: {
    hca: Address;
    owner: Account;
    executions: HCAExecution[];
  }) {
    await env.waitFor(
      env.client.writeContract({
        address: hca,
        abi: stack.hcaImplementation.abi,
        functionName: "executeByOwner",
        args: [executions],
        account: owner,
      }),
    );
  }

  async function expectRegistered({
    label,
    owner,
    hca,
    price,
    resolver,
  }: {
    label: string;
    owner: Account;
    hca: Address;
    price: bigint;
    resolver: Address;
  }) {
    const name = `${label}.eth`;

    const state = await env.v2.ETHRegistry.read.getState([idFromLabel(label)]);
    expectVar({ status: state.status }).toStrictEqual(STATUS.REGISTERED);
    expectVar({ latestOwner: state.latestOwner }).toEqualAddress(owner.address);

    const registryResolver = await env.v2.ETHRegistry.read.getResolver([label]);
    expectVar({ registryResolver }).toEqualAddress(resolver);

    const resolverImplementation =
      await env.v2.VerifiableFactory.read.verifyContract([resolver]);
    expectVar({ resolverImplementation }).toEqualAddress(
      env.v2.PermissionedResolverImpl.address,
    );

    const [rootRecordId, nameRecordId] = await Promise.all([
      env.client.readContract({
        address: resolver,
        abi: artifacts.PermissionedResolver.abi,
        functionName: "getRecordId",
        args: [zeroHash],
      }),
      env.client.readContract({
        address: resolver,
        abi: artifacts.PermissionedResolver.abi,
        functionName: "getRecordId",
        args: [namehash(name)],
      }),
    ]);
    expectVar({ rootRecordId }).toStrictEqual(0n);
    expectVar({ nameRecordId }).toBeGreaterThan(0n);

    const hcaBalance = await env.erc20.MockUSDC.read.balanceOf([hca]);
    expectVar({ hcaBalance }).toStrictEqual(0n);
    expectVar({ price }).toBeGreaterThan(0n);

    const bundle = bundleCalls(
      makeResolutions({
        name,
        addresses: [{ coinType: COIN_TYPE_ETH, value: owner.address }],
        texts: [{ key: "avatar", value: `https://euc.li/${name}` }],
      }),
    );
    const [result] = await env.v2.UniversalResolver.read.resolve([
      dnsEncodeName(name),
      bundle.call,
    ]);
    bundle.expect(result);

    const reverseResolver = await env.v1.ENSRegistry.read.resolver([
      namehash(getReverseName(owner.address)),
    ]);
    expectVar({ reverseResolver }).toEqualAddress(zeroAddress);

    const [primary] = await env.v2.UniversalResolver.read.reverse([
      owner.address,
      COIN_TYPE_ETH,
    ]);
    expectVar({ primary }).toStrictEqual(name);

    const defaultPrimary =
      await env.shared.DefaultReverseRegistrar.read.nameForAddr([
        owner.address,
      ]);
    expectVar({ defaultPrimary }).toStrictEqual(name);

    const ownerIsResolverAdmin = await env.client.readContract({
      address: resolver,
      abi: artifacts.PermissionedResolver.abi,
      functionName: "hasRootRoles",
      args: [ROLES.ALL, owner.address],
    });
    expectVar({ ownerIsResolverAdmin }).toStrictEqual(true);
  }

  it("deploys an owner-bound HCA once and reuses it", async () => {
    const owner = env.namedAccounts.user;
    const label = "hcastandalone";
    const hca = computeHcaAddress(owner.address);
    const resolverSalt = env.computeOwnedResolverSalt(hca);
    const resolver = env.computeVerifiableProxyAddress(hca, resolverSalt);

    const first = await deployHCAAndCommit({ label, owner, resolver });
    const second = await deployHCAAndCommit({
      label: "hcastandalonesecond",
      owner,
      resolver,
    });

    expectVar({ firstDeployed: first.deployed }).toStrictEqual(true);
    expectVar({ secondHca: second.hca }).toEqualAddress(first.hca);
    expectVar({ secondDeployed: second.deployed }).toStrictEqual(false);

    const implementation = await env.v2.VerifiableFactory.read.verifyContract([
      hca,
    ]);
    expectVar({ implementation }).toEqualAddress(
      stack.hcaImplementation.address,
    );
  });

  it("matches the standalone HCA adapter to the deployed account", async () => {
    const owner = env.namedAccounts.user;
    const configuredAdapter =
      await stack.validator.read.DEFAULT_REVERSE_REGISTRAR_HCA_ADAPTER();
    const config = await standaloneConfig(owner);
    const account = await createRhinestoneAccount({
      ...sdkConfig(),
      ...config,
    });
    const hca = computeHcaAddress(owner.address);

    expectVar({ configuredAdapter }).toEqualAddress(
      env.shared.DefaultReverseRegistrarAdapter.address,
    );
    expectVar({ sdkAddress: account.getAddress() }).toEqualAddress(hca);
    expectVar({ initData: account.getInitData() }).toStrictEqual({
      factory: stack.factory.address,
      factoryData: encodeFunctionData({
        abi: stack.factory.abi,
        functionName: "deploy",
        args: [owner.address, stack.hcaImplementation.address, HCA_USER_SALT],
      }),
    });

    await env.waitFor(
      stack.factory.write.deploy([
        owner.address,
        stack.hcaImplementation.address,
        HCA_USER_SALT,
      ]),
    );
    const signature = await account.signTypedData(
      {
        domain: {
          name: "SDK parity",
          version: "1",
          chainId: env.client.chain.id,
          verifyingContract: hca,
        },
        types: { Message: [{ name: "value", type: "bytes32" }] },
        primaryType: "Message",
        message: { value: zeroHash },
      },
      env.client.chain,
      undefined,
    );
    const defaultValidatorPrefix = signature.slice(0, 42) as Address;
    expectVar({ defaultValidatorPrefix }).toEqualAddress(zeroAddress);
    expectVar({ signatureSize: size(signature) }).toStrictEqual(85);

    const existing = await createRhinestoneAccount({
      ...sdkConfig(),
      ...config,
      initData: { address: hca },
    });
    expectVar({ existingAddress: existing.getAddress() }).toEqualAddress(hca);
    expect(() => existing.getInitData()).toThrow();
  });

  it("packs refund-aware fixed sessions through the Rhinestone SDK", async () => {
    const owner = env.namedAccounts.user;
    const config = await standaloneConfig(owner);
    const account = await createRhinestoneAccount({
      ...sdkConfig(),
      ...config,
      endpointUrl: MOCK_ORCHESTRATOR_URL,
    });
    const sessionKey = privateKeyToAccount(BURNER_SESSION_SIGNER_KEY);
    const refundToken = env.erc20.MockUSDC.address;
    const refundPaymaster = await stack.validator.read.GAS_REFUND_PAYMASTER();
    const maxExchangeRate = 10_000_000_000n;
    const maxGasOverhead = 100_000;
    const maxRefundAmount = 25_000_000n;
    const packedOverhead = (maxRefundAmount << 128n) | BigInt(maxGasOverhead);
    const currentBlock = await env.client.getBlock();
    const authorization = await createSessionAuthorization({
      hca: account.getAddress(),
      owner,
      sessionKey,
      validUntil: Number(currentBlock.timestamp + 3600n),
      resolver: zeroAddress,
      refundToken,
      maxRefundExchangeRate: maxExchangeRate,
      maxRefundGasOverhead: maxGasOverhead,
      maxRefundAmount,
    });
    const calls: HCAExecution[] = [
      {
        target: refundToken,
        value: 0n,
        callData: encodeFunctionData({
          abi: env.erc20.MockUSDC.abi,
          functionName: "approve",
          args: [refundPaymaster, maxRefundAmount],
        }),
      },
      {
        target: env.v2.ETHRegistrar.address,
        value: 0n,
        callData: encodeFunctionData({
          abi: env.v2.ETHRegistrar.abi,
          functionName: "commit",
          args: [keccak256("0x1234")],
        }),
      },
    ];
    const targetExecutionNonce = 91n;
    const signed = await withMockedIntentRoute(
      {
        arbiter: stack.executor.address,
        fundingMethod: "NO_FUNDING",
        settlementLayer: "INTENT_EXECUTOR",
        gasRefund: {
          token: refundToken,
          exchangeRate: maxExchangeRate,
          overhead: packedOverhead,
        },
        targetExecutionNonce,
      },
      async () => {
        const prepared = await account.prepareTransaction({
          chain: env.client.chain,
          calls: calls.map(({ target: to, value, callData: data }) => ({
            to,
            value,
            data,
          })),
          feeAsset: refundToken,
          sponsored: false,
          signers: {
            type: "experimental_session",
            session: authorization.session,
            enableData: authorization.enableData,
            verifyExecutions: true,
          },
        });
        return account.signTransaction(prepared);
      },
    );

    const signature = signed.targetExecutionSignature;
    expectVar({ signature }).not.toBeUndefined();
    const operation = await operationData(calls);
    const expectedPrefix = encodePacked(
      [
        "address",
        "bytes1",
        "bytes32",
        "bytes",
        "uint256",
        "address",
        "uint96",
        "uint96",
        "uint48",
        "bytes",
      ],
      [
        zeroAddress,
        "0x05",
        authorization.permissionId,
        authorization.proof,
        targetExecutionNonce,
        refundToken,
        maxExchangeRate,
        maxRefundAmount,
        maxGasOverhead,
        operation,
      ],
    );
    expectVar({ signature }).toSatisfy((value: Hex) =>
      value.toLowerCase().startsWith(expectedPrefix.toLowerCase()),
    );
    expectVar({ signatureSize: size(signature!) }).toStrictEqual(
      size(expectedPrefix) + 65,
    );

    const rawSignature = slice(signature!, size(signature!) - 65);
    const v = Number.parseInt(rawSignature.slice(-2), 16);
    expectVar({ v }).toSatisfy((value: number) => value === 31 || value === 32);
  });

  it("reuses one Nexus Permit2 signature for the destination HCA", async () => {
    const owner = env.namedAccounts.user;
    let signatureCount = 0;
    const trackedOwner = {
      ...owner,
      signTypedData: (async (parameters: unknown) => {
        signatureCount += 1;
        return owner.signTypedData(parameters as never);
      }) as typeof owner.signTypedData,
    };
    const recipient = await standaloneConfig(owner);
    const source = await createRhinestoneAccount({
      ...sdkConfig(),
      account: { type: "nexus" },
      owners: { type: "ecdsa", accounts: [trackedOwner] },
      endpointUrl: MOCK_ORCHESTRATOR_URL,
    });
    const sourceAmount = 10_000_000n;
    const paymentToken = env.erc20.MockUSDC.address;
    const signed = await withMockedIntentRoute(
      {
        arbiter: stack.executor.address,
        fundingMethod: "PERMIT2",
        settlementLayer: "ACROSS",
        sourceToken: paymentToken,
        sourceAmount,
      },
      async () => {
        const prepared = await source.prepareTransaction({
          sourceChains: [env.client.chain],
          targetChain: env.client.chain,
          recipient,
          calls: [
            {
              to: env.v2.ETHRegistrar.address,
              value: 0n,
              data: encodeFunctionData({
                abi: env.v2.ETHRegistrar.abi,
                functionName: "commit",
                args: [keccak256("0x5678")],
              }),
            },
          ],
          tokenRequests: [{ address: paymentToken, amount: sourceAmount }],
          sourceAssets: [
            {
              chain: env.client.chain,
              address: paymentToken,
              amount: sourceAmount,
            },
          ],
          settlementLayers: ["ACROSS"],
          sponsored: false,
        });
        return source.signTransaction(prepared);
      },
    );

    expectVar({ signatureCount }).toStrictEqual(1);
    expectVar({
      originSignatureCount: signed.originSignatures.length,
    }).toStrictEqual(1);
    const originSignature = signed.originSignatures[0];
    expectVar({ originSignature }).toSatisfy(
      (value: unknown) => typeof value === "string",
    );
    expectVar({
      destinationSignature: signed.destinationSignature,
    }).toStrictEqual(originSignature);
    expectVar({
      destinationSignatureSize: size(signed.destinationSignature),
    }).toStrictEqual(85);
    expectVar({ destinationSignature: signed.destinationSignature }).toSatisfy(
      (value: Hex) => value.toLowerCase().startsWith(zeroAddress),
    );
    expectVar({
      targetExecutionSignature: signed.targetExecutionSignature,
    }).toBeUndefined();
    const recipientSetup =
      signed.intentRoute.intentOp.signedMetadata.recipient?.setupOps;
    expectVar({ recipientSetupCount: recipientSetup?.length }).toStrictEqual(1);
    expectVar({ recipientFactory: recipientSetup?.[0]?.to }).toEqualAddress(
      stack.factory.address,
    );

    const message = source.getTransactionMessages(signed).origin[0]!;
    const recovered = await recoverTypedDataAddress({
      ...message,
      signature: slice(originSignature as Hex, 20),
    });
    expectVar({ recovered }).toEqualAddress(owner.address);
  });

  it("rejects standalone HCA cross-chain session sources", async () => {
    const owner = env.namedAccounts.user;
    const account = await createRhinestoneAccount({
      ...sdkConfig(),
      ...(await standaloneConfig(owner)),
      endpointUrl: MOCK_ORCHESTRATOR_URL,
    });
    const sessionKey = privateKeyToAccount(BURNER_SESSION_SIGNER_KEY);
    const session: Session = {
      chain: env.client.chain,
      account: account.getAddress(),
      owners: { type: "ecdsa", accounts: [sessionKey] },
    };
    const targetChain = {
      ...env.client.chain,
      id: env.client.chain.id + 1,
    };

    await expect(
      account.prepareTransaction({
        sourceChains: [env.client.chain],
        targetChain,
        calls: [],
        signers: {
          type: "experimental_session",
          session,
          verifyExecutions: true,
        },
      }),
    ).rejects.toThrow("Standalone HCA cross-chain sessions are not supported");
  });

  it("prepares and signs a fresh standalone HCA UserOperation", async () => {
    const owner = env.namedAccounts.user;
    const config = await standaloneConfig(owner);
    const expectedFactoryData = encodeFunctionData({
      abi: stack.factory.abi,
      functionName: "deploy",
      args: [owner.address, stack.hcaImplementation.address, HCA_USER_SALT],
    });
    const localRpcUrl = `http://${env.hostPort}`;
    const captured: { estimatedUserOperation?: Record<string, unknown> } = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const request = init?.body
        ? (JSON.parse(String(init.body)) as JsonRpcRequest)
        : undefined;
      if (
        new URL(url).origin === new URL(MOCK_BUNDLER_URL).origin &&
        request?.method === "eth_estimateUserOperationGas"
      ) {
        captured.estimatedUserOperation = request.params?.[0] as Record<
          string,
          unknown
        >;
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            callGasLimit: "0x186a0",
            preVerificationGas: "0xc350",
            verificationGasLimit: "0x7a120",
          },
        });
      }
      if (
        new URL(url).origin === new URL(localRpcUrl).origin &&
        request?.method === "eth_call"
      ) {
        const call = request.params?.[0] as { to?: Address } | undefined;
        if (call?.to?.toLowerCase() === entryPoint07Address.toLowerCase()) {
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: `0x${"00".repeat(32)}`,
          });
        }
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    try {
      const account = await createRhinestoneAccount({
        ...sdkConfig(),
        ...config,
        bundler: { type: "custom", url: MOCK_BUNDLER_URL },
      });
      const prepared = await account.prepareUserOperation({
        chain: env.client.chain,
        calls: [
          {
            to: env.erc20.MockUSDC.address,
            value: 0n,
            data: "0x",
          },
        ],
      });

      expectVar({ sender: prepared.userOperation.sender }).toEqualAddress(
        account.getAddress(),
      );
      expectVar({ factory: prepared.userOperation.factory }).toEqualAddress(
        stack.factory.address,
      );
      expectVar({
        factoryData: prepared.userOperation.factoryData,
      }).toStrictEqual(expectedFactoryData);
      expectVar({
        estimatedFactory: captured.estimatedUserOperation?.factory,
      }).toStrictEqual(stack.factory.address);
      expectVar({
        estimatedFactoryData: captured.estimatedUserOperation?.factoryData,
      }).toStrictEqual(expectedFactoryData);

      const signed = await account.signUserOperation(prepared);
      expectVar({ signatureSize: size(signed.signature) }).toStrictEqual(65);
      const recovered = await recoverMessageAddress({
        message: { raw: prepared.hash },
        signature: signed.signature,
      });
      expectVar({ recovered }).toEqualAddress(owner.address);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("registers two names through wallet-paid HCA batches without intent signatures", async () => {
    const owner = env.namedAccounts.user;
    const label = "hcadirectowner";
    const { executions, hca, price, resolver } = await prepareRegistration(
      label,
      owner,
      { walletPaid: true },
    );

    await expect(
      executeHcaByOwner({
        hca,
        owner: env.namedAccounts.user2,
        executions,
      }),
    ).rejects.toThrow();
    await executeHcaByOwner({ hca, owner, executions });

    await expectRegistered({ label, owner, hca, price, resolver });

    // The in-batch role grant makes the EOA co-admin: a direct owner record write must
    // succeed without any HCA involvement.
    const name = `${label}.eth`;
    const [res] = makeResolutions({
      name,
      texts: [{ key: "com.example", value: "owner-direct" }],
    });
    await env.waitFor(
      env.client.sendTransaction({
        account: owner,
        to: resolver,
        data: res.writeV2,
      }),
    );
    res.expect(
      await env.v2.UniversalResolver.read
        .resolve([dnsEncodeName(name), res.call])
        .then(([result]) => result),
    );

    const secondLabel = "hcadirectownertwo";
    const second = await prepareRegistration(secondLabel, owner, {
      walletPaid: true,
    });
    expectVar({ secondHca: second.hca }).toEqualAddress(hca);
    expectVar({ secondResolver: second.resolver }).toEqualAddress(resolver);
    expectVar({
      redeploysResolver: second.executions.some(
        ({ target }) =>
          target.toLowerCase() ===
          env.v2.VerifiableFactory.address.toLowerCase(),
      ),
    }).toStrictEqual(false);

    await executeHcaByOwner({
      hca: second.hca,
      owner,
      executions: second.executions,
    });
    await expectRegistered({
      label: secondLabel,
      owner,
      hca: second.hca,
      price: second.price,
      resolver: second.resolver,
    });
  });

  it("reuses one owner-authorized session for registration and a later primary change", async () => {
    const owner = env.namedAccounts.user;
    const sessionKey = privateKeyToAccount(BURNER_SESSION_SIGNER_KEY);
    const label = "hcasessionkey";
    const { executions, hca, price, resolver } = await prepareRegistration(
      label,
      owner,
    );
    const currentBlock = await env.client.getBlock();
    const authorization = await createSessionAuthorization({
      hca,
      owner,
      sessionKey,
      validUntil: Number(currentBlock.timestamp + 3600n),
      resolver,
    });

    const blockedExecutions: HCAExecution[] = [
      {
        target: env.namedAccounts.user2.resolver.address,
        value: 0n,
        callData: encodeFunctionData({
          abi: artifacts.PermissionedResolver.abi,
          functionName: "setText",
          args: [
            dnsEncodeName(`${label}.eth`),
            "url",
            "https://example.com/nope",
          ],
        }),
      },
    ];
    const blockedSignature = await buildSessionSignature({
      hca,
      nonce: 1n,
      authorization,
      sessionKey,
      executions: blockedExecutions,
    });
    await expect(
      executeHcaIntent({
        hca,
        nonce: 1n,
        executions: blockedExecutions,
        signature: blockedSignature,
      }),
    ).rejects.toThrow();

    const signature = await buildSessionSignature({
      hca,
      nonce: 2n,
      authorization,
      sessionKey,
      executions,
    });
    await executeHcaIntent({ hca, nonce: 2n, executions, signature });
    await expectRegistered({ label, owner, hca, price, resolver });

    const laterName = `later-${label}.eth`;
    const laterExecutions: HCAExecution[] = [
      {
        target: env.shared.DefaultReverseRegistrarAdapter.address,
        value: 0n,
        callData: encodeFunctionData({
          abi: env.shared.DefaultReverseRegistrarAdapter.abi,
          functionName: "setNameWithHCA",
          args: [owner.address, laterName],
        }),
      },
    ];
    const laterSignature = await buildSessionSignature({
      hca,
      nonce: 3n,
      authorization,
      sessionKey,
      executions: laterExecutions,
    });
    await executeHcaIntent({
      hca,
      nonce: 3n,
      executions: laterExecutions,
      signature: laterSignature,
    });

    const laterPrimary =
      await env.shared.DefaultReverseRegistrar.read.nameForAddr([
        owner.address,
      ]);
    expectVar({ laterPrimary }).toStrictEqual(laterName);
  });

  it("invalidates a fixed session with the HCA session nonce", async () => {
    const owner = env.namedAccounts.user;
    const sessionKey = privateKeyToAccount(BURNER_SESSION_SIGNER_KEY);
    const label = "hcarevokedsession";
    const { executions, hca, resolver } = await prepareRegistration(
      label,
      owner,
    );
    const currentBlock = await env.client.getBlock();
    const authorization = await createSessionAuthorization({
      hca,
      owner,
      sessionKey,
      validUntil: Number(currentBlock.timestamp + 3600n),
      resolver,
    });

    await env.waitFor(
      env.client.writeContract({
        address: hca,
        abi: stack.hcaImplementation.abi,
        functionName: "revokeSessions",
        account: owner,
      }),
    );

    const signature = await buildSessionSignature({
      hca,
      nonce: 1n,
      authorization,
      sessionKey,
      executions,
    });
    await expect(
      executeHcaIntent({ hca, nonce: 1n, executions, signature }),
    ).rejects.toThrow();
  });
});
