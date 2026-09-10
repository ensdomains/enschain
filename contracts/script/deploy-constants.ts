export const MAX_EXPIRY = (1n << 64n) - 1n; // see: DatastoreUtils.sol

export const LOCAL_BATCH_GATEWAY_URL = "x-batch-gateway:true";
export const DEPLOYED_UNIVERSAL_RESOLVER_PROXY =
  "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe" as const;

// Networks whose top URP already fronts a long-lived intermediate (managed) URP
// whose admin we control, keyed by network name. On these networks a fresh v2
// deployment reuses the existing intermediate URP instead of deploying a new one.
export const KNOWN_INTERMEDIATE_URP: Record<string, `0x${string}`> = {
  sepolia: "0x6d80F2172CFdEc5730fE683860C33d26fC42e6F1",
};

export const SEPOLIA_USDC =
  "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;

// Faucet-minted MockUSDC from the active deployment namespace, accepted by the
// live rent price oracle and whitelisted on the Rhinestone orchestrator.
// Archived deployment namespaces carry their own MockUSDC instances that the
// live oracle rejects — never source this address from an archived artifact.
export const SEPOLIA_MOCK_USDC =
  "0x768F42455A2D082E23ceeF7d51e5787C82d67a39" as const;

export const RHINESTONE_INTENT_EXECUTOR =
  "0x00000000005aD9ce1f5035FD62CA96CEf16AdAAF" as const;

export const RHINESTONE_GAS_REFUND_PAYMASTER =
  "0x1d7df6Ddc7328Ac827EB4D7f171C60AFB7f9A599" as const;

// Real mainnet payment tokens used by the rent price oracle in place of the
// free-mint test mocks (which must never ship to mainnet). Confirm/adjust the
// accepted set before a mainnet deploy.
export const MAINNET_USDC =
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
export const MAINNET_DAI =
  "0x6B175474E89094C44Da98b954EedeAC495271d0F" as const;

export const STANDARD_RENT_PRICE_ORACLE_PRICE_DECIMALS = 12n;
export const STANDARD_RENT_PRICE_ORACLE_PRICE_SCALE =
  10n ** STANDARD_RENT_PRICE_ORACLE_PRICE_DECIMALS;

export const STANDARD_RENT_PRICE_ORACLE_BASE_RATE_SPECS = [
  { codepointCount: 1, yearlyPrice: 0n },
  { codepointCount: 2, yearlyPrice: 0n },
  { codepointCount: 3, yearlyPrice: 640n },
  { codepointCount: 4, yearlyPrice: 160n },
  { codepointCount: 5, yearlyPrice: 8n },
] as const;

export const STANDARD_RENT_PRICE_ORACLE_DISCOUNT_SCALE = (1n << 128n) - 1n;

export const STANDARD_RENT_PRICE_ORACLE_DISCOUNT_POINT_SPECS = [
  { t: 31_557_600n, numer: 0n, denom: 1n },
  { t: 31_557_600n, numer: 1n, denom: 4n },
  { t: 31_557_600n, numer: 11n, denom: 16n },
  { t: 31_557_600n, numer: 5n, denom: 16n },
  { t: 31_557_600n, numer: 3n, denom: 8n },
  { t: 31_557_600n, numer: 1n, denom: 1n },
] as const;

export function standardRentPriceOracleDiscountRatio(
  numer: bigint,
  denom: bigint,
) {
  return (
    (STANDARD_RENT_PRICE_ORACLE_DISCOUNT_SCALE * numer + denom - 1n) / denom
  );
}

export function standardRentPriceOracleDiscountPoints() {
  return STANDARD_RENT_PRICE_ORACLE_DISCOUNT_POINT_SPECS.map(
    ({ t, numer, denom }) => ({
      t,
      value: standardRentPriceOracleDiscountRatio(numer, denom),
    }),
  );
}

export function standardRentPriceOracleBaseRates(secPerYear: bigint) {
  return STANDARD_RENT_PRICE_ORACLE_BASE_RATE_SPECS.map(({ yearlyPrice }) => {
    const yearlyUnits = STANDARD_RENT_PRICE_ORACLE_PRICE_SCALE * yearlyPrice;
    return (yearlyUnits + secPerYear - 1n) / secPerYear;
  });
}

interface Flags {
  [key: string]: bigint | Flags;
}

