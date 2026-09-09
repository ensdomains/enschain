# Universal Resolver Deployment Structure

## Overview

During the v1 → v2 migration, universal resolution runs through a chain of two upgradable proxies in front of the implementation:

```
ENS clients
  └─ UpgradableUniversalResolverProxy          "top URP"
     │   admin: DAO on mainnet, top URP owner on sepolia (`owner` account)
     └─ ManagedUniversalResolverProxy          "managed URP"
        │   admin: security council (`urManager` account)
        └─ UniversalResolverV2                 implementation
```

- **Top URP** — the long-lived address clients resolve through: `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` on mainnet, sepolia, and holesky (`DEPLOYED_UNIVERSAL_RESOLVER_PROXY` in [`script/deploy-constants.ts`](../script/deploy-constants.ts)). Its admin is the slow-moving owner: the DAO on mainnet, the top URP owner account on sepolia. **The top URP is never (re)deployed by these scripts** — it is always adopted by address. Deploying a fresh top URP on a new network is not currently supported (the create3 path was removed; it can be re-added later).
- **Managed (intermediate) URP** — a second instance of the same proxy contract, admin'd by an account we control (the security council, or a designated intermediate URP admin). It exists so that implementation upgrades during the migration require only a transaction from its admin, never a top-URP-owner transaction.
- **UniversalResolverV2** — the stateless implementation ([`src/universalResolver/UniversalResolverV2.sol`](../src/universalResolver/UniversalResolverV2.sol)).

### Reuse vs. bootstrap

There are two flows depending on whether the top URP already fronts an intermediate URP we administer:

- **Reuse** (networks listed in `KNOWN_INTERMEDIATE_URP`, e.g. sepolia → `0x6d80F2172CFdEc5730fE683860C33d26fC42e6F1`): the top URP already points at the intermediate URP, so a fresh v2 deployment **adopts the existing intermediate URP** and the *only* on-chain mutation is `intermediateUrp.upgradeTo(newImplementation)`, signed by the intermediate URP admin. The externally-administered top URP is never touched, so no top-URP-owner (or DAO) signature is needed.
- **Bootstrap** (mainnet and fresh chains, where the top URP still points directly at v1): a fresh intermediate URP is deployed and the top URP owner points the top URP at it once, before the v2 upgrade. After the migration stabilizes, the top URP owner could point the top URP directly at the final implementation, retiring the managed hop.

## Lifecycle

**Reuse flow** (intermediate URP already in place):

1. **Adopt the top URP and the existing intermediate URP** by address.
2. **Deploy the `UniversalResolverV2` implementation.**
3. **Upgrade intermediate URP → `UniversalResolverV2`** (intermediate URP admin transaction). This is the v2 resolution cutover. The top URP is untouched.

**Bootstrap flow** (no intermediate URP yet):

1. **Adopt the top URP** (pointing at the v1 `UniversalResolver`).
2. **Deploy the intermediate URP**, seeded to whatever the top URP currently serves.
3. **Switch top URP → intermediate URP** (one top-URP-owner transaction). Resolution behavior is unchanged.
4. **Deploy the `UniversalResolverV2` implementation.**
5. **Upgrade intermediate URP → `UniversalResolverV2`** (admin transaction). This is the v2 resolution cutover.
6. **Post-cutover:** optionally point the top URP directly at the implementation, removing the managed hop.

## Deploy scripts

The phases map to [`deploy/universalResolver/`](../deploy/universalResolver/):

