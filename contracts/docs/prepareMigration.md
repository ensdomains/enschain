# ENS Prepare-Migration Script

## Overview

The prepare-migration script (`contracts/script/migrations/prepareMigration.ts`) flips the `.eth` `PermissionedRegistry` from its **seeding** configuration (only `BatchRegistrar` can register) to its **live** configuration (`ETHRegistrar` handles new registrations and renewals; the two migration controllers promote reserved names to registered as ENSv1 owners migrate in). `BatchRegistrar` is fully decommissioned. Run it once, after all pre-migration seeding via [`preMigration.ts`](./premigration.md) has completed and before opening registration to users. It is idempotent: re-running against an already-live registry simply re-issues the same grants/revokes.

> **The phased flow supersedes this.** In the phased v1 → v2 migration ([migration.md](./migration.md)) the same hand-off happens in [phase 6](./migration.md#phase-6-enable-the-v2-controller) — `phase disable-batch-registrar` revokes the `BatchRegistrar` roles and `phase enable-v2-registrar` grants `REGISTRAR | RENEW` to `ETHRegistrar`, while the migration controllers receive `ROLE_REGISTER_RESERVED` already at deploy time. This script remains the path for non-phased, all-at-once deployments (e.g. devnets deployed outside the phased flow).

## Role changes

Four root-level role operations on the target registry. For the roles themselves and the EAC admin/base pairing, see the [EAC section of the contracts README](../README.md#access-control).

| Target | Op | Roles | Expected prior state |
|---|---|---|---|
| `BatchRegistrar` | **REVOKE** | `ROLE_REGISTRAR` · `ROLE_REGISTER_RESERVED` · `ROLE_RENEW` (+ their admin bits) | Holds `ROLE_REGISTRAR \| ROLE_RENEW`. The admin bits and `ROLE_REGISTER_RESERVED` are revoked defensively so the post-state is unambiguously "no roles"; they are no-ops on a canonical deploy. |
| `ETHRegistrar` | **GRANT** | `ROLE_REGISTRAR` · `ROLE_RENEW` | None of the granted bits. |
| `UnlockedMigrationController` | **GRANT** | `ROLE_REGISTER_RESERVED` | None of the granted bit. |
| `LockedMigrationController` | **GRANT** | `ROLE_REGISTER_RESERVED` | None of the granted bit. |

> **Devnet note.** The canonical deploy scripts (`deploy/03_ETHRegistrar.ts`, `deploy/02_UnlockedMigrationController.ts`, `deploy/04_LockedMigrationController.ts`) pre-grant these roles for local convenience — except `deploy/03_ETHRegistrar.ts` skips the `ETHRegistrar` grant when the `deferV2Registrar` tag is set (the phased deploy always sets it; the grant is deferred to phase 6). So against a fresh devnet deployed *without* `deferV2Registrar`, every GRANT is already satisfied and only the `BatchRegistrar` revoke changes state. The fixture `revertPrePrepareMigrationRoles` in `test/utils/mockPrepareMigration.ts` undoes the pre-grants so the grant paths can be exercised in e2e tests.

## CLI Reference

Run from `contracts/`:

```bash
bun run script/migrations/prepareMigration.ts [options]
```

| Option | Required | Description |
|---|---|---|
| `--rpc-url <url>` | yes | JSON-RPC endpoint for the target chain (chain ID auto-detected) |
| `--registry <address>` | yes | `.eth` `PermissionedRegistry` address |
| `--batch-registrar <address>` | yes | `BatchRegistrar` (roles revoked) |
| `--eth-registrar <address>` | yes | `ETHRegistrar` (receives `ROLE_REGISTRAR \| ROLE_RENEW`) |
| `--unlocked-migration-controller <address>` | yes | receives `ROLE_REGISTER_RESERVED` |
| `--locked-migration-controller <address>` | yes | receives `ROLE_REGISTER_RESERVED` |
| `--private-key <hex>` | for `--execute` | Signer key. When supplied in dry-run, enables the admin-role pre-flight check. |
| `--execute` | — | Broadcast transactions. Without it the script is a dry run and sends nothing. |

The signer must hold the admin counterparts of every role being moved (`ROLE_REGISTRAR_ADMIN`, `ROLE_REGISTER_RESERVED_ADMIN`, `ROLE_RENEW_ADMIN`) at the registry root. Forge artifacts must be compiled (`forge build`) — the script loads the `PermissionedRegistry` ABI from `contracts/out/`.

## Dry run vs. execute

Dry run is the default: it previews each planned op next to the current on-chain role bitmap for every target, and (when a signer is supplied) runs the admin-role pre-flight and aborts if any admin bit is missing — no transactions are sent.

`--execute` (with `--private-key`) broadcasts the grants/revokes sequentially, one per op, then re-reads and prints the final role state. An interruption leaves a partially-applied state; re-running is safe.

```bash
# Dry run (add --private-key to also run the admin pre-flight)
bun run script/migrations/prepareMigration.ts \
  --rpc-url <url> --registry <addr> --batch-registrar <addr> \
  --eth-registrar <addr> --unlocked-migration-controller <addr> \
  --locked-migration-controller <addr>

# Execute
bun run script/migrations/prepareMigration.ts <same addresses> --private-key <hex> --execute
```
