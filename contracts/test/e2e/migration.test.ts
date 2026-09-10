import { describe, it } from "bun:test";
import {
  type AbiParameterToPrimitiveType,
  type Account,
  type Address,
  encodeAbiParameters,
  type Hex,
  zeroAddress,
} from "viem";
import {
  STATUS,
  MAX_EXPIRY,
  FUSES,
  PREMIGRATION_BONUS_PERIOD,
  SEC_PER_YEAR,
  GRACE_PERIOD_V2,
} from "../../script/deploy-constants.js";
import { migrationDataComponents } from "../../script/migration.js";
import { expect, expectVar } from "../utils/expectVar.js";
import {
  COIN_TYPE_ETH,
  dnsEncodeName,
  getLabelAt,
  getParentName,
  idFromLabel,
  namehash,
} from "../utils/utils.js";
import {
  bundleCalls,
  type KnownProfile,
  makeResolutions,
} from "../utils/resolutions.js";

// see: LibMigration.sol
type MigrationData = AbiParameterToPrimitiveType<{
  type: "tuple";
  components: typeof migrationDataComponents;
}>;

const anotherAddress = "0x8000000000000000000000000000000000000001";
const defaultProfile = {
  addresses: [{ coinType: COIN_TYPE_ETH, value: anotherAddress }],
  texts: [{ key: "url", value: "https://ens.domains" }],
  contenthash: { value: "0x12345678" },
} as const satisfies Partial<KnownProfile>;