const FLAGS = {
  // see: EnhancedAccessControl.sol / EACBaseRolesLib.sol
  ALL: 0x1111111111111111111111111111111111111111111111111111111111111111n,
  // see: PermissionedRegistry.sol / RegistryRolesLib.sol
  REGISTRY: {
    REGISTRAR: 1n << 0n,
    REGISTER_RESERVED: 1n << 4n,
    SET_PARENT: 1n << 8n,
    UNREGISTER: 1n << 12n,
    RENEW: 1n << 16n,
    SET_SUBREGISTRY: 1n << 20n,
    SET_RESOLVER: 1n << 24n,
    CAN_TRANSFER: 1n << 28n,
    WAS_RESERVED: 1n << 32n,
    SET_URI: 1n << 36n,
    CAN_NAME: 1n << 120n,
    UPGRADE: 1n << 124n,
  },
  // see: PermissionedResolver.sol / PermissionedResolverLib.sol
  RESOLVER: {
    SET_ADDRESS: 1n << 0n,
    SET_TEXT: 1n << 4n,
    SET_CONTENTHASH: 1n << 8n,
    SET_ABI: 1n << 12n,
    SET_INTERFACE: 1n << 16n,
    SET_NAME: 1n << 20n,
    SET_DATA: 1n << 24n,
    LINK: 1n << 28n,
    CAN_NAME: 1n << 120n,
    UPGRADE: 1n << 124n,
  },
  // see: StandardRentPriceOracle.sol
  ORACLE: {
    UPDATE_TOKEN: 1n << 0n,
    DISABLE_TOKEN: 1n << 4n,
    CAN_NAME: 1n << 8n,
  },
  // see: PermissionedAddressSet.sol
  ADDRESS_SET: {
    APPROVE: 1n << 0n,
    CAN_NAME: 1n << 4n,
  },
} as const satisfies Flags;

function adminify(flags: Flags): Flags {
  return Object.fromEntries(
    Object.entries(flags).map(([k, x]) => [
      k,
      typeof x === "bigint" ? x << 128n : adminify(x),
    ]),
  );
}

const ADMIN = adminify(FLAGS) as typeof FLAGS;

export const ROLES = {
  ...FLAGS,
  ADMIN,
} as const;

// Role bitmaps for static deployment per README Static Deployment Permissions.
export const DEPLOYMENT_ROLES = {
  // RootRegistry root: REGISTRAR✓✓, REGISTER_RESERVED✓✓, SET_PARENT✓✓, RENEW✓✓
  ROOT_REGISTRY_ROOT:
    ROLES.REGISTRY.REGISTRAR |
    ROLES.ADMIN.REGISTRY.REGISTRAR |
    ROLES.REGISTRY.REGISTER_RESERVED |
    ROLES.ADMIN.REGISTRY.REGISTER_RESERVED |
    ROLES.REGISTRY.SET_PARENT |
    ROLES.ADMIN.REGISTRY.SET_PARENT |
    ROLES.REGISTRY.RENEW |
    ROLES.ADMIN.REGISTRY.RENEW |
    ROLES.REGISTRY.CAN_NAME |
    ROLES.ADMIN.REGISTRY.CAN_NAME |
    ROLES.REGISTRY.SET_URI |
    ROLES.ADMIN.REGISTRY.SET_URI,
  // .eth token: SET_SUBREGISTRY AR, SET_RESOLVER AR
  ETH_TOKEN:
    ROLES.REGISTRY.SET_SUBREGISTRY |
    ROLES.ADMIN.REGISTRY.SET_SUBREGISTRY |
    ROLES.REGISTRY.SET_RESOLVER |
    ROLES.ADMIN.REGISTRY.SET_RESOLVER,
  // .reverse token: full role bitmap.
  // Granting all roles is harmless; some (e.g. REGISTRAR) are root-only and don't apply to tokens.
  REVERSE_REGISTRY_ROOT: FLAGS.ALL,
  // ETHRegistry root deployer: REGISTRAR✓, REGISTER_RESERVED✓, SET_PARENT✓✓, RENEW✓
  ETH_REGISTRY_ROOT:
    ROLES.ADMIN.REGISTRY.REGISTRAR |
    ROLES.ADMIN.REGISTRY.REGISTER_RESERVED |
    ROLES.REGISTRY.SET_PARENT |
    ROLES.ADMIN.REGISTRY.SET_PARENT |
    ROLES.ADMIN.REGISTRY.RENEW |
    ROLES.REGISTRY.CAN_NAME |
    ROLES.ADMIN.REGISTRY.CAN_NAME |
    ROLES.REGISTRY.SET_URI |
    ROLES.ADMIN.REGISTRY.SET_URI,
  // ETHRegistrar and BatchRegistrar are granted REGISTRAR and RENEW on ETHRegistry root at static deploy.
  ETH_REGISTRAR_ROOT: ROLES.REGISTRY.REGISTRAR | ROLES.REGISTRY.RENEW,
  ETH_RENEWER_V1_ROOT: ROLES.REGISTRY.RENEW,
  // UnlockedMigrationController and LockedMigrationController
  // only need to register() pre-migrated reservations on ETHRegistry (see: "ENSv2 Migration Case Study")
  MIGRATION_CONTROLLER_ROOT: ROLES.REGISTRY.REGISTER_RESERVED,
} as const;

