# ENSv2 Audit Scope

## 0. Changelog

- Audit fix commit (6th May 2026): [ffe4a731c5489a2cc032639b205f36341d7ac660](https://github.com/ensdomains/contracts-v2/commit/ffe4a731c5489a2cc032639b205f36341d7ac660). 14 files touched in `contracts/src/**.sol` (1 added, 13 modified) and +370 LoC additions/modifications (`cloc --diff`, code-only). [diff](https://github.com/ensdomains/contracts-v2/compare/41b67f10d8a62151e67649d98b92bc2317fa56a8...ffe4a731c5489a2cc032639b205f36341d7ac660)
- Initial audit commit (16th March 2026): [41b67f10d8a62151e67649d98b92bc2317fa56a8](https://github.com/ensdomains/contracts-v2/commit/41b67f10d8a62151e67649d98b92bc2317fa56a8)

## 1. Project Overview

ENSv2 is the next-generation Ethereum Name Service, transitioning from a flat registry to a hierarchical system with cross-chain support.

- **Design doc**: [go.ens.xyz/ensv2](http://go.ens.xyz/ensv2)
- **Docs**:[v2 docs (WIP)](https://github.com/ensdomains/docs/tree/master/src/pages/contracts/ensv2)
- **Repository**: [github.com/ensdomains/contracts-v2](https://github.com/ensdomains/contracts-v2)
- **Contracts README**: [contracts/README.md](../contracts/README.md) (architecture, access control, usage examples)
- **Audit commit**: [41b67f10d8a62151e67649d98b92bc2317fa56a8](https://github.com/ensdomains/contracts-v2/commit/41b67f10d8a62151e67649d98b92bc2317fa56a8)

## 2. Architecture

See the [contracts README](../contracts/README.md) for detailed architecture documentation covering:

- Hierarchical registry system and resolution process
- Mutable token ID system (canonical IDs)
- Enhanced Access Control (EAC) with bitmap-based roles
- Migration framework (ENSv1 -> ENSv2)

### External Dependencies

| Dependency                                                                          | Usage                                                                                                                         |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts)    | ERC1155, ERC165, UUPS, access control base                                                                                    |
| [OpenZeppelin Contracts v4](https://github.com/OpenZeppelin/openzeppelin-contracts) | Used by vendored ENSv1 contracts                                                                                              |
| [ENSv1 contracts](https://github.com/ensdomains/ens-contracts)                      | V1 registry, NameWrapper, BaseRegistrar (for migration)                                                                       |
| [ENS metadata service](https://github.com/ensdomains/ens-metadata-service)          | ENS metadata service                                                                                                          |
| [Rhinestone ENS Modules](https://github.com/rhinestone-external/ens-modules)        | Custom HCA (Hierarchical Context Authority) module and cross-chain intent for registration/renewal (**separate audit scope**) |
| [Verifiable Factory](https://github.com/ensdomains/verifiable-factory)              | Deterministic deployment with verification (**in scope**, see below)                                                          |
| [Unruggable Gateways](https://github.com/unruggable-eth/unruggable-gateways)        | CCIP-Read gateway support                                                                                                     |

## 3. Contracts in Scope

### Primary repository: `ensdomains/contracts-v2`

All Solidity source files under `contracts/src/`. To generate the current file listing, run from the `contracts/` directory:

```sh
tree src -P '*.sol' --prune -I '*.t.sol'
```

At current `main` (`ffe4a73`): **61 files, 4,410 code lines** (8,057 raw lines incl. comments + blanks; subject to change until scope is frozen).

LoC differences between each audit interval are measured using `cloc --diff` on `contracts/src/**.sol` (code-only; comments and blanks excluded). `+code` is the canonical sizing metric: `added.code + modified.code`.

### Secondary repository: `ensdomains/verifiable-factory`

- **Repository**: [github.com/ensdomains/verifiable-factory](https://github.com/ensdomains/verifiable-factory)
- **Audit commit**: `c47c0e61ce03b3ab5891a3b743287b54aee9f021`
- **3 files, ~150 lines** (excluding mocks): `VerifiableFactory.sol`, `UUPSProxy.sol`, `IUUPSProxy.sol`

### Out of Scope

- Test files (`contracts/test/`)
- Deployment scripts (`contracts/deploy/`, `contracts/script/`)
- Vendored ENSv1 contracts (`contracts/lib/ens-contracts/`)
- Rhinestone ENS Modules ([separate audit](https://github.com/rhinestone-external/ens-modules))

## 4. Open PRs Pending Merge

## 5. Key Areas of Concern

Areas where the team particularly welcomes auditor scrutiny, listed in recommended reading order:

1. **Enhanced Access Control (EAC)** (`src/access-control/`): Bitmap-based role system underpinning all permission logic. Admin role restrictions, role grant/revoke semantics, resource-scoped vs root-scoped permissions.
2. **PermissionedRegistry** (`src/registry/PermissionedRegistry.sol`): Primary use-case of EAC. Token ownership, admin restrictions, role inheritance on transfer, token ID regeneration on permission changes.
3. **Name transfer safety**: Ensuring ownership state is fully reset on transfer/re-registration, preventing previous owners from retaining access (cf. [CVE-2020-5232](https://github.com/ensdomains/ens/security/advisories/GHSA-8f9f-pc5v-9r5h) in ENSv1).
4. **ETHRegistrar** (`src/registrar/ETHRegistrar.sol`): Use-case of both EAC and PermissionedRegistry. Registration, renewal, commit-reveal, and ERC20 payment flow. Price oracle rounding and minimum payment enforcement.
5. **Migration logic** (`src/migration/`): Locked vs unlocked migration paths from ENSv1, wrapper receiver contracts, edge cases around expired/burned V1 names.
6. **Upgradeability**: UUPS proxy patterns (UserRegistry, PermissionedResolver, UniversalResolverV2).
7. **Universal resolution** (`src/universalResolver/`): Recursive registry traversal, wildcard handling, CCIP-Read integration.
8. **DNS/DNSSEC integration** (`src/dns/`): `DNSTLDResolver` trusts the DNSSEC oracle for proof verification and TXT record parsing; previous ENSv1 DNSSEC padding vulnerability (cf. [GHSA-c6rr-7pmc-73wc](https://github.com/ensdomains/ens-contracts/security/advisories/GHSA-c6rr-7pmc-73wc)).
9. **HCA proxy resolution** (`src/hca/`): `_msgSender()` override via HCA context, equivalence checking across contracts.

## 6. Key Invariants

The following invariants have been verified in the source code:

**Ownership & Access Control:**

- Each ERC1155 token ID has at most one owner (`ERC1155Singleton`)
- Each token resource has at most one admin (the token owner). Admin roles can never be directly granted via external EAC methods — only revoked from oneself, or swapped to a new owner through transfer.
- This grant restriction also applies to the root resource, which means that as long as root permissions do not overlap with token-level permissions, the token owner is the sole controller of their name. See the [Static Deployment Permissions](../contracts/README.md#static-deployment-permissions) table in the contracts README for the exact role assignments per contract, which demonstrates the orthogonal separation between root-level and token-level roles (the ENSv2 equivalent of NameWrapper's `PARENT_CANNOT_CONTROL`).
- Token ID regeneration fully invalidates previous roles via `tokenVersionId` increment (`PermissionedRegistry.sol`)
- On transfer, the new owner receives all admin roles; the previous owner retains none

**Registration & Expiry:**

- A name cannot be registered while it is not expired — reverts with `NameAlreadyRegistered` (`PermissionedRegistry.sol`)
- Renewal cannot shorten a name's expiry — reverts with `CannotReduceExpiration` (`PermissionedRegistry.sol`)
- Commit-reveal: registration requires a commitment aged between `MIN_COMMITMENT_AGE` and `MAX_COMMITMENT_AGE` (`ETHRegistrar.sol`)
- Payment amount cannot round to zero — enforced via ceiling rounding and zero-unit checks (`StandardRentPriceOracle.sol`)

**Migration:**

- A name cannot be migrated twice — `register()` reverts with `NameAlreadyRegistered` on the second attempt

**UUPS Proxies:**

- Only accounts with `ROLE_UPGRADE` on the root resource can upgrade proxy implementations (`UserRegistry.sol`)
- Implementation contracts have initializers disabled via `_disableInitializers()`

### Known Design Decisions

- **Circular subregistries are permitted**: The contracts do not prevent circular parent/subregistry references. Cycle detection is intentionally deferred to the indexer/off-chain layer rather than enforced on-chain. On-chain resolution (`LibResolution.findCanonicalName`) relies on gas limits as a natural bound rather than explicit depth checks.
- **Migration allows V1 owner to specify a different V2 owner**: The `LibMigration.Data` struct includes an `owner` field chosen by the caller. The contracts do not verify that `md.owner` matches the V1 token owner. This is safe because only the V1 owner (or approved operator) can initiate the transfer via `safeTransferFrom`, and specifying a different V2 address is a valid use case (e.g., migrating to a different wallet).

## 7. Trust Assumptions & Privileged Roles

See the [Access Control section](../contracts/README.md#access-control) of the contracts README for full details.

### EAC (Enhanced Access Control) Roles

Bitmap-based roles managed by the EAC system, scoped to specific name resources (token IDs) or the root resource (contract-wide). See the [Access Control section](../contracts/README.md#access-control) of the contracts README for the full role listing and semantics.

Contracts using EAC: `PermissionedRegistry`, `ETHRegistrar`, `BaseUriRegistryMetadata`, `SimpleRegistryMetadata`, `PermissionedResolver`.

### User-Owned Contracts

These contracts are deployed per user and controlled by individual name owners:

- **UserRegistry**: UUPS-upgradeable registry deployed via `VerifiableFactory` for user-owned subdomain management.
- **PermissionedResolver**: Resolver where name owners set their own resolution records. Permissions can be delegated via EAC roles.

### Non-EAC Privileged Roles

These use OpenZeppelin `Ownable` or are implicit trust assumptions outside the EAC system.

- **StandardRentPriceOracle owner** (`Ownable`): Can update base pricing rates, discount points, payment token configurations, and halving parameters.
- **Deployer roles**: The deployer receives specific admin roles per contract during deployment (not all roles). See the [Static Deployment Permissions](../contracts/README.md#static-deployment-permissions) table in the contracts README for the exact role matrix.
- **ETHRegistrar BENEFICIARY** (`immutable`): All registration and renewal payments (ERC20 via `safeTransferFrom`) are sent to this address. Set at construction and cannot be changed.

### Trusted External Contracts

These are external dependencies the system trusts without on-chain verification:

- **ENSv1 contracts**: ENS Registry, NameWrapper, BaseRegistrar -- trusted as data sources during migration. CCIP-Read functionality is provided via ENSv1's `CCIPReader`/`CCIPBatcher`, which transitively depends on [Unruggable Gateways](https://github.com/unruggable-eth/unruggable-gateways).
- **DNSSEC oracle**: `DNSTLDResolver` trusts the ENSv1 DNSSEC oracle (`DNSSEC.verifyRRSet`) for cryptographic proof verification of DNS records. Set as an immutable constructor parameter.
- **HCA Factory** (Rhinestone module): Trusted to correctly resolve proxy accounts to their real owners via `_msgSender()`. Under separate audit at [rhinestone-external/ens-modules](https://github.com/rhinestone-external/ens-modules).

## 8. Build & Test Instructions

See the [Getting Started section](../contracts/README.md#getting-started) of the contracts README.

**Quick start:**

```sh
bun i && cd contracts && forge i
forge build                          # Build contracts
bun run test                         # Run all tests (Forge + Hardhat)
bun run test:forge                   # Forge tests only
bun run test:hardhat                 # Hardhat tests only
```

**Requirements:** Node.js v24+, Foundry v1.3.2+, Bun v1.2+

## 9. Prior Audits & Security Reviews

ENSv2 (this repository) has not been previously audited. The vendored ENSv1 contracts ([ens-contracts](https://github.com/ensdomains/ens-contracts)) have undergone multiple audits:

- [ConsenSys Diligence -- ENS Permanent Registrar (2019)](https://github.com/ConsenSys/ens-audit-report-2019-02)
- [ChainSecurity -- ENS NameWrapper](https://www.chainsecurity.com/security-audit/ethereum-name-service-ens-namewrapper)

Previously disclosed vulnerabilities on ENSv1:

- [GHSA-8f9f-pc5v-9r5h](https://github.com/ensdomains/ens/security/advisories/GHSA-8f9f-pc5v-9r5h) (Jan 2020, Critical): Malicious takeover of previously owned ENS names (CVE-2020-5232)
- [GHSA-rrxv-q8m4-wch3](https://github.com/ensdomains/ens-contracts/security/advisories/GHSA-rrxv-q8m4-wch3) (Aug 2023, Medium): .eth registrar controller can shorten the duration of registered names
- [GHSA-c6rr-7pmc-73wc](https://github.com/ensdomains/ens-contracts/security/advisories/GHSA-c6rr-7pmc-73wc) (Feb 2025, Low): RSA Signature Forgery via Missing PKCS#1 v1.5 Padding Validation in ENS DNSSEC Oracle
