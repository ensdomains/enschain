![Build status](https://github.com/ensdomains/contracts-v2/actions/workflows/main.yml/badge.svg?branch=main)
[![codecov](https://codecov.io/github/ensdomains/contracts-v2/graph/badge.svg?branch=main)](https://codecov.io/github/ensdomains/contracts-v2)

# ENSv2 Contracts

This repository hosts the smart contracts for ENSv2 (Ethereum Name Service version 2), a next-generation naming system designed for scalability and cross-chain functionality. For comprehensive architectural details, see the [ENSv2 design doc](http://go.ens.xyz/ensv2).

## Overview

ENSv2 transitions from a flat registry to a hierarchical system that enables:

- **Flexible Ownership**: Custom registry implementations for different ownership models
- **Backward Compatibility**: Unmigrated ENSv1 names continue to function
- **Gas Efficiency**: Optimized storage and access control patterns

### Key Features

1. **Hierarchical Registries**: Each name has its own registry contract managing its subdomains
2. **Canonical ID System**: Canonical internal token ID enables for external token ID to be changed but still map to the same internal data
3. **Role-Based Access Control**: Gas-efficient access control supporting up to 32 roles
4. **Universal Resolver**: Single entry point for all name resolution
5. **Migration Framework**: Transition path from ENSv1 to ENSv2

## Architecture

### Core Concepts

**Registries**

- Each registry is responsible for one name and its direct subdomains
- Registries implement ERC1155, treating subdomains as NFTs
- Must implement the `IRegistry` interface for standard resolution
- Each registry stores its own data directly via an internal `_entries` mapping

**Root Registry** → **TLD Registries** (.eth, .box, etc.) → **Domain Registries** (example.eth) → **Subdomain Registries** (sub.example.eth)

**Resolution Process**

1. Start at root registry
2. Recursively traverse to find the deepest registry with a resolver set
3. Query that resolver for the requested record
4. Supports wildcard resolution (parent resolver handles subdomains)

### Mutable Token ID System

Token IDs representing names get regenerated in the following scenarios:

- **When an expired name is re-registered** - re-generating the token id resets the roles previously assigned against the name, ensuring that the new owner can know that only the roles they assign from then onwards are valid.

- **When the roles on a name are changed** - regenerating the token id in this case prevents griefing attacks - e.g a name is put up for sale on an NFT marketplace by an owner who then changes the permissions on it without a prospective buying knowing.

The system accomplishes this through the concept of a _canonical id_ which is the internal representation of a given name's current token id:

`canonicalId = tokenId ^ uint32(tokenId)`

The canonical id is used internally for:

- Checking role-based permissions for the name.
- Reading/writing storage data - expiry date, registry address, resolver address, etc.

### Access Control

ENSv2 uses **EnhancedAccessControl (EAC)**, a general-purpose access control base class. Compared to OpenZeppelin's roles modifier, EAC adds two key features:

1. **Resource-scoped permissions** - Roles are assigned to specific resources (e.g., individual names) rather than contract-wide.
2. **Paired admin roles** - Each base role has exactly one corresponding admin role (and vice-versa).

#### How EAC Works

Roles are assigned for a given `address` against a given resource (a `uint256` id that can represent anything).

Note that there is a special resource `0` (also known internally as `ROOT_RESOURCE`). This functions as a contract-level resource, i.e. roles assigned against this resource are considered to be at "root-level" and are thus automatically applicable to all other resources. For example, if the `ROLE_SET_RESOLVER` role is assigned for a user at the root level of a given registry contract then that user can set the resolver for any and all names within the registry.

Technical details:

- Each role is represented by a 4-bit "nybble" within a `uint256` bitmap. Given that each role has a corresponding admin role this means there are a **maximum of 32 roles** and 32 corresponding admin roles.

- Normal roles are stored in the lower 128 bits of the `uint256` role bitmap. The corresponding admin roles are stored in the upper 128 bits. For a given role its admin role is found by calculating `role << 128`.

- For a given resource, a **maximum of 15 assignees** can have a given role in that resource.

- Assigning a role via the external methods (`grantRole`, `revokeRole`, etc) requires the caller to hold the corresponding admin role for that role.

- Admin roles cannot be assigned to someone else via the external EAC methods. This means admin roles can only be granted via internal logic in derived contracts.

- Admin roles can, however, be revoked from oneself.

**Permission Inheritance**: When checking permissions for a resource, EAC combines (via bitwise OR) the roles from:

- The specific resource (e.g., your name's permissions)
- The root resource (root-level permissions)

#### EAC in Registry Contracts

In registry contracts, EAC is used with these specific behaviors:

**Resource ID Generation**: Resource IDs the canonical token ids (see above).

**Registry-Specific Roles**: From [`RegistryRolesLib.sol`](src/registry/libraries/RegistryRolesLib.sol):

| Role                      | Bit  | Admin Bit | Scope         | Description                                                            |
| ------------------------- | ---- | --------- | ------------- | ---------------------------------------------------------------------- |
| `ROLE_REGISTRAR`          | 0    | 128       | Root-only     | Register and reserve new names                                         |
| `ROLE_REGISTER_RESERVED`  | 4    | 132       | Root-only     | Promote reserved name to registered                                    |
| `ROLE_SET_PARENT`         | 8    | 136       | Root-only     | Set parent registry                                                    |
| `ROLE_UNREGISTER`         | 12   | 140       | Root or token | Unregister names                                                       |
| `ROLE_RENEW`              | 16   | 144       | Root or token | Extend name expiry                                                     |
| `ROLE_SET_SUBREGISTRY`    | 20   | 148       | Root or token | Change child registry                                                  |
| `ROLE_SET_RESOLVER`       | 24   | 152       | Root or token | Change resolver address                                                |
| `ROLE_CAN_TRANSFER_ADMIN` | 28\* | 156       | Root or token | Admin-only. Auto-granted to name owner. Revoke to make soulbound.      |
| `ROLE_CAN_NAME`           | 120  | 248       | Root-only     | Name contract                                                          |
| `ROLE_UPGRADE`            | 124  | 252       | Root-only     | UUPS proxy upgrades. WrapperRegistry targets must also be DAO-approved |

\*`ROLE_CAN_TRANSFER_ADMIN` has no base role; it is admin-only (upper 128 bits).

**Note**: Root-only roles have no resource-specific equivalent (e.g. `ROLE_REGISTRAR` — the resource doesn't exist until the name is created).

**Admin Role Capabilities**

- In registries, **only the name owner can hold admin roles**
- **Why this restriction?** To prevent granting admin rights to another account and retaining control after a transfer. While theoretically secure (auditable), this was judged too risky.
- Admin roles can be revoked from oneself. The `ROLE_CAN_TRANSFER_ADMIN` role is one such example - this role is automatically granted to the owner of a name when the name is registered. Revoking this admin role will essentially make the name soulbound and un-transferrable.

**Transfer Behavior**

- When you transfer a name, **all roles and admin roles** transfer to the new owner
- Existing **roles** delegated to other accounts remain intact unless explicitly revoked
- Example: If Alice granted Bob `ROLE_SET_RESOLVER` and transfers the name to Charlie, Charlie becomes the new admin but Bob keeps his resolver permission

#### Static Deployment Permissions

Roles granted during core deployment.

| Contract        | Scope    | Target                        | REGISTRAR | REGISTER_RESERVED | SET_PARENT | UNREGISTER | RENEW | SET_SUBREGISTRY | SET_RESOLVER | CAN_TRANSFER_ADMIN | CAN_NAME | UPGRADE |
| --------------- | -------- | ----------------------------- | --------- | ----------------- | ---------- | ---------- | ----- | --------------- | ------------ | ------------------ | -------- | ------- |
| RootRegistry    | Root     | Deployer                      | AR        | AR                | AR         |            | AR    |                 |              |                    | AR       |         |
| RootRegistry    | .eth     | Deployer                      |           |                   |            |            |       |                 | AR           | AR                 |          |         |
| RootRegistry    | .reverse | Deployer                      |           |                   |            | AR         | AR    | AR              | AR           | AR                 |          |         |
| ETHRegistry     | Root     | Deployer                      | A         | A                 | AR         |            | A     |                 |              |                    | AR       |         |
| ETHRegistry     | Root     | `ETHRegistrar`                | R         |                   |            |            | R     |                 |              |                    |          |         |
| ETHRegistry     | Root     | `BatchRegistrar`              | R         |                   |            |            | R     |                 |              |                    |          |         |
| ETHRegistry     | Root     | `UnlockedMigrationController` |           | R                 |            |            |       |                 |              |                    |          |         |
| ETHRegistry     | Root     | `LockedMigrationController`   |           | R                 |            |            |       |                 |              |                    |          |         |
| ReverseRegistry | Root     | Deployer                      | AR        | AR                | AR         | AR         | AR    | AR              | AR           | AR                 | AR       | AR      |

Legend: A = admin only, R = regular only, AR = admin and regular

_`ETHRegistrar` and `ETHRenewerV1` use `Ownable`, not `EnhancedAccessControl`. Implementation contracts (`PermissionedResolverImpl`, `UserRegistryImpl`, `WrapperRegistryImpl`) grant `ROLE_CAN_NAME | ROLE_CAN_NAME_ADMIN` roles at deployment; proxies receive roles via `initialize()` when created._

_Under the phased migration deploy (the `deferV2Registrar` tag, always set by `phase deploy-v2` — see [docs/migration.md](docs/migration.md#phase-1-deploy-v2-contracts)), the `ETHRegistrar` grant of `REGISTRAR | RENEW` is skipped at deploy time and instead performed in [phase 6](docs/migration.md#phase-6-enable-the-v2-controller)._

_The token for `eth` is registered to the deployer; `reverse` and `addr.reverse` are reserved._

#### Creating Emancipated Names

You can create the equivalent of Name Wrapper "emancipated" names by:

1. Creating a subregistry where the owner has no root roles
2. Locking the subregistry into the parent registry
3. Result: Parent registry owner cannot interfere with subname operations

#### Usage Examples

```solidity
import {RegistryRolesLib} from "./libraries/RegistryRolesLib.sol";

// Scenario: Delegate resolver management without transfer rights
(uint256 tokenId, ) = registry.getNameData("example");

// Grant only resolver permissions
registry.grantRoles(
    tokenId,
    RegistryRolesLib.ROLE_SET_RESOLVER,
    resolverManager
);

// Grant multiple roles at once
uint256 operatorRoles = RegistryRolesLib.ROLE_SET_RESOLVER |
                        RegistryRolesLib.ROLE_SET_SUBREGISTRY;
registry.grantRoles(tokenId, operatorRoles, operator);

// Grant a role at the registry root (applies to every name; requires the root admin role)
registry.grantRootRoles(RegistryRolesLib.ROLE_SET_RESOLVER, admin);

// Check if user has required permissions
bool canSetResolver = registry.hasRoles(
    tokenId,
    RegistryRolesLib.ROLE_SET_RESOLVER,
    user
);

// Admin can grant roles to others
registry.grantRoles(
    tokenId,
    RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN,
    admin
);
```

## Contract Documentation

### Registry System

#### `IRegistry` - Core Interface

[src/registry/interfaces/IRegistry.sol](src/registry/interfaces/IRegistry.sol)

Standard interface all registries must implement:

```solidity
interface IRegistry is IERC1155Singleton {
  event NameRegistered(
    uint256 indexed tokenId,
    bytes32 indexed labelHash,
    string label,
    address owner,
    uint64 expiry,
    address indexed sender
  );
  event NameReserved(
    uint256 indexed tokenId,
    bytes32 indexed labelHash,
    string label,
    uint64 expiry,
    address indexed sender
  );
  event NameUnregistered(uint256 indexed tokenId, address indexed sender);
  event ExpiryUpdated(
    uint256 indexed tokenId,
    uint64 newExpiry,
    address indexed sender
  );
  event SubregistryUpdated(
    uint256 indexed tokenId,
    IRegistry subregistry,
    address indexed sender
  );
  event ResolverUpdated(
    uint256 indexed tokenId,
    address resolver,
    address indexed sender
  );
  event TokenRegenerated(
    uint256 indexed oldTokenId,
    uint256 indexed newTokenId
  );

  function getSubregistry(
    string calldata label
  ) external view returns (IRegistry);
  function getResolver(string calldata label) external view returns (address);
}
```

#### `PermissionedRegistry` - Standard Implementation

[src/registry/PermissionedRegistry.sol](src/registry/PermissionedRegistry.sol)

Feature-complete registry with role-based access control:

- ERC1155 NFT for subdomains
- Enhanced Access Control with 32 roles
- Expiry management
- Metadata support (name, description, image)
- Direct internal storage via `_entries` mapping

**Key Functions**:

- `getEntry(uint256 anyId)`: Fetch an entry by labelhash, token ID, or resource
- `getNameData(string label)`: Fetch token ID and entry for a label
- `setSubregistry(uint256 anyId, IRegistry registry)`: Update subregistry
- `setResolver(uint256 anyId, address resolver)`: Update resolver

**Storage Structure** (defined in `IPermissionedRegistry`):

```solidity
struct Entry {
  uint32 eacVersionId; // Version counter for access control changes (incremented on permission updates)
  uint32 tokenVersionId; // Version counter for token regeneration (incremented on burn/remint)
  IRegistry subregistry; // Registry contract for subdomains under this name
  uint64 expiry; // Timestamp when the name expires (0 = never expires)
  address resolver; // Resolver contract for name resolution data
}
```

#### `ERC1155Singleton` - Gas-Optimized NFT

[src/erc1155/ERC1155Singleton.sol](src/erc1155/ERC1155Singleton.sol)

Modified ERC1155 allowing only one token per ID:

- Saves gas by omitting balance tracking
- Provides `ownerOf(uint256 id)` like ERC721
- Emits transfer events for indexing

### Core Components

#### Migration Controllers

[src/migration/](src/migration/)

- `LockedMigrationController`: Handles ENSv1 → ENSv2 migration for locked names
- `UnlockedMigrationController`: Handles ENSv1 → ENSv2 migration for unlocked names

Scripts for running the migration end-to-end:

- [Phased migration](docs/migration.md) — the phase-by-phase workflow that runs the v1 → v2 cutover: phase definitions, the `bun run migration` operator CLI, the Hardhat `migration` tasks, and the fork/clean-testnet rehearsals.
- [Pre-migration](docs/premigration.md) — seed v1 registrations into the v2 registry as _reserved_ entries, via `BatchRegistrar`.
- [Prepare migration](docs/prepareMigration.md) — swap registry roles from `BatchRegistrar` to `ETHRegistrar` and the two migration controllers once pre-migration is complete.
- [Universal Resolver structure](docs/universalResolver.md) — the proxy chain used to cut universal resolution over from v1 to v2, and the phased deploy scripts that manage it.

### Resolution

#### `UniversalResolverV2` - One-Stop Resolution

[src/universalResolver/UniversalResolverV2.sol](src/universalResolver/UniversalResolverV2.sol)

Single contract for resolving any ENS name:

- Handles recursive registry traversal
- Supports CCIP-Read for off-chain resolution
- Wildcard resolution
- Batch resolution

On live networks, clients reach it through a chain of upgradable proxies that manages the v1 → v2 cutover — see [Universal Resolver structure](docs/universalResolver.md).

**Example**:

```solidity
// Resolve address
(bytes memory result, address resolver) = universalResolver.resolve(
    dnsEncodedName,
    abi.encodeWithSelector(IAddrResolver.addr.selector, node)
);
address resolved = abi.decode(result, (address));
```

## Deployed Addresses

Generated contract address tables, regenerated automatically at the end of `phase deploy-v2` (or on demand with `bun run docs:addresses`):

- [Sepolia](docs/addresses/sepolia.md)
- [Mainnet](docs/addresses/mainnet.md)

## Getting started

### Installation

1. Install [Node.js](https://nodejs.org/) v24+
2. Install foundry: [guide](https://book.getfoundry.sh/getting-started/installation) v1.3.2+
3. Install [bun](https://bun.sh/) v1.2+
4. Install dependencies:
5. (OPTIONAL) Install [lcov](https://github.com/linux-test-project/lcov) if you want to run coverage tests
   - Mac: `brew install lcov`
   - Ubuntu: `sudo apt-get install lcov`

```sh
bun i
cd contracts
forge i
```

### Build

```sh
forge build
bun run compile:hardhat
```

### Test

Prior to running tests ensure you compile `lib/ens-contracts`:

```sh
cd lib/ens-contracts
bun run compile
```

Testing is done using both Foundry and Hardhat.
Run all test suites:

```sh
bun run test         # ALL tests
```

Or run specific test suites:

```sh
bun run test:hardhat  # Run Hardhat tests
bun run test:forge    # Run Forge tests
bun run test:hardhat test/Ens.t.ts # specific Hardhat test
bun run test:e2e # end-to-end tests
```

## Running the Devnet

There are two ways to run the devnet:

### Native Local Devnet (recommended)

Start a local devnet:

```sh
bun run devnet        # runs w/last build
```

This starts a local chain at http://localhost:8545 (Chain ID: 31337). The live
deployment manifest is available at http://localhost:8000/deployments.

To populate the devnet with test names (registrations, subnames, aliases, renewals, etc.):

```sh
bun run devnet --testNames
```

This runs `testNames()` which creates 17 names in various states. For details on the test data and the events emitted, see:

- [Indexing Test Names](../docs/indexing-test-names.md) — what each test name does and which events it emits
- [Indexing ENSv2 Events](../docs/indexing-ensv2-events.md) — full reference of all ENSv2 contract events

### Mainnet Fork Mode

Instead of a synthetic chain, the devnet can fork mainnet so that real ENS v1 names are present. Enable it by pointing at a mainnet RPC (these are also what [morticia](https://github.com/ensdomains/morticia)'s e2e runner uses):

```sh
FORK_URL=<mainnet-rpc> bun run devnet         # or --forkUrl <mainnet-rpc>
FORK_URL=<mainnet-rpc> FORK_BLOCK=<block> bun run devnet   # pin the fork block (or --forkBlock)
```

On a fork you can also **pre-migrate** a curated set of real names — reserving them on the v2 registry (RESERVED state, `ENSV1Resolver` fallback) once the devnet is up, mirroring the DAO's pre-migration so the frontend can drive the v1 → v2 migrate flow:

```sh
FORK_URL=<mainnet-rpc> bun run devnet --preMigrate
```

Optionally reassign v1 ownership of the pre-migrated names to a devnet account (`deployer`/`owner`/`user`/`user2`, or a raw address) so a fixed test wallet owns them and can migrate in-app without impersonation:

```sh
FORK_URL=<mainnet-rpc> bun run devnet --preMigrate --preMigrateOwner user
```

Both flags have env-var equivalents (`DEVNET_PREMIGRATE=1`, `DEVNET_PREMIGRATE_OWNER=<account|address>`). `--preMigrate` requires a fork.

The ten names cover every migration state (unwrapped, wrapped-locked, wrapped-unlocked):

| Name                 | State                            | Notes                                                            |
| -------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `swissborg.eth`      | unwrapped                        | normal happy-path name                                           |
| `00relayer.eth`      | unwrapped                        | leading-zero label, small subtree                                |
| `2718.eth`           | unwrapped                        | all-numeric label, multiple subnames                             |
| `$beep.eth`          | wrapped-locked                   | special `$` char, minimal subtree                                |
| `agi.eth`            | wrapped-locked                   | carries a locked child + a third-party child                     |
| `ethscriptions.eth`  | wrapped-locked                   | burn-address owner, emancipated child                            |
| `holer.eth`          | wrapped-**unlocked**/emancipated | no `CANNOT_UNWRAP`                                               |
| `analyzes.eth`       | wrapped-locked                   | shared batch owner                                               |
| `daomarketplace.eth` | wrapped-locked                   | shared batch owner                                               |
| `alertbot.eth`       | wrapped-locked                   | `CANNOT_TRANSFER` — stays reserve-only under `--preMigrateOwner` |

> The list is curated from [morticia](https://github.com/ensdomains/morticia)'s mainnet-fork e2e scenarios, whose states hold near mainnet block `25120743` (~2026-05). Every name's live state is read from the fork at runtime, so reservation stays correct at any block; a name no longer claimable on v1 is skipped with a log. For the documented locked/unlocked mix, fork near that block.

### Using Docker Compose

Make sure Docker and Docker Compose are installed, then start the devnet and
mockestrator transport from the repository root:

```sh
docker compose --profile default up -d --build mockestrator
```

Targeting `mockestrator` starts the devnet dependency without starting the
unrelated bundler and paymaster services in the default profile.

The devnet is available at http://localhost:8545, deployment metadata at
http://localhost:8000/deployments, and mockestrator at http://localhost:3007.

Mockestrator is a frontend transport mock. It does not replace the SDK's HCA
adapter or prove the account's authorization policy. For the current frontend
boundary, see
[HCA](../docs/HCA.md).

To view logs:

```bash
docker compose logs -f devnet mockestrator
```

To stop the devnet:

```bash
docker compose down
```

## Miscellaneous

Foundry also comes with cast, anvil, and chisel, all of which are useful for local development ([docs](https://book.getfoundry.sh/))

### Format

```shell
forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```
