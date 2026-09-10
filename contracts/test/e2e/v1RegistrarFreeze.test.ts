import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserConfig } from "rocketh/types";
import { getAddress, type Address } from "viem";
import { loadAndExecuteDeploymentsFromFilesWithConfig } from "../../rocketh/environment.js";
import artifacts from "../../script/artifacts.js";
import {
  disableV1Registrars,
  verifyV1RegistrarsDisabled,
} from "../../script/migration.js";
import { deployArtifact } from "../integration/fixtures/deployArtifact.js";

// Each revoke waits a full receipt poll, so the freeze needs more than the default
// per-test budget.
const TEST_TIMEOUT_MS = 120_000;

// The devnet runs on chain id 1, so the freeze's mainnet config applies and the
// locally deployed RegistrarSecurityController is discovered the same way the
// bundled mainnet artifact is.
const NETWORK = "mainnet";
const ACTIVE_NAMESPACE = "mainnet";
const ARCHIVED_NAMESPACE = "mainnet-archived-20260101";

// A `--deployment-network` that shares no prefix with the network it targets, whose
// archives are therefore named after the namespace rather than the network.
const CUSTOM_NAMESPACE = "staging";
const CUSTOM_ARCHIVED_NAMESPACE = "staging-20260101-r1";
const HCA_RESUME_NAMESPACE = "mainnet-hca-resume";

// Height past which a whole-chain log request is wider than the smallest span the
// scan will narrow to, so a capped provider forces it to split the range.
const MIN_SCAN_NARROWING_BLOCK = 1_100n;

// Stand-ins for a superseded deployment's handoff contracts: the freeze only reads
// their controller flags, so any address that is not an active deployment's works.
const ARCHIVED_REVERSE_ADAPTER = getAddress(
  "0x00000000000000000000000000000000000ada01",
);
const ARCHIVED_DEFAULT_REVERSE_ADAPTER = getAddress(
  "0x00000000000000000000000000000000000ada02",
);
const ARCHIVED_ETH_RENEWER = getAddress(
  "0x00000000000000000000000000000000000ada03",
);