// see: IPermissionedRegistry.sol
export const STATUS = {
  AVAILABLE: 0,
  RESERVED: 1,
  REGISTERED: 2,
} as const;

// see: INameWrapper.sol
export const FUSES = {
  CANNOT_UNWRAP: 1 << 0,
  CANNOT_BURN_FUSES: 1 << 1,
  CANNOT_TRANSFER: 1 << 2,
  CANNOT_SET_RESOLVER: 1 << 3,
  CANNOT_SET_TTL: 1 << 4,
  CANNOT_CREATE_SUBDOMAIN: 1 << 5,
  CANNOT_APPROVE: 1 << 6,
  PARENT_CANNOT_CONTROL: 1 << 16,
  IS_DOT_ETH: 1 << 17,
  CAN_EXTEND_EXPIRY: 1 << 18,
  CAN_DO_EVERYTHING: 0,
} as const;

export const FUSE_MASKS = {
  PARENT_CONTROLLED: 0xffff0000,
  PARENT_RESERVED: 0x0000ff80, // bits 7-15 (docs say 17-32)
  USER_SETTABLE: 0xfffdffff, // ~IS_DOT_ETH
} as const;

// see: StandardRegistrar.sol
export const SEC_PER_DAY = 86400n;
export const SEC_PER_YEAR = 365n * SEC_PER_DAY;

export const MIN_COMMITMENT_AGE = 60n; // 1 minute
export const MAX_COMMITMENT_AGE = SEC_PER_DAY;

export const GRACE_PERIOD_V1 = 90n * SEC_PER_DAY;
export const GRACE_PERIOD_V2 = 28n * SEC_PER_DAY;
export const PREMIGRATION_BONUS_PERIOD =
  1n + (GRACE_PERIOD_V1 - GRACE_PERIOD_V2);

export const PRICE_DECIMALS = 12;
export const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);

export const MIN_REGISTER_DURATION = 28n * SEC_PER_DAY;
export const MIN_RENEW_DURATION = 1n;

export const PREMIUM_PRICE_INITIAL = PRICE_SCALE * 100_000_000n;
export const PREMIUM_HALVING_PERIOD = SEC_PER_DAY;
export const PREMIUM_PERIOD = SEC_PER_DAY * 21n;

export const BASE_RATE_PER_CP = [
  0n,
  0n,
  PRICE_SCALE * 640n,
  PRICE_SCALE * 160n,
  PRICE_SCALE * 8n,
].map((x) => (x + SEC_PER_YEAR - 1n) / SEC_PER_YEAR);

export const DISCOUNT_DENOMINATOR = 10n ** 38n;
function discountNumer(numer: bigint, denom: bigint) {
  return (DISCOUNT_DENOMINATOR * numer) / denom;
}
export const DISCOUNT_POINTS: { duration: bigint; numer: bigint }[] = [
  { duration: SEC_PER_YEAR * 2n, numer: discountNumer(7n, 8n) }, //// 1 - 14/16 = 12.50%
  { duration: SEC_PER_YEAR * 3n, numer: discountNumer(11n, 16n) }, // 1 - 11/16 = 31.25%
  { duration: SEC_PER_YEAR * 6n, numer: discountNumer(9n, 16n) }, /// 1 -  9/16 = 43.75%
];