| Script | Action | Signer | Migration tag |
| --- | --- | --- | --- |
| `00_deploy_UniversalResolver.ts` | Adopt the known `0xeEeE…EeEe` top URP (clean-testnet runs deploy their own) | `deployer` | `migration:phase1:deploy-v2` |
| `01_setup_UniversalResolverToV1.ts` | Initialize a freshly bootstrapped top URP → v1 `UniversalResolver` (skips once the top URP already serves an implementation) | `owner` † | `migration:phase1:deploy-v2` |
| `02_deploy_ManagedUniversalResolverProxy.ts` | Adopt the known intermediate URP (reuse), else deploy a fresh one | `deployer` | `migration:phase1:deploy-v2` |
| `03_setup_UniversalResolverToManaged.ts` | Point top URP → intermediate URP (skips when it already does) | `owner` † | `migration:phase5:switch-urp-to-managed` |
| `04_deploy_UniversalResolverImplementation.ts` | Deploy `UniversalResolverV2` | `deployer` | `migration:phase1:deploy-v2` |
| `05_setup_ManagedUniversalResolverProxyToUniversalResolverImplementation.ts` | Upgrade intermediate URP → `UniversalResolverV2` | `urManager` † | `migration:phase6:upgrade-managed-urp` |
| `06_setup_UniversalResolverToUniversalResolverImplementation.ts` | Point top URP → `UniversalResolverV2` directly (bootstrap post-cutover only) | `owner` † | `migration:post-cutover:direct-urp-to-v2` |

In the reuse flow only scripts `00`, `02`, `04`, and `05` do anything — `01` and `03` short-circuit because the top URP already fronts the intermediate URP, and `06` is a bootstrap-only post-cutover step.

† When a setup script's proxy admin is external, the script does not execute the upgrade. It prints the target address and `upgradeTo` calldata for the admin to execute out-of-band (see `logUpgradeCalldata` in [`script/universalResolverDeployUtils.ts`](../script/universalResolverDeployUtils.ts)). The top-URP scripts (`01`, `03`, `06`) defer on mainnet (DAO) and sepolia (top URP owner); the intermediate-URP script (`05`) defers only on mainnet (DAO / security council) and executes directly on sepolia, where the intermediate URP admin is the `securityCouncil`/`urManager` account.

Setup scripts are idempotent — they read the proxy's current `implementation()` and skip when it already matches.

**Local environments:** every script except `04` skips when the environment has the `local` tag. Local devnets and tests deploy only the bare `UniversalResolverV2` and resolve against it directly, with no proxies.

## Accounts

Named accounts in [`rocketh/config.ts`](../rocketh/config.ts):

| Account | Role | Value |
| --- | --- | --- |
| `owner` | Top URP admin | DAO on mainnet; deployer elsewhere |
| `securityCouncil` | Intermediate URP admin | Intermediate URP admin wallet on sepolia; defaults to `deployer` elsewhere until a council multisig is configured per network |
| `urManager` | Account used by deploy scripts for intermediate-URP operations | Resolves to `securityCouncil` |

## CLI

The bootstrap-only switch (top-URP-owner-signed) and the intermediate-URP upgrade (admin-signed), plus verification, are exposed as `script/migrate.ts` phase commands, for use against live networks and fork rehearsals. In the reuse flow the upgrade is the only step you run. The post-cutover step 6 has no phase command — it runs only as the `migration:post-cutover:direct-urp-to-v2` deploy script:

```bash
# Bootstrap only: top URP → intermediate URP (top URP owner signature).
# No-ops with "top URP already fronts managed URP" when reuse is already in place.
bun run migration -- phase switch-urp-to-managed --network sepolia --rpc-url <url> \
  [--calldata-only] [--private-key <key>] [--impersonate-account <address>]

# Resolution cutover: intermediate URP → UniversalResolverV2 (intermediate URP admin signature)
bun run migration -- phase upgrade-managed-urp --network sepolia --rpc-url <url> \
  [--calldata-only] [--private-key <key>] [--impersonate-account <address>]

# Verify both proxies' current implementations
bun run migration -- phase verify-urp --network sepolia --rpc-url <url> \
  [--expected-top-implementation <address>] [--expected-managed-implementation <address>]
```

- Signing keys come from `--private-key` or environment variables: `SEPOLIA_TOP_URP_OWNER_KEY` / `TOP_URP_OWNER_KEY` for the top URP owner, `UR_MANAGER_KEY` / `DEPLOYER_KEY` for the intermediate URP admin.
- `--calldata-only` prints the transaction target and calldata instead of sending (for multisig execution); `--impersonate-account` sends as the admin on a fork.
- Proxy addresses default to the canonical top URP and the `ManagedUniversalResolverProxy` deployment under `--deployments-dir` / `--deployment-network`; override with `--top-urp` / `--managed-urp` / `--implementation`.
