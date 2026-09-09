# ENS Pre-Migration Script

The pre-migration script (`contracts/script/preMigration.ts`) seeds ENS v1 `.eth` second-level (2LD)
registrations into the v2 registry. It reads a CSV export of v1 registrations, verifies each name
on-chain against the v1 `BaseRegistrar`, and reserves or renews it on v2 via the `BatchRegistrar`
contract. Names are written in a **reserved** state (owner `address(0)`) with the v1 expiry preserved
(plus a configurable bonus period) and `ENSV1Resolver` set as the fallback resolver; ownership
transfer happens in a later migration phase.

## Quick start

Run from `contracts/` after `forge build`. Dry-run first (full pipeline, sends nothing), then execute;
resume with `--continue` after any interruption:

```bash
export PREMIGRATION_PRIVATE_KEY=0x...   # BatchRegistrar owner key

# 1. Dry run — parses, verifies, computes expiries, checkpoints; sends no transactions
bun run script/preMigration.ts \
  --rpc-url <url> --registry <addr> --batch-registrar <addr> \
  --v1-resolver <addr> --csv-file ./data/v1-registrations.csv --dry-run

# 2. Execute (drop --dry-run)
bun run script/preMigration.ts \
  --rpc-url <url> --registry <addr> --batch-registrar <addr> \
  --v1-resolver <addr> --csv-file ./data/v1-registrations.csv

# 3. Resume from the last checkpoint after an interruption (same options as before)
bun run script/preMigration.ts --continue \
  --rpc-url <url> --registry <addr> --batch-registrar <addr> \
  --v1-resolver <addr> --csv-file ./data/v1-registrations.csv
```

In the phased migration this script is driven through the operator CLI
(`bun run migration -- premigration run` / `resume`, then `verify`) — see
[migration.md](./migration.md). The reference below documents the underlying script directly.

## Prerequisites

- **Bun** runtime, and forge artifacts compiled (`forge build` in `contracts/`).
- **Deployed contracts:** the v2 `PermissionedRegistry`, `BatchRegistrar` (owned by the signer), and
  `ENSV1Resolver`.
- **Signer key** for the `BatchRegistrar` owner — `--private-key` or the `PREMIGRATION_PRIVATE_KEY`
  env var.
- **RPC endpoint** where both v1 and v2 contracts live (chain ID auto-detected). Optionally a separate
  `--mainnet-rpc-url` for v1 reads (e.g. when v2 runs on a devnet with its own v1 set).
