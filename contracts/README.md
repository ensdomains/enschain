# ENSv2 Contracts

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