describe("Migration", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;

  setupEnv({
    resetOnEach: true,
    async initialize() {
      // hack: add controller so we can register() directly
      // v1.7.0: BaseRegistrar is now owned by RegistrarSecurityController
      await env.v1.RegistrarSecurityController.write.addRegistrarController(
        [env.namedAccounts.deployer.address],
        { account: env.namedAccounts.owner },
      );
      // assumes fallback resolver set during deployment
      // see: deploy/00_ENSV2Resolver.ts
    },
  });

  async function ensurePremigration(label: string) {
    const tokenId = idFromLabel(label);
    const expiry = await env.v1.BaseRegistrar.read.nameExpires([tokenId]);
    await env.v2.ETHRegistry.write.register([
      label,
      zeroAddress, // owner (must be null)
      zeroAddress, // registry
      env.v2.ENSV1Resolver.address, // fallback resolver
      0n, // roleBitmap (must be null)
      expiry + PREMIGRATION_BONUS_PERIOD,
    ]);
  }

  type MigrateArgs = {
    target: Address;
    sender?: Account;
    rawData?: Hex;
    data?: Partial<MigrationData>;
  };

  abstract class TokenV1 {
    constructor(
      readonly name: string,
      readonly account: Account,
    ) {}
    get namehash() {
      return namehash(this.name);
    }
    get label() {
      return getLabelAt(this.name);
    }
    abstract get tokenId(): bigint;
    abstract setResolver(address: Address): Promise<void>;
    abstract migrate(args?: MigrateArgs): Promise<unknown>;
    async makeData(data: Partial<MigrationData> = {}): Promise<MigrationData> {
      const resolver = await env.v1.ENSRegistry.read.resolver([this.namehash]);
      return {
        label: this.label,
        owner: this.account.address,
        subregistry: zeroAddress,
        resolver,
        ...data,
      };
    }
    async setupPublicResolver() {
      await this.setResolver(env.v1.PublicResolver.address);
      await env.v1.PublicResolver.write.multicall(
        [
          makeResolutions({ name: this.name, ...defaultProfile }).map(
            (x) => x.writeV1,
          ),
        ],
        { account: this.account },
      );
    }
    async checkMigrated({
      owner = this.account.address,
    }: {
      owner?: Address;
    } = {}) {
      const parentRegistry = await env.findPermissionedRegistry(
        getParentName(this.name),
      );
      const { status, latestOwner } = await parentRegistry.read.getState([
        idFromLabel(this.label),
      ]);
      expectVar({ status }).toStrictEqual(STATUS.REGISTERED);
      expectVar({ latestOwner }).toEqualAddress(owner);
    }
    async checkResolution() {
      const bundle = bundleCalls(
        makeResolutions({ name: this.name, ...defaultProfile }),
      );
      const [answer1] = await env.v1.UniversalResolver.read.resolve([
        dnsEncodeName(this.name),
        bundle.call,
      ]);
      bundle.expect(answer1);
      const [answer2] = await env.v2.UniversalResolver.read.resolve([
        dnsEncodeName(this.name),
        bundle.call,
      ]);
      bundle.expect(answer2);
    }
  }

  class UnwrappedToken extends TokenV1 {
    override get tokenId() {
      return idFromLabel(this.label);
    }
    override async setResolver(address: Address) {
      await env.v1.ENSRegistry.write.setResolver([this.namehash, address], {
        account: this.account,
      });
    }
    override async migrate(args: Partial<MigrateArgs> = {}) {
      return env.waitFor(
        env.v1.BaseRegistrar.write.safeTransferFrom(
          [
            this.account.address,
            args.target ?? env.v2.UnlockedMigrationController.address,
            this.tokenId,
            args.rawData ?? encodeMigrationData(await this.makeData(args.data)),
          ],
          { account: args.sender ?? this.account },
        ),
      );
    }
    async wrap(fuses: number = FUSES.CAN_DO_EVERYTHING) {
      const { name, account, tokenId, label } = this;
      await env.v1.BaseRegistrar.write.safeTransferFrom(
        [
          account.address,
          env.v1.NameWrapper.address,
          tokenId,
          encodeAbiParameters(
            // https://github.com/ensdomains/ens-contracts/blob/staging/contracts/wrapper/NameWrapper.sol#L789-L794
            [
              { name: "label", type: "string" },
              { name: "owner", type: "address" },
              { name: "fuses", type: "uint16" },
              { name: "resolver", type: "address" },
            ],
            [label, account.address, fuses, zeroAddress],
          ),
        ],
        { account },
      );
      return new WrappedToken(name, account);
    }
    async renewV1(duration: bigint) {
      const { label, account } = this;
      const amount = await env.v2.ETHRenewerV1.read.getRenewPrice([
        label,
        duration,
        env.erc20.MockUSDC.address,
      ]);
      await env.erc20.MockUSDC.write.mint([account.address, amount]);
      await env.erc20.MockUSDC.write.approve(
        [env.v2.ETHRenewerV1.address, amount],
        { account },
      );
      await env.v2.ETHRenewerV1.write.renew(
        [
          { label, duration, referrer: namehash("referrer") },
          env.erc20.MockUSDC.address,
        ],
        { account },
      );
    }
  }

  class WrappedToken extends TokenV1 {
    override get tokenId() {
      return BigInt(this.namehash);
    }
    override async setResolver(address: Address) {
      await env.v1.NameWrapper.write.setResolver([this.namehash, address], {
        account: this.account,
      });
    }
    async createChild({
      label = "sub",
      fuses = FUSES.CAN_DO_EVERYTHING,
      account = this.account,
      expiry = MAX_EXPIRY,
    }: {
      label?: string;
      fuses?: number;
      account?: Account;
      expiry?: bigint;
    } = {}) {
      await env.v1.NameWrapper.write.setSubnodeOwner(
        [this.namehash, label, account.address, fuses, expiry],
        { account: this.account },
      );
      return new WrappedToken(`${label}.${this.name}`, account);
    }
    burnFuses(fuses: number) {
      return env.v1.NameWrapper.write.setFuses([this.namehash, fuses], {
        account: this.account,
      });
    }
    override async migrate(args: MigrateArgs) {
      return env.waitFor(
        env.v1.NameWrapper.write.safeTransferFrom(
          [
            this.account.address,
            args.target,
            this.tokenId,
            1n,
            args.rawData ?? encodeMigrationData(await this.makeData(args.data)),
          ],
          { account: args.sender ?? this.account },
        ),
      );
    }
    wrapperRegistry(account = this.account) {
      return env.findWrapperRegistry(this.name, account);
    }
  }

  type BaseRegistrarArgs = {
    label?: string;
    account?: Account;
    duration?: bigint;
    premigrate?: boolean;
  };

  async function registerUnwrapped({
    label = "test",
    account = env.namedAccounts.user,
    duration = 86400n,
    premigrate = true,
  }: BaseRegistrarArgs = {}) {
    await env.v1.BaseRegistrar.write.register([
      idFromLabel(label),
      account.address,
      duration,
    ]);
    if (premigrate) {
      await ensurePremigration(label);
    }
    return new UnwrappedToken(`${label}.eth`, account);
  }

  async function registerWrapped(
    args: BaseRegistrarArgs & {
      fuses?: number;
    } = {},
  ) {
    const unwrapped = await registerUnwrapped(args);
    return unwrapped.wrap(args.fuses);
  }

  function encodeMigrationData(v: MigrationData | MigrationData[]): Hex {
    if (Array.isArray(v)) {
      return encodeAbiParameters(
        [{ type: "tuple[]", components: migrationDataComponents }],
        [v],
      );
    } else {
      return encodeAbiParameters(
        [{ type: "tuple", components: migrationDataComponents }],
        [v],
      );
    }
  }

  describe("helpers", () => {
    it("registerUnwrapped()", async () => {
      await registerUnwrapped();
    });
    it("registerWrapped()", async () => {
      await registerWrapped();
    });
    it("createChild()", async () => {
      const wrapped = await registerWrapped();
      await wrapped.createChild();
    });
    it("wrapperRegistry", async () => {
      const v = [await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP })];
      for (let i = 0; i < 5; ++i) {
        v.push(
          await v[v.length - 1].createChild({
            fuses: FUSES.PARENT_CANNOT_CONTROL | FUSES.CANNOT_UNWRAP,
          }),
        );
      }
      let target = env.v2.LockedMigrationController.address;
      for (const x of v) {
        await x.migrate({ target });
        target = x.wrapperRegistry().address;
      }
      for (const x of v) {
        const registry = await env.v2.UniversalHelper.read.findExactRegistry([
          dnsEncodeName(x.name),
        ]);
        expectVar({ registry }).toEqualAddress(x.wrapperRegistry().address);
      }
    });
    it("ensurePremigration()", async () => {
      const unwrapped = await registerUnwrapped();
      const status = await env.v2.ETHRegistry.read.getStatus([
        unwrapped.tokenId,
      ]);
      expectVar({ status }).toStrictEqual(STATUS.RESERVED);
    });
    it("ensurePremigration() of empty name", async () => {
      expect(registerUnwrapped({ label: "" })).rejects.toThrow("LabelIsEmpty");
    });
    it("ensurePremigration() of long name", async () => {
      expect(registerUnwrapped({ label: "a".repeat(256) })).rejects.toThrow(
        "LabelIsTooLong",
      );
    });
  });

  describe("premigration", () => {
    // these should never happen
    it("empty name", async () => {
      const unwrapped = await registerUnwrapped({
        label: "",
        premigrate: false,
      });
      // not LabelIsEmpty() because MIN_DATA_SIZE assumes label.length > 0
      expect(unwrapped.migrate()).rejects.toThrow("InvalidData");
    });

    it("long name", async () => {
      const unwrapped = await registerUnwrapped({
        label: "a".repeat(256),
        premigrate: false,
      });
      expect(unwrapped.migrate()).rejects.toThrow("LabelIsTooLong");
    });

    it("not reserved", async () => {
      const unwrapped = await registerUnwrapped({
        premigrate: false,
      });
      expect(unwrapped.migrate()).rejects.toThrow(
        "EACUnauthorizedAccountRoles",
      );
    });
  });

  describe("postlaunch", () => {
    it("renew", async () => {
      const unwrapped = await registerUnwrapped();
      const expiry0 = await env.v1.BaseRegistrar.read.nameExpires([
        unwrapped.tokenId,
      ]);
      await env.activateV2();
      await unwrapped.renewV1(SEC_PER_YEAR);
      const expiry1 = await env.v1.BaseRegistrar.read.nameExpires([
        unwrapped.tokenId,
      ]);
      expectVar({ expiry1 }).toStrictEqual(expiry0 + SEC_PER_YEAR);
    });

    it("renew in grace", async () => {
      const unwrapped = await registerUnwrapped();
      const expiry0 = await env.v1.BaseRegistrar.read.nameExpires([
        unwrapped.tokenId,
      ]);
      await env.activateV2();
      await env.client.setNextBlockTimestamp({ timestamp: expiry0 });
      await env.client.mine({ blocks: 1 });
      await expect(
        env.v1.BaseRegistrar.read.ownerOf([unwrapped.tokenId]),
      ).rejects.toThrow(); // unowned
      await expect(
        env.v1.BaseRegistrar.read.available([unwrapped.tokenId]),
      ).resolves.toStrictEqual(false); // not available
      await unwrapped.renewV1(SEC_PER_YEAR);
      const expiry1 = await env.v1.BaseRegistrar.read.nameExpires([
        unwrapped.tokenId,
      ]);
      expectVar({ expiry1 }).toStrictEqual(expiry0 + SEC_PER_YEAR);
    });

    it("renew after grace", async () => {
      const unwrapped = await registerUnwrapped();
      const expiry0 = await env.v1.BaseRegistrar.read.nameExpires([
        unwrapped.tokenId,
      ]);
      await env.activateV2();
      await env.client.setNextBlockTimestamp({
        timestamp: expiry0 + PREMIGRATION_BONUS_PERIOD + GRACE_PERIOD_V2,
      });
      await env.client.mine({ blocks: 1 });
      await expect(
        env.v1.BaseRegistrar.read.available([unwrapped.tokenId]),
      ).resolves.toStrictEqual(true); // available
      await expect(unwrapped.renewV1(SEC_PER_YEAR)).rejects.toThrow(
        "NameNotRenewable",
      );
    });

    it("syncWrapper", async () => {
      const unlocked = await registerWrapped();
      await env.activateV2();
      await env.v2.ETHRenewerV1.write.syncWrapper([[unlocked.label]]);
    });
  });

  describe("unwrapped", () => {
    it("migrate", async () => {
      const unwrapped = await registerUnwrapped();
      await unwrapped.setupPublicResolver();
      await unwrapped.checkResolution();
      await unwrapped.migrate();
      await unwrapped.checkMigrated();
      await unwrapped.checkResolution();
    });

    it("migrate with approval", async () => {
      const unwrapped = await registerUnwrapped();
      const { user2 } = env.namedAccounts;
      await env.v1.BaseRegistrar.write.setApprovalForAll(
        [user2.address, true],
        { account: unwrapped.account },
      );
      await unwrapped.migrate({ sender: user2 });
      await unwrapped.checkMigrated();
    });

    it("new owner", async () => {
      const unwrapped = await registerUnwrapped();
      const { user2 } = env.namedAccounts;
      await unwrapped.migrate({
        data: { owner: user2.address },
      });
      await unwrapped.checkMigrated({ owner: user2.address });
    });

    it("new resolver", async () => {
      const unwrapped = await registerUnwrapped();
      await unwrapped.setupPublicResolver();
      await unwrapped.checkResolution();
      const { resolver } = env.namedAccounts.user;
      await unwrapped.migrate({
        data: { resolver: resolver.address },
      });
      await unwrapped.checkMigrated();
      await resolver.write.multicall([
        makeResolutions({ name: unwrapped.name, ...defaultProfile }).map(
          (x) => x.writeV2,
        ),
      ]);
      await unwrapped.checkResolution();
    });

    it("custom subregistry", async () => {
      const unwrapped = await registerUnwrapped();
      await unwrapped.migrate({ data: { subregistry: anotherAddress } });
      await unwrapped.checkMigrated();
      const subregistry = await env.v2.ETHRegistry.read.getSubregistry([
        unwrapped.label,
      ]);
      expectVar({ subregistry }).toEqualAddress(anotherAddress);
    });

    it("invalid owner", async () => {
      const unwrapped = await registerUnwrapped();
      expect(
        unwrapped.migrate({ data: { owner: zeroAddress } }), // wrong
      ).rejects.toThrow("InvalidOwner");
    });

    it("invalid receiver", async () => {
      const unwrapped = await registerUnwrapped();
      expect(
        unwrapped.migrate({ data: { owner: env.v2.ETHRegistry.address } }), // not IERC1155Receiver
      ).rejects.toThrow("ERC1155InvalidReceiver");
    });

    it("wrong controller", async () => {
      const unwrapped = await registerUnwrapped();
      expect(
        unwrapped.migrate({ target: env.v2.LockedMigrationController.address }), // wrong
      ).rejects.toThrow("ERC721: transfer to non ERC721Receiver implementer");
    });

    it("invalid data", async () => {
      const unwrapped = await registerUnwrapped();
      expect(
        unwrapped.migrate({ rawData: "0x1234" }), // wrong
      ).rejects.toThrow("InvalidData");
    });

    it("wrong label", async () => {
      const unwrapped = await registerUnwrapped();
      expect(
        unwrapped.migrate({ data: { label: unwrapped.label + "2" } }), // wrong
      ).rejects.toThrow("NameDataMismatch");
    });
  });

  describe("unlocked", () => {
    it("migrate", async () => {
      const unlocked = await registerWrapped();
      await unlocked.setupPublicResolver();
      await unlocked.checkResolution();
      await unlocked.migrate({
        target: env.v2.UnlockedMigrationController.address,
      });
      await unlocked.checkMigrated();
      await unlocked.checkResolution();
    });

    it("invalid owner", async () => {
      const unlocked = await registerWrapped();
      expect(
        unlocked.migrate({
          target: env.v2.UnlockedMigrationController.address,
          data: { owner: zeroAddress }, // wrong
        }),
      ).rejects.toThrow("InvalidOwner");
    });

    it("invalid receiver", async () => {
      const unlocked = await registerUnwrapped();
      expect(
        unlocked.migrate({
          target: env.v2.UnlockedMigrationController.address,
          data: { owner: env.v2.ETHRegistry.address }, // not IERC1155Receiver
        }),
      ).rejects.toThrow("ERC1155InvalidReceiver");
    });

    it("wrong controller", async () => {
      const unlocked = await registerWrapped();
      expect(
        unlocked.migrate({ target: env.v2.LockedMigrationController.address }), // wrong
      ).rejects.toThrow("NameNotLocked");
    });

    it("invalid data", async () => {
      const unlocked = await registerWrapped();
      expect(
        unlocked.migrate({
          target: env.v2.UnlockedMigrationController.address,
          rawData: "0x1234", // wrong
        }),
      ).rejects.toThrow("InvalidData");
    });

    it("wrong label", async () => {
      const unlocked = await registerWrapped();
      expect(
        unlocked.migrate({
          target: env.v2.UnlockedMigrationController.address,
          data: { label: unlocked.label + "2" }, // wrong
        }),
      ).rejects.toThrow("NameDataMismatch");
    });
  });

  describe("locked", () => {
    it("migrate", async () => {
      const locked = await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP });
      await locked.setupPublicResolver();
      await locked.checkResolution();
      await locked.migrate({
        target: env.v2.LockedMigrationController.address,
      });
      await locked.checkMigrated();
      await locked.checkResolution();
    });

    async function testLockedResolver(whitelisted: boolean) {
      const locked = await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP });
      await locked.setupPublicResolver();
      await locked.burnFuses(FUSES.CANNOT_SET_RESOLVER);
      await locked.migrate({
        target: env.v2.LockedMigrationController.address,
        data: { resolver: anotherAddress },
      });
      await locked.checkMigrated();
      const resolver = await env.v2.ETHRegistry.read.getResolver([
        locked.label,
      ]);
      expectVar({ resolver }).toEqualAddress(
        whitelisted
          ? env.v2.PublicResolver.address
          : env.v1.PublicResolver.address,
      );
    }

    it("locked resolver", async () => {
      await env.v2.PublicResolverSet.write.approve(
        [env.v1.PublicResolver.address, false], // remove from set
        { account: env.namedAccounts.owner },
      );
      await testLockedResolver(false);
    });

    it("locked resolver (wrapper-aware)", async () => {
      await testLockedResolver(true);
    });

    it("locked transfer", async () => {
      const locked = await registerWrapped({
        fuses: FUSES.CANNOT_UNWRAP | FUSES.CANNOT_TRANSFER,
      });
      expect(
        locked.migrate({
          target: env.v2.LockedMigrationController.address,
        }),
      ).rejects.toThrow("OperationProhibited");
    });

    it("locked fuses", async () => {
      const locked = await registerWrapped({
        fuses: FUSES.CANNOT_UNWRAP | FUSES.CANNOT_BURN_FUSES,
      });
      await locked.migrate({
        target: env.v2.LockedMigrationController.address,
      });
      await locked.checkMigrated();
    });

    it("migrate locked child", async () => {
      const locked = await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP });
      const lockedChild = await locked.createChild({
        fuses: FUSES.PARENT_CANNOT_CONTROL | FUSES.CANNOT_UNWRAP,
      });
      await lockedChild.setupPublicResolver();
      await lockedChild.checkResolution();
      await locked.migrate({
        target: env.v2.LockedMigrationController.address,
      });
      const lockedRegistry = locked.wrapperRegistry();
      await lockedChild.migrate({
        target: lockedRegistry.address,
      });
      await lockedChild.checkMigrated();
      await lockedChild.checkResolution();
    });

    it("migrate detached child", async () => {
      const locked = await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP });
      const detachedChild = await locked.createChild({
        fuses: FUSES.PARENT_CANNOT_CONTROL,
      });
      await detachedChild.setupPublicResolver();
      await detachedChild.checkResolution();
      await locked.migrate({
        target: env.v2.LockedMigrationController.address,
      });
      const lockedRegistry = locked.wrapperRegistry();
      await detachedChild.migrate({
        target: lockedRegistry.address,
      });
      await detachedChild.checkMigrated();
      await detachedChild.checkResolution();
    });

    it("unmigrated locked child", async () => {
      const locked = await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP });
      const lockedChild = await locked.createChild({
        fuses: FUSES.PARENT_CANNOT_CONTROL | FUSES.CANNOT_UNWRAP,
      });
      await locked.migrate({
        target: env.v2.LockedMigrationController.address,
      });
      const lockedRegistry = locked.wrapperRegistry();

      // name has fallback resolver
      const resolver = await lockedRegistry.read.getResolver([
        lockedChild.label,
      ]);
      expectVar({ resolver }).toEqualAddress(env.v2.ENSV1Resolver.address);

      // name cannot be registered
      expect(
        lockedRegistry.write.register([
          lockedChild.label,
          lockedChild.account.address,
          zeroAddress,
          zeroAddress,
          0n,
          MAX_EXPIRY,
        ]),
      ).rejects.toThrow("NameRequiresMigration");
    });

    it("unmigrated detached child", async () => {
      const locked = await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP });
      const detachedChild = await locked.createChild({
        fuses: FUSES.PARENT_CANNOT_CONTROL,
      });
      await locked.migrate({
        target: env.v2.LockedMigrationController.address,
      });
      const lockedRegistry = locked.wrapperRegistry();

      // name has fallback resolver
      const resolver = await lockedRegistry.read.getResolver([
        detachedChild.label,
      ]);
      expectVar({ resolver }).toEqualAddress(env.v2.ENSV1Resolver.address);

      // name cannot be registered
      expect(
        lockedRegistry.write.register([
          detachedChild.label,
          detachedChild.account.address,
          zeroAddress,
          zeroAddress,
          0n,
          MAX_EXPIRY,
        ]),
      ).rejects.toThrow("NameRequiresMigration");
    });

    it("unmigrated unlocked child", async () => {
      const locked = await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP });
      const unlockedChild = await locked.createChild();
      await unlockedChild.setupPublicResolver();
      await locked.migrate({
        target: env.v2.LockedMigrationController.address,
      });
      const lockedRegistry = locked.wrapperRegistry();

      // name cannot be migrated
      expect(
        unlockedChild.migrate({ target: lockedRegistry.address }),
      ).rejects.toThrow("NameNotLocked");

      // name has null resolver
      const resolver = await lockedRegistry.read.getResolver([
        unlockedChild.label,
      ]);
      expectVar({ resolver }).toEqualAddress(zeroAddress);

      // name can be clobbered
      await lockedRegistry.write.register([
        unlockedChild.label,
        unlockedChild.account.address,
        zeroAddress,
        zeroAddress,
        0n,
        MAX_EXPIRY,
      ]);
    });

    it("can extend expiry", async () => {
      const locked = await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP });
      const lockedChild = await locked.createChild({
        account: env.namedAccounts.user2,
        fuses:
          FUSES.PARENT_CANNOT_CONTROL |
          FUSES.CANNOT_UNWRAP |
          FUSES.CAN_EXTEND_EXPIRY,
      });
      await locked.migrate({
        target: env.v2.LockedMigrationController.address,
      });
      const lockedRegistry = locked.wrapperRegistry();
      await lockedChild.migrate({
        target: lockedRegistry.address,
      });
      const state = await lockedRegistry.read.getState([
        idFromLabel(lockedChild.label),
      ]);
      await lockedRegistry.write.renew([state.tokenId, state.expiry + 1n], {
        account: lockedChild.account,
      });
    });

    it("invalid owner", async () => {
      const locked = await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP });
      expect(
        locked.migrate({
          target: env.v2.LockedMigrationController.address,
          data: { owner: zeroAddress }, // wrong
        }),
      ).rejects.toThrow("InvalidOwner");
    });

    it("invalid receiver", async () => {
      const locked = await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP });
      expect(
        locked.migrate({
          target: env.v2.LockedMigrationController.address,
          data: { owner: env.v2.ETHRegistry.address }, // not IERC1155Receiver
        }),
      ).rejects.toThrow("ERC1155InvalidReceiver");
    });

    it("wrong controller", async () => {
      const locked1 = await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP });
      const lockedChild = await locked1.createChild({
        fuses: FUSES.PARENT_CANNOT_CONTROL | FUSES.CANNOT_UNWRAP,
      });
      const locked2 = await registerWrapped({
        label: locked1.label + "2",
        fuses: FUSES.CANNOT_UNWRAP,
      });
      await locked2.migrate({
        target: env.v2.LockedMigrationController.address,
      });
      const locked2Registry = locked2.wrapperRegistry();

      // 2LD => UnlockedMigrationController
      expect(
        locked1.migrate({
          target: env.v2.UnlockedMigrationController.address,
        }),
      ).rejects.toThrow("NameIsLocked");

      // 3LD => LockedMigrationController
      expect(
        lockedChild.migrate({
          target: env.v2.LockedMigrationController.address,
        }),
      ).rejects.toThrow("NameDataMismatch");

      // 2LD => WrapperRegistry
      expect(
        locked1.migrate({ target: locked2Registry.address }),
      ).rejects.toThrow("NameDataMismatch");

      // 3LD => wrong WrapperRegistry
      expect(
        lockedChild.migrate({ target: locked2Registry.address }),
      ).rejects.toThrow("NameDataMismatch");
    });

    it("invalid data", async () => {
      const locked = await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP });
      expect(
        locked.migrate({
          target: env.v2.LockedMigrationController.address,
          rawData: "0x1234", // wrong
        }),
      ).rejects.toThrow("InvalidData");
    });

    it("wrong label", async () => {
      const locked = await registerWrapped({ fuses: FUSES.CANNOT_UNWRAP });
      expect(
        locked.migrate({
          target: env.v2.LockedMigrationController.address,
          data: { label: locked.label + "2" }, // wrong
        }),
      ).rejects.toThrow("NameDataMismatch");
    });
  });
});