- **CSV file** of v1 registrations (see [CSV input](#csv-input)).

## CLI Reference

Run from `contracts/`:

```bash
bun run script/preMigration.ts [options]
```

> In the phased flow these options map onto the operator-CLI subcommands `premigration run` /
> `resume` / `verify`, which additionally accept the shared
> [common options](./migration.md#common-options) (`--network`, deployment dirs). `premigration
> status` is a separate, local checkpoint read that takes **only** `--work-dir` — it does not touch an
> RPC. Run `bun run migration -- premigration <sub> --help` for the authoritative per-subcommand list.

### Required

| Option | Description |
|---|---|
| `--rpc-url <url>` | RPC endpoint (where v1 + v2 live) |
| `--registry <address>` | v2 `PermissionedRegistry` address |
| `--batch-registrar <address>` | `BatchRegistrar` address |
| `--csv-file <path>` | CSV of v1 registrations |
| `--v1-resolver <address>` | `ENSV1Resolver` address (set as fallback resolver) |

### Optional

| Option | Default | Description |
|---|---|---|
| `--private-key <key>` | `PREMIGRATION_PRIVATE_KEY` | `BatchRegistrar` owner key. Exits if neither is set. |
| `--account <address>` | — | Impersonated/unlocked `BatchRegistrar` owner (forks/devnets). |
| `--mainnet-rpc-url <url>` | `https://eth.drpc.org` | RPC for v1 `BaseRegistrar` expiry reads; point at a devnet when v2 runs locally. |
| `--batch-size <number>` | `50` | Names per on-chain batch. |
| `--start-index <number>` | `-1` | CSV line to start from (set automatically by `--continue`). |
| `--limit <number>` | none | Max names to process. |
| `--dry-run` | `false` | Simulate without sending transactions. |
| `--continue` | `false` | Resume from the last checkpoint. |
| `--bonus-period-days <days>` | `62` | Days added to each name's v1 expiry to compute its v2 expiry. `0` preserves v1 expiries exactly. |
| `--v1-base-registrar <address>` | mainnet `BaseRegistrar` | v1 `BaseRegistrar` for expiry lookups (override for testing). |

> Eligibility is independently gated by v1's hard-coded 90-day grace: a name expired more than 90 days
> ago is past grace and skipped, regardless of `--bonus-period-days`. Choose a bonus period large
> enough that the deepest in-grace name you want migrated does not compute a past v2 expiry (which
> would fail registration).

## CSV input

Parsing is **header-driven**: the first line is the header, the label column is located by name,
everything else is ignored. Two column names are accepted (case-insensitive, trimmed): **`labelName`**
(v1 subgraph schema, preferred) or **`label`** (the `exportTheGraphRegistrations.ts` exporter). Both
work with no flag:

```csv
node,name,labelHash,owner,parentName,parentLabelHash,labelName,registrationDate,expiryDate
,,,,,,vitalik,,
```

```csv
name,label,labelhash,registrant,expiryDate,registrationDate
vitalik.eth,vitalik,0x...,0x...,...,...
```

Quoted fields and `""`-escaped quotes are handled; a UTF-8 BOM, a single trailing blank line, and CRLF
endings are tolerated.

**Strict structural parsing.** Any structural problem aborts the run with the CSV path and 1-based
line number (header = line 1); fix the file and re-run. Aborts on: missing both `labelName` and
`label` columns; unbalanced quotes (header or row); a data row whose column count differs from the
header; an empty/whitespace-only label cell; a blank line anywhere but a single trailing one; an empty
file.

**Application-level filtering** happens *after* structural parsing and does **not** abort: labels
longer than 255 bytes and the bracketed-labelhash form (`[0x…]`) are skipped and counted as
`invalidLabelCount`.

> **Limitation:** `readline` splits on `\n`, so a field containing a literal newline inside quotes is
> misread. No exporter we control produces these; pre-process the file if you have one.

## How it works

Names stream from the CSV in batches of `--batch-size`. Each batch is verified with a single multicall
(two RPC calls regardless of size) reading v2 state (`PermissionedRegistry.getState()`) and v1 expiry
(`BaseRegistrar.nameExpires()`), then submitted as one `BatchRegistrar.batchRegister()` transaction.
Per-name action:

| v2 status | v1 status | Action |
|---|---|---|
| Available (0) | Registered, or expired but within v1's 90-day grace | **Reserve** with expiry `v1Expiry + bonusPeriodDays` |
| Reserved (1) | Computed expiry longer than the stored one | **Renew** (extend expiry) |
| Reserved (1) | Computed expiry equal to or shorter than the stored one | **Skip** (up to date) |
| Registered (2) | Any | **Fail** (already fully owned on v2) |
| Any | Never registered, or past v1's 90-day grace | **Skip** (v1 owner lost the claim) |

Reserved names are written with owner/registry `address(0)`, resolver = `ENSV1Resolver`, roleBitmap
`0`, and the computed expiry.

A reservation is only ever extended, never shortened: `BatchRegistrar` renews when the requested
expiry is greater than the stored one and does nothing otherwise. Names that would be a no-op are left
out of the batch and counted separately, so the final sync sends only what has actually changed rather
than resubmitting the whole CSV.

> **When can a name be `Registered (2)`?** Not during the migration phases. Migration opens to users
> only after the final pre-migration sync completes, so a name owned on v2 while pre-migration is
> still running did not get there by being claimed. It is reported and counted, and does not fail the
> run, but it is worth understanding before continuing.

**One name cannot stop the run.** Every per-name failure mode is handled explicitly, but an
unforeseen one — a value that overflows a conversion, a malformed record — is caught, counted as a
failure, and skipped, so the rest of its batch is still reserved. Real chain data contains names with
deliberately maximal expiries (near `uint64` max), which is exactly the kind of value that used to
abort a whole run from a log line. Bonus-adjusted expiries are capped at `uint64` so they cannot wrap.

A whole batch failing is treated differently, because none of its names were written: the run stops
there so the checkpoint still points **before** those rows. Carrying on would advance the resume
cursor past names that were never reserved, and `--continue` would then skip them permanently. Re-run
with `--continue` once the cause is fixed.

**Gas safety.** Before submitting, the script estimates gas; if it exceeds 80% of the block limit the
batch is split in half and re-estimated (recursively). If a batch reverts at execution, it is
recursively halved and retried (binary search) until failing names are isolated — preserving partial
progress. A checkpoint is saved after each batch.

## Checkpoint & resume

A checkpoint (`preMigration-checkpoint.json`) is written after each batch, tracking the last processed
line and accumulated counters (reserved, renewed, skipped, invalid, failed). `--continue` loads it,
sets `--start-index` to the last processed line, and resumes; counters accumulate across runs. See the
resume command in [Quick start](#quick-start).

## Dry run

`--dry-run` runs the full pipeline — CSV parse, v1/v2 verification, expiry computation, checkpointing
— and logs what would happen, but sends no transactions. It is the default first step in
[Quick start](#quick-start).

## Output

Informational output goes to `preMigration.log` and errors to `preMigration-errors.log`; the console
mirrors progress with a final summary table (processed / reserved / renewed / skipped / already
registered / already up to date / invalid / failed / success rate). Individual failures (name reverts,
RPC timeouts at a 30s per-call limit, checkpoint write errors) are counted and logged without aborting
the batch, so partial progress is preserved.

**A failed name is retried, not stepped over.** The checkpoint stops before the first failure, so
`--continue` reaches that name again rather than resuming past it. Names that succeeded after it are
re-read and skipped as already up to date, so the retry is cheap. A whole batch failing stops the run
for the same reason: none of its names were written, and the cursor must stay before them.

**A run that ends with failures exits non-zero.** A name that reverted was never written to v2, so
reporting the run as a success would hand back a green result over an incomplete reservation set.
Re-run with `--continue` after fixing the cause. The "already registered" and "already up to date"
counters are not failures — nothing was lost in either case — and do not affect the exit status.

## Testing on a Sepolia fork

To rehearse pre-migration against real Sepolia v1 state without a full `fork full` run, deploy the v2
stack onto a local Anvil fork (v2 is not on real Sepolia) and run pre-migration against it.

> **Account requirement:** the deployer/owner must be an address with **no code** on Sepolia. The
> standard Anvil test accounts carry an EIP-7702 delegation there, so their `onERC1155Received` does
> not return the ERC-1155 acceptance value and the `eth` 2LD mint during deploy reverts. Use a fresh
> throwaway key funded via `anvil_setBalance`.

```bash
# 1. Fork Sepolia
anvil --fork-url "$SEPOLIA_RPC_URL" --port 8547 --chain-id 11155111 &

# 2. Fresh deployer with no Sepolia code, funded on the fork
KEY=<fresh 0x… key>; ADDR=$(cast wallet address --private-key "$KEY")
cast rpc anvil_setBalance "$ADDR" 0x21e19e0c9bab2400000 --rpc-url http://127.0.0.1:8547

# 3. Deploy v2 onto the fork (impersonate the v1 owner for the .eth resolver write)
DEPLOYER_KEY=$KEY OWNER_KEY=$KEY UR_MANAGER_KEY=$KEY \
  bun run migration -- phase deploy-v2 --network sepolia --rpc-url http://127.0.0.1:8547 \
    --deployer "$ADDR" --owner "$ADDR" --ur-manager "$ADDR" --impersonate-v1-owner \
    --save-deployments --deployments-dir /tmp/fork-deployments --deployment-network sepolia

# 4. Run + verify (addresses read from the deployment JSON; v1 reads use the same fork RPC)
bun run migration -- premigration run --network sepolia --rpc-url http://127.0.0.1:8547 \
  --deployments-dir /tmp/fork-deployments --deployment-network sepolia \
  --csv-file ./csv-data/ens-registrations-sepolia.csv --private-key "$KEY"
bun run migration -- premigration verify --network sepolia --rpc-url http://127.0.0.1:8547 \
  --deployments-dir /tmp/fork-deployments --deployment-network sepolia \
  --csv-file ./csv-data/ens-registrations-sepolia.csv
```

For the full phased rehearsal instead, see the `fork full` command in
[migration.md](./migration.md#rehearsals).