describe("v1 registrar freeze", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;
  const workDir = mkdtempSync(join(tmpdir(), "v1-registrar-freeze-"));
  const v1DeploymentsDir = join(workDir, "v1");
  const deploymentsDir = join(workDir, "v2");

  setupEnv({ resetOnEach: true });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeDeployment(
    root: string,
    namespace: string,
    name: string,
    deployment: { address: Address; abi: readonly unknown[] },
  ) {
    writeDeploymentRecord(root, namespace, name, {
      address: deployment.address,
      abi: deployment.abi,
    });
  }

  function writeDeploymentRecord(
    root: string,
    namespace: string,
    name: string,
    deployment: unknown,
  ) {
    const dir = join(root, namespace);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify(deployment, (_, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );
  }

  function writeNamespaceMetadata(root: string, namespace: string) {
    writeFileSync(
      join(root, namespace, ".chain"),
      JSON.stringify({ environment: namespace, chainId: "1" }),
    );
  }

  // Mirrors the artifact layout the freeze reads: the shared v1 contracts under the
  // v1 deployments root, and one v2 namespace per deployment — the active one plus a
  // superseded one whose handoff contracts must be revoked.
  function writeDeploymentArtifacts({
    activeNamespace = ACTIVE_NAMESPACE,
    archivedNamespace = ARCHIVED_NAMESPACE,
  }: {
    activeNamespace?: string;
    archivedNamespace?: string;
  } = {}) {
    rmSync(workDir, { recursive: true, force: true });
    for (const [name, contract] of [
      ["BaseRegistrarImplementation", env.v1.BaseRegistrar],
      ["RegistrarSecurityController", env.v1.RegistrarSecurityController],
      ["ReverseRegistrar", env.shared.ReverseRegistrar],
      ["DefaultReverseRegistrar", env.shared.DefaultReverseRegistrar],
    ] as const) {
      writeDeployment(v1DeploymentsDir, NETWORK, name, contract);
    }

    for (const [name, contract] of [
      ["ReverseRegistrarAdapter", env.shared.ReverseRegistrarAdapter],
      [
        "DefaultReverseRegistrarAdapter",
        env.shared.DefaultReverseRegistrarAdapter,
      ],
    ] as const) {
      writeDeployment(deploymentsDir, activeNamespace, name, contract);
    }
    writeNamespaceMetadata(deploymentsDir, activeNamespace);

    for (const [name, address] of [
      ["ReverseRegistrarAdapter", ARCHIVED_REVERSE_ADAPTER],
      ["DefaultReverseRegistrarAdapter", ARCHIVED_DEFAULT_REVERSE_ADAPTER],
      ["ETHRenewerV1", ARCHIVED_ETH_RENEWER],
    ] as const) {
      writeDeployment(deploymentsDir, archivedNamespace, name, {
        address,
        abi: [],
      });
    }
    writeNamespaceMetadata(deploymentsDir, archivedNamespace);
  }

  function writeHCAResumeDeploymentArtifacts() {
    rmSync(workDir, { recursive: true, force: true });
    for (const [name, contract] of [
      ["BaseRegistrarImplementation", env.v1.BaseRegistrar],
      ["RegistrarSecurityController", env.v1.RegistrarSecurityController],
      ["ReverseRegistrar", env.shared.ReverseRegistrar],
      ["DefaultReverseRegistrar", env.shared.DefaultReverseRegistrar],
    ] as const) {
      writeDeployment(v1DeploymentsDir, NETWORK, name, contract);
    }
    writeNamespaceMetadata(v1DeploymentsDir, NETWORK);

    for (const [name, deployment] of Object.entries(env.rocketh.deployments)) {
      writeDeploymentRecord(
        deploymentsDir,
        HCA_RESUME_NAMESPACE,
        name,
        name === "ReverseRegistrarAdapter" ||
          name === "DefaultReverseRegistrarAdapter"
          ? { ...deployment, argsData: "0x" }
          : deployment,
      );
    }
    writeNamespaceMetadata(deploymentsDir, HCA_RESUME_NAMESPACE);
  }

  async function executeHCAResumeDeployment(deferredFile: string) {
    writeFileSync(deferredFile, "");
    const chainId = 1;
    return loadAndExecuteDeploymentsFromFilesWithConfig(
      {
        environment: HCA_RESUME_NAMESPACE,
        askBeforeProceeding: false,
        tags: ["hca"],
        saveDeployments: true,
        defaultPollingInterval: 0.001,
        extra: {
          v1DeploymentsDir,
          v1DeploymentNetwork: NETWORK,
          deferV1OwnerTransactions: true,
          deferredV1OwnerTransactionsFile: deferredFile,
        },
      },
      {
        deployments: deploymentsDir,
        accounts: {
          deployer: env.namedAccounts.deployer.address,
          owner: env.namedAccounts.owner.address,
          v1Owner: env.namedAccounts.owner.address,
          urManager: env.namedAccounts.owner.address,
          user: env.namedAccounts.user.address,
          user2: env.namedAccounts.user2.address,
        } as never,
        chains: {
          [chainId]: {
            info: env.client.chain,
            rpcUrl: `http://${env.hostPort}`,
            pollingInterval: 0.001,
            tags: [
              "v2",
              "local",
              "use_root",
              "allow_unsafe",
              "legacy",
              "tenderly",
            ],
          },
        },
        environments: {
          [HCA_RESUME_NAMESPACE]: {
            chain: chainId,
            scripts: ["deploy"],
          },
        },
      } satisfies UserConfig,
    );
  }

  async function replayDeferredTransactions(
    deferred: readonly {
      from: Address;
      to: Address;
      value?: string;
      data: `0x${string}`;
    }[],
  ) {
    const owner = env.namedAccounts.owner;
    const wallet = env.createClient(owner);
    for (const transaction of deferred) {
      expect(getAddress(transaction.from)).toBe(getAddress(owner.address));
      await env.waitFor(
        wallet.sendTransaction({
          to: transaction.to,
          value: BigInt(transaction.value ?? "0"),
          data: transaction.data,
        }),
      );
    }
  }

  // Wraps the devnet RPC so `eth_getLogs` is answered only for spans up to `cap`,
  // the way a provider with a block-range limit does. A cap of zero refuses every
  // span with a message that is not about the span at all.
  function providerCappingLogSpan(cap: bigint | null) {
    const transport = env.createClient(env.accounts[0]);
    const state = { refusals: 0 };
    return {
      state,
      provider: {
        request(args: {
          method: string;
          params?: readonly unknown[] | object;
        }) {
          if (args.method === "eth_getLogs") {
            const [filter] = args.params as [
              { fromBlock: `0x${string}`; toBlock: `0x${string}` },
            ];
            const span = BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n;
            if (cap === null) {
              return Promise.reject(new Error("log reads are unavailable"));
            }
            if (span > cap) {
              state.refusals += 1;
              return Promise.reject(
                new Error(
                  "query block range exceeds server limit, narrow your filter",
                ),
              );
            }
          }
          return transport.request(args as never);
        },
      },
    };
  }

  function freezeOptions(overrides: { deploymentNetwork?: string } = {}) {
    return {
      network: NETWORK,
      rpcUrl: `http://${env.hostPort}`,
      chainId: "1",
      deploymentsDir,
      deploymentNetwork: ACTIVE_NAMESPACE,
      v1DeploymentsDir,
      v1DeploymentNetwork: NETWORK,
      impersonateOwner: true,
      ...overrides,
    } as const;
  }

  async function ownerAccountOf(contract: {
    read: { owner: () => Promise<Address> };
  }) {
    const owner = await contract.read.owner();
    const account = env.accounts.find(
      (candidate) => getAddress(candidate.address) === getAddress(owner),
    );
    if (!account) throw new Error(`no local account for owner ${owner}`);
    return account;
  }

  // Grants a superseded deployment's handoff contracts the same v1 authorizations a
  // prior migration would have left behind.
  async function authorizeArchivedHandoffContracts() {
    const reverseOwner = await ownerAccountOf(env.shared.ReverseRegistrar);
    await env.shared.ReverseRegistrar.write.setController(
      [ARCHIVED_REVERSE_ADAPTER, true],
      { account: reverseOwner },
    );
    const defaultReverseOwner = await ownerAccountOf(
      env.shared.DefaultReverseRegistrar,
    );
    await env.shared.DefaultReverseRegistrar.write.setController(
      [ARCHIVED_DEFAULT_REVERSE_ADAPTER, true],
      { account: defaultReverseOwner },
    );
    const securityOwner = await ownerAccountOf(
      env.v1.RegistrarSecurityController,
    );
    await env.v1.RegistrarSecurityController.write.addRegistrarController(
      [ARCHIVED_ETH_RENEWER],
      { account: securityOwner },
    );
  }

  // Stands up a superseded deployment's reverse adapters the way a pruned or
  // never-committed namespace leaves them: real contracts holding real grants, with
  // no artifact on disk pointing at them. Only their on-chain back-reference to the
  // registrar they forward to identifies them as this tooling's.
  async function deployUntrackedReverseAdapters() {
    const wallet = env.createClient(env.accounts[0]);
    const [standaloneHCAFactory, contractNamer] = await Promise.all([
      env.shared.ReverseRegistrarAdapter.read.STANDALONE_HCA_FACTORY(),
      env.shared.ReverseRegistrarAdapter.read.CONTRACT_NAMER(),
    ]);
    // Sequential: both deployments sign from the same account, and the address is
    // derived from the nonce read before sending.
    const adapter = await deployArtifact(wallet, {
      file: new URL(
        "../../out/ReverseRegistrarAdapter.sol/ReverseRegistrarAdapter.json",
        import.meta.url,
      ),
      args: [
        env.shared.ReverseRegistrar.address,
        standaloneHCAFactory,
        contractNamer,
      ],
    });
    const defaultAdapter = await deployArtifact(wallet, {
      file: new URL(
        "../../out/DefaultReverseRegistrarAdapter.sol/DefaultReverseRegistrarAdapter.json",
        import.meta.url,
      ),
      args: [
        env.shared.DefaultReverseRegistrar.address,
        standaloneHCAFactory,
        contractNamer,
      ],
    });

    const reverseOwner = await ownerAccountOf(env.shared.ReverseRegistrar);
    await env.shared.ReverseRegistrar.write.setController([adapter, true], {
      account: reverseOwner,
    });
    const defaultReverseOwner = await ownerAccountOf(
      env.shared.DefaultReverseRegistrar,
    );
    await env.shared.DefaultReverseRegistrar.write.setController(
      [defaultAdapter, true],
      { account: defaultReverseOwner },
    );
    return { adapter, defaultAdapter };
  }

  // Moves the BaseRegistrar out from under the security controller, the state a
  // re-migration leaves behind once ownership has been reclaimed to the v1 owner.
  async function reclaimRegistrarOwnershipToEoa() {
    const securityOwner = await ownerAccountOf(
      env.v1.RegistrarSecurityController,
    );
    await env.v1.RegistrarSecurityController.write.transferRegistrarOwnership(
      [securityOwner.address],
      { account: securityOwner },
    );
    return securityOwner;
  }

  it(
    "revokes a superseded deployment's reverse registrar adapters",
    async () => {
      writeDeploymentArtifacts();
      await authorizeArchivedHandoffContracts();

      // The audit must see the archived adapters, so the pre-freeze state fails.
      await expect(verifyV1RegistrarsDisabled(freezeOptions())).rejects.toThrow(
        /superseded v1 authorizations still enabled/,
      );

      await disableV1Registrars(freezeOptions());

      await expect(
        env.shared.ReverseRegistrar.read.controllers([
          ARCHIVED_REVERSE_ADAPTER,
        ]),
      ).resolves.toBe(false);
      await expect(
        env.shared.DefaultReverseRegistrar.read.controllers([
          ARCHIVED_DEFAULT_REVERSE_ADAPTER,
        ]),
      ).resolves.toBe(false);
      await expect(
        env.v1.BaseRegistrar.read.controllers([ARCHIVED_ETH_RENEWER]),
      ).resolves.toBe(false);

      // The active deployment's adapters keep writing reverse records.
      await expect(
        env.shared.ReverseRegistrar.read.controllers([
          env.shared.ReverseRegistrarAdapter.address,
        ]),
      ).resolves.toBe(true);
      await expect(
        env.shared.DefaultReverseRegistrar.read.controllers([
          env.shared.DefaultReverseRegistrarAdapter.address,
        ]),
      ).resolves.toBe(true);

      await verifyV1RegistrarsDisabled(freezeOptions());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "preserves HCA adapter revocations across a resume before deferred replay",
    async () => {
      writeHCAResumeDeploymentArtifacts();
      const deferredFile = join(workDir, "hca-owner-transactions.jsonl");
      const oldReverseAdapter = env.shared.ReverseRegistrarAdapter.address;
      const oldDefaultAdapter =
        env.shared.DefaultReverseRegistrarAdapter.address;

      await executeHCAResumeDeployment(deferredFile);
      const second = await executeHCAResumeDeployment(deferredFile);
      const newReverseAdapter = second.get("ReverseRegistrarAdapter").address;
      const newDefaultAdapter = second.get(
        "DefaultReverseRegistrarAdapter",
      ).address;
      const validator = second.get<
        (typeof artifacts.HCAOwnerAndSessionValidator)["abi"]
      >("HCAOwnerAndSessionValidator");

      const deferred = readFileSync(deferredFile, "utf-8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line)) as Array<{
        from: Address;
        to: Address;
        value?: string;
        data: `0x${string}`;
        functionName: string;
        args: [Address, boolean];
      }>;
      const transactionIndex = (
        registrar: Address,
        adapter: Address,
        enabled: boolean,
      ) =>
        deferred.findIndex(
          (transaction) =>
            getAddress(transaction.to) === getAddress(registrar) &&
            transaction.functionName === "setController" &&
            getAddress(transaction.args[0]) === getAddress(adapter) &&
            transaction.args[1] === enabled,
        );

      const reverseGrant = transactionIndex(
        env.shared.ReverseRegistrar.address,
        newReverseAdapter,
        true,
      );
      const reverseRevoke = transactionIndex(
        env.shared.ReverseRegistrar.address,
        oldReverseAdapter,
        false,
      );
      const defaultGrant = transactionIndex(
        env.shared.DefaultReverseRegistrar.address,
        newDefaultAdapter,
        true,
      );
      const defaultRevoke = transactionIndex(
        env.shared.DefaultReverseRegistrar.address,
        oldDefaultAdapter,
        false,
      );

      expect(reverseGrant).toBeGreaterThanOrEqual(0);
      expect(reverseRevoke).toBeGreaterThan(reverseGrant);
      expect(defaultGrant).toBeGreaterThanOrEqual(0);
      expect(defaultRevoke).toBeGreaterThan(defaultGrant);

      await replayDeferredTransactions(deferred);

      await expect(
        env.shared.ReverseRegistrar.read.controllers([newReverseAdapter]),
      ).resolves.toBe(true);
      await expect(
        env.shared.ReverseRegistrar.read.controllers([oldReverseAdapter]),
      ).resolves.toBe(false);
      await expect(
        env.shared.DefaultReverseRegistrar.read.controllers([
          newDefaultAdapter,
        ]),
      ).resolves.toBe(true);
      await expect(
        env.shared.DefaultReverseRegistrar.read.controllers([
          oldDefaultAdapter,
        ]),
      ).resolves.toBe(false);
      const configuredDefaultAdapter = await env.client.readContract({
        address: validator.address,
        abi: validator.abi,
        functionName: "DEFAULT_REVERSE_REGISTRAR_HCA_ADAPTER",
      });
      expect(getAddress(configuredDefaultAdapter)).toBe(
        getAddress(newDefaultAdapter),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "revokes registrar controllers while the security controller owns the registrar",
    async () => {
      writeDeploymentArtifacts();
      await authorizeArchivedHandoffContracts();

      await disableV1Registrars(freezeOptions());

      await expect(
        env.v1.BaseRegistrar.read.controllers([ARCHIVED_ETH_RENEWER]),
      ).resolves.toBe(false);
      await expect(
        env.v1.BaseRegistrar.read.controllers([env.v1.NameWrapper.address]),
      ).resolves.toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "revokes registrar controllers after ownership is reclaimed from the security controller",
    async () => {
      writeDeploymentArtifacts();
      await authorizeArchivedHandoffContracts();
      const registrarOwner = await reclaimRegistrarOwnershipToEoa();

      // Routing through the security controller would revert here: it is a
      // pass-through that only works while it owns the registrar.
      expect(getAddress(await env.v1.BaseRegistrar.read.owner())).toBe(
        getAddress(registrarOwner.address),
      );

      await disableV1Registrars(freezeOptions());

      await expect(
        env.v1.BaseRegistrar.read.controllers([ARCHIVED_ETH_RENEWER]),
      ).resolves.toBe(false);
      await expect(
        env.v1.BaseRegistrar.read.controllers([env.v1.NameWrapper.address]),
      ).resolves.toBe(false);
      await expect(
        env.shared.ReverseRegistrar.read.controllers([
          ARCHIVED_REVERSE_ADAPTER,
        ]),
      ).resolves.toBe(false);

      await verifyV1RegistrarsDisabled(freezeOptions());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "revokes superseded reverse adapters that no local artifact describes",
    async () => {
      writeDeploymentArtifacts();
      const { adapter, defaultAdapter } =
        await deployUntrackedReverseAdapters();

      // Artifact-only discovery cannot see these, so the audit has to recover them
      // from the registrars' controller history.
      await expect(verifyV1RegistrarsDisabled(freezeOptions())).rejects.toThrow(
        /superseded v1 authorizations still enabled/,
      );

      await disableV1Registrars(freezeOptions());

      await expect(
        env.shared.ReverseRegistrar.read.controllers([adapter]),
      ).resolves.toBe(false);
      await expect(
        env.shared.DefaultReverseRegistrar.read.controllers([defaultAdapter]),
      ).resolves.toBe(false);

      await expect(
        env.shared.ReverseRegistrar.read.controllers([
          env.shared.ReverseRegistrarAdapter.address,
        ]),
      ).resolves.toBe(true);
      await expect(
        env.shared.DefaultReverseRegistrar.read.controllers([
          env.shared.DefaultReverseRegistrarAdapter.address,
        ]),
      ).resolves.toBe(true);

      await verifyV1RegistrarsDisabled(freezeOptions());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves v1-owned reverse registrar controllers alone",
    async () => {
      writeDeploymentArtifacts();

      // A contract that forwards to no reverse registrar: it answers no
      // back-reference, so the audit must read it as v1's own rather than as a
      // superseded handoff contract.
      const v1Controller = env.v1.BaseRegistrar.address;
      const reverseOwner = await ownerAccountOf(env.shared.ReverseRegistrar);
      await env.shared.ReverseRegistrar.write.setController(
        [v1Controller, true],
        {
          account: reverseOwner,
        },
      );

      await disableV1Registrars(freezeOptions());

      await expect(
        env.shared.ReverseRegistrar.read.controllers([v1Controller]),
      ).resolves.toBe(true);
      await verifyV1RegistrarsDisabled(freezeOptions());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resolves archives of a deployment namespace not named for the network",
    async () => {
      writeDeploymentArtifacts({
        activeNamespace: CUSTOM_NAMESPACE,
        archivedNamespace: CUSTOM_ARCHIVED_NAMESPACE,
      });
      await authorizeArchivedHandoffContracts();

      const customOptions = freezeOptions({
        deploymentNetwork: CUSTOM_NAMESPACE,
      });
      await disableV1Registrars(customOptions);

      await expect(
        env.shared.ReverseRegistrar.read.controllers([
          ARCHIVED_REVERSE_ADAPTER,
        ]),
      ).resolves.toBe(false);
      await expect(
        env.v1.BaseRegistrar.read.controllers([ARCHIVED_ETH_RENEWER]),
      ).resolves.toBe(false);

      // The active namespace shares no prefix with the network, so a network-keyed
      // scan would leave its grants unaccounted for and revoke them.
      await expect(
        env.shared.ReverseRegistrar.read.controllers([
          env.shared.ReverseRegistrarAdapter.address,
        ]),
      ).resolves.toBe(true);
      await expect(
        env.shared.DefaultReverseRegistrar.read.controllers([
          env.shared.DefaultReverseRegistrarAdapter.address,
        ]),
      ).resolves.toBe(true);

      await verifyV1RegistrarsDisabled(customOptions);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails rather than auditing partially when controller history cannot be read",
    async () => {
      writeDeploymentArtifacts();
      await authorizeArchivedHandoffContracts();
      const { provider } = providerCappingLogSpan(null);

      await expect(
        verifyV1RegistrarsDisabled({ ...freezeOptions(), provider }),
      ).rejects.toThrow(/log reads are unavailable/);
      await expect(
        disableV1Registrars({ ...freezeOptions(), provider }),
      ).rejects.toThrow(/log reads are unavailable/);

      // Nothing was revoked on the way to the failure.
      await expect(
        env.shared.ReverseRegistrar.read.controllers([
          ARCHIVED_REVERSE_ADAPTER,
        ]),
      ).resolves.toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "narrows the controller history scan to the span the provider serves",
    async () => {
      writeDeploymentArtifacts();
      const { adapter, defaultAdapter } =
        await deployUntrackedReverseAdapters();

      // The scan only narrows above its minimum span, so the chain has to be
      // longer than one request's worth. Mined in small batches, since a single
      // large batch outruns the RPC request timeout on a slow machine.
      while ((await env.client.getBlockNumber()) < MIN_SCAN_NARROWING_BLOCK) {
        await env.client.mine({ blocks: 256 });
      }

      const { provider, state } = providerCappingLogSpan(1_000n);
      await disableV1Registrars({ ...freezeOptions(), provider });

      expect(state.refusals).toBeGreaterThan(0);
      await expect(
        env.shared.ReverseRegistrar.read.controllers([adapter]),
      ).resolves.toBe(false);
      await expect(
        env.shared.DefaultReverseRegistrar.read.controllers([defaultAdapter]),
      ).resolves.toBe(false);
      await expect(
        env.shared.ReverseRegistrar.read.controllers([
          env.shared.ReverseRegistrarAdapter.address,
        ]),
      ).resolves.toBe(true);

      await verifyV1RegistrarsDisabled({ ...freezeOptions(), provider });
    },
    TEST_TIMEOUT_MS,
  );
});
