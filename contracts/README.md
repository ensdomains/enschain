# ENSv2 Contracts

Currently this repository hosts Proof-of-Concept contracts for ENSv2. See the [ENSv2 design doc](http://go.ens.xyz/ensv2) for details of the system architecture.

At present the following contracts are implemented:
 - [RegistryDatastore](src/registry/RegistryDatastore.sol) - an implementation of the registry datastore defined in the design doc. All registry contracts must use a singleton instance of the datastore for storage of subregistry and resolver addresses.
 - [ERC1155Singleton](src/registry/ERC1155Singleton.sol) - an implementation of the ERC1155 standard that permits only a single token per token ID. This saves on gas costs for storage while also permitting easy implementation of an `ownerOf` function.
 - [BaseRegistry][src/registry/BaseRegistry.sol] - an implementation of the registry defined in the design doc, to be used as a base class for custom implementations.
 - [RootRegistry](src/registry/RootRegistry.sol) - an implementation of an ENSv2 registry to be used as the root of the name hierarchy. Owned by a single admin account that can authorise others to create and update TLDs. Supports locking TLDs so they cannot be further modified.
 - [ETHRegistry](src/registry/ETHRegistry.sol) - a basic implementation of an ENSv2 .eth registry. Supports locking TLDs and name expirations; when a name is expired, its resolver and subregistry addresses are zeroed out. User registrations and renewals are expected to occur via a controller contract that handles payments etc, just as in ENSv1.
 - [UserRegistry](src/registry/UserRegistry.sol) - a sample implementation of a standardized user registry contract. Supports locking subnames.
 - [UniversalResolver](src/utils/UniversalResolver.sol) - a sample implementation of the ENSv2 resolution algorithm.

The ENSv2 contracts module uses forge + hardhat combined to allow for simple unit testing, e2e tests (incl. CCIP-Read support), performant build forks, etc.

## Foundry (forge) installation

https://book.getfoundry.sh/getting-started/installation

## Getting started

### Installation

Install foundry: [guide](https://book.getfoundry.sh/getting-started/installation)

Install packages (bun)

```sh
bun install
```

### Build

```sh
forge build
```

### Test

Testing is done in both forge and hardhat, so you can use the helper script.

```sh
bun run test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Miscellaneous

Foundry also comes with cast, anvil, and chisel, all of which are useful for local development ([docs](https://book.getfoundry.sh/))
