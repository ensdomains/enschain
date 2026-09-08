# Phased v1 → v2 Migration

The v1 → v2 migration runs as seven explicit phases, driven by the `bun run migration` operator CLI
from `contracts/`. Phases run **strictly in order**.

## Start here

Rehearse before running anything for real. One command runs all seven phases against a throwaway
local Anvil fork of the network, impersonating every signer, with smoke checks interleaved — nothing
touches a real chain:

```bash
cd contracts
bun run compile
bun run migration -- fork full --network sepolia --csv-file ./csv-data/ens-registrations-sepolia.csv
```

Then pick your deployment context; it determines which phases apply:

- **Live public network (sepolia/mainnet)** — v1 already exists on-chain; run phases **1–7** with real
  signer keys. On mainnet the owner, URP admin, and v1 owner are the DAO/multisig, so owner-gated
  phases run with `--calldata-only` (or deferred) and execute through a Safe. → [Live deployment
  (Sepolia)](#live-deployment-sepolia).
- **Clean testnet (fresh v1)** — no usable v1; deploy a fresh v1 stack first (**phase 0**), then
  phases 1–7, always including `TestnetV1PremigrationRegistrar`. Sepolia only.
  → [`clean-testnet`](#clean-testnet).
- **Fork / Tenderly rehearsal** — dry-run phases 1–7 against a fork of the target network. Local Anvil
  via [`fork full`](#fork-full) as above; a live fork (real v1 state) via a
  [Tenderly virtual testnet](#tenderly-virtual-testnets).

Two things cut across every path:

- **Phase 7 splits by network.** **Sepolia is a reuse network** — the top proxy already fronts the
  intermediate one, so `switch-urp-to-managed` is skipped. **Mainnet and fresh chains are bootstrap**
  — run `switch-urp-to-managed` first. See
  [Phase 7](#phase-7-switch-the-universal-resolver-to-v2).
- **Already migrated once?** Extra steps apply and no phase may be skipped — read
  [Re-deploying onto an already-migrated network](#re-deploying-onto-an-already-migrated-network)
  before you start.

## Phases

Phase numbering matches the console output of the `fork full` orchestrator in
[`script/migration.ts`](../script/migration.ts). Every command below also takes the shared
[common options](#common-options) (`--network`, `--rpc-url`, deployment dirs); run any command with
`--help` for its authoritative option list.

| Phase | Action | Command(s) | Applies to | Signer |
| --- | --- | --- | --- | --- |
| 0 | Deploy fresh v1 contracts | part of `clean-testnet` | clean-testnet only | `deployer` |
| 1 | Deploy all v2 contracts, including reverse-registrar adapters and the HCA stack on HCA-enabled networks (registrar deferred) | `phase deploy-v2` | live + clean-testnet | `deployer` / `owner` / `urManager` (+ v1 owner) |
| F1 | *(optional)* Seed the ENSv1 test fixture corpus, then check the shaped v1 state | `fixture seed-v1` → `verify-v1` | live + clean-testnet | fixture operator + actors (+ v1 owner) |
| 2 | Seed v1 names as reserved on v2 | `premigration run` → `build-index` → `reconcile` | live + clean-testnet | BatchRegistrar owner |
| 3 | Freeze v1 registrations | `phase disable-v1-registrars` (+ `verify-*`) | live + clean-testnet | v1 owner |
| 4 | Keep unmigrated names renewable, and lock down v1 | `authorize-v1-renewer` → `activate-v1-handoff-controllers` → `activate-v1-renewer` (+ `verify-*`) | live + clean-testnet | v1 owner |
| 5 | Final pre-migration sync | `premigration run` → `build-index` → `reconcile` | live + clean-testnet | BatchRegistrar owner |
| 6 | Enable the v2 controller | `disable-batch-registrar` → `enable-v2-registrar` (+ `verify-*`) | live + clean-testnet | registry root-role admin |
| 7 | Switch Universal Resolver to v2 (cutover) | `phase upgrade-managed-urp` (+ `switch-urp-to-managed` on bootstrap) (+ `verify-urp`) | live + clean-testnet (bootstrap step mainnet/fresh only) | `urManager` (+ top URP owner on bootstrap) |

### Phase 0: deploy fresh v1 (clean-testnet only)

- **Applies to:** clean-testnet only. Sepolia/mainnet already have v1.
- **Command:** no standalone command; it is the first step of [`clean-testnet`](#clean-testnet).
- **Prerequisites:** none — it is the entry step of `clean-testnet`. Sepolia only.
- **Env / args:** `--network sepolia`, `--rpc-url`, `--deployer <address>`. A funded deployer key is
  required unless the RPC provides state controls (local node or Tenderly virtual testnet, which
  impersonate instead).
- **Expected outcome:** a fresh v1 ENS stack (from `lib/ens-contracts/deploy`) deployed into
  `deployments/v1/<namespace>`, giving a v1 set to migrate from.

### Phase 1: deploy v2 contracts

- **Applies to:** live + clean-testnet.
- **Command:**
  ```bash
  bun run migration -- phase deploy-v2 --network sepolia

  # On live networks, record the v1-owner txs instead of broadcasting, then replay them:
  bun run migration -- phase deploy-v2 --network sepolia \
    --defer-v1-owner-transactions \
    --deferred-v1-owner-transactions-file .dev/phase1-v1owner.jsonl
  bun run migration -- phase execute-owner-txs --network sepolia \
    --role v1Owner --file .dev/phase1-v1owner.jsonl
  ```
  Add `--include-testnet-premigration-registrar` on testnet/clean runs to also deploy
  `TestnetV1PremigrationRegistrar`. Re-run with `--resume` to continue an *interrupted* deploy.
- **Prerequisites:** `bun run compile`; a freshly funded deployer (phase 1 sends many transactions).
- **Env / args:** `DEPLOYER_KEY` (also the `owner`/`urManager` fallback and the BatchRegistrar owner);
  `SEPOLIA_V1_OWNER_KEY` / `V1_OWNER_KEY` for the deferred v1-owner replay. `phase deploy-v2` cannot
  sign v1-owner transactions itself, hence the defer-then-replay flow above.
- **Expected outcome:** all v2 contracts deployed with the `ETHRegistrar` grant **deferred** to
  [phase 6](#phase-6-enable-the-v2-controller) (`BatchRegistrar` holds `REGISTRAR | RENEW` for
  seeding); the URP proxy chain points at the v1 `UniversalResolver`
  (see [universalResolver.md](./universalResolver.md)); the v2 reverse-registrar adapters are deployed
  and authorized as controllers on the v1 reverse registrars; on HCA-enabled networks, the shared HCA
  contracts are deployed and the standalone implementation is approved by `StandaloneHCAFactory`;
  artifacts written to `deployments/<network>/` (deploys fresh by default — see
  [Deployment artifacts](#deployment-artifacts)).

The deferred v1-owner transactions point the v1 `.eth` resolver at `ENSV2Resolver` and authorize the
reverse adapters, including `DefaultReverseRegistrarAdapter` when HCA is enabled.

On an HCA-enabled network, phase 1 deploys `HCAOwnerAndSessionValidator`, `StandaloneHCAFactory`,
`HCAUpgradeSet`, and `StandaloneHCAImplementation` — the shared infrastructure only. Individual
owner-bound HCAs remain counterfactual and are deployed lazily through `StandaloneHCAFactory`.
Sepolia defaults to the fixed Rhinestone intent executor and production USDC addresses in
[`script/deploy-constants.ts`](../script/deploy-constants.ts); local, test, and clean-testnet
deployments use local mock infrastructure. The `HCA_*` address variables are optional overrides.

**Updating the HCA stack in place.** `--resume --tags hca` refreshes the shared HCA contracts and
their reverse adapters inside an existing namespace: it reuses the core deployment records, deploys
contracts whose bytecode or constructor arguments changed, and prepares replacement-adapter grants
followed by revocations of every recorded prior adapter. Replay the deferred owner transactions, then
verify that both replacement adapters are controllers and every superseded adapter is not.

### Phase 2: initial pre-migration

- **Applies to:** live + clean-testnet.
- **Command:**
  ```bash
  bun run migration -- premigration run --network sepolia \
    --csv-file <registrations.csv> --work-dir .dev/premig-1

  # Sign-off: build an index from a source other than the CSV's, then reconcile
  bun run migration -- premigration build-index --network sepolia --work-dir .dev/premig-1
  bun run migration -- premigration reconcile --network sepolia \
    --work-dir .dev/premig-1 --csv-file <registrations.csv>
  ```
- **Prerequisites:** phase 1 complete. A current v1 registration CSV (Dune export for sepolia,
  BigQuery for mainnet). See [premigration.md](./premigration.md) for the CSV format, expiry rule,
  checkpointing, and verification.
- **Env / args:** BatchRegistrar owner key (`PREMIGRATION_PRIVATE_KEY`, `BATCH_REGISTRAR_OWNER_KEY`,
  or `DEPLOYER_KEY`); `--csv-file`, `--work-dir`, `--bonus-period-days` (default 62).
  `build-index` needs `THEGRAPH_API_KEY` for the default subgraph source, or `--source rpc` and an
  RPC URL to read the v1 `BaseRegistrar` directly.
- **Expected outcome:** every active or in-grace v1 `.eth` 2LD seeded as a **reserved** entry on v2,
  with v2 expiry = v1 expiry + bonus period. `premigration reconcile` confirms it in both directions.

> **Why reconcile rather than verify.** `premigration verify` reads its list of names from the CSV, so
> a name the CSV never contained is invisible to it and the check passes. `premigration reconcile`
> starts from an independently-built index of v1 instead, and compares both ways: every claimable v1
> name must be on v2, and every entry on v2 must trace back to a claimable v1 name. It reports
> *missing*, *unexpected*, and *expiry mismatch* counts, and fails on any of them.
>
> The index must come from a **different source than the CSV**. The CSV is a manual Dune export and
> the index is built from the subgraph, so they are independent; the command refuses to run when a
> CSV's recorded source matches the index's, because verifying a CSV against the indexer that
> produced it cannot detect anything missing from that indexer. Use `--report-only` for a dry read.
>
> **Read the `cross-source:` line first.** Before comparing anything against v2, reconcile prints the
> CSV's label count beside the index's claimable count. Two independent views of the same chain must
> agree on how many names are live, and a disagreement there is a CSV problem rather than a
> pre-migration problem. The line is meaningful even before phase 2 has written anything, so it can be
> read as a standalone probe of a freshly exported CSV.
>
> **The independence refusal is opt-in.** It compares a source stamp written beside the CSV, so it
> fires only for a CSV that carries one — `fetch-data` writes a stamp, a manual Dune export does not.
> An unstamped CSV is accepted without the check, which is correct for a Dune export and blind to a
> subgraph-derived one that lost its sidecar. Keep the stamp file with the CSV it describes.
>
> **Two index sources, chosen with `--source`.** `subgraph` (the default) pages TheGraph and needs a
> gateway key. `rpc` reads the v1 `BaseRegistrar` directly: `NameRegistered` logs enumerate every
> label ever registered, and `nameExpires` at the pinned block gives each one's expiry with renewals
> folded in. The chain source needs no gateway key, cannot lag or be deprecated, and is the ground
> truth the subgraph itself indexes — worth preferring when the subgraph is unavailable, or when its
> completeness is the thing in question. It is slower, since it walks blocks rather than a cursor.
>
> ```bash
> bun run migration -- premigration build-index --network sepolia --source rpc \
>   --work-dir .dev/premig-1 --rpc-url $SEPOLIA_RPC_URL
> ```
>
> The scan starts at the registrar's recorded deploy block and narrows its range whenever a provider
> refuses the span, so a rate-limited endpoint slows the walk rather than failing it. Both phases
> checkpoint, so `--resume` continues an interrupted build at a block boundary. A partial index built
> from one source refuses to resume as the other.
>
> **`build-index` defaults to `--network mainnet`.** Omitting the flag on a testnet run builds a
> mainnet index and reconciles it against a testnet registry, which reports every name as missing
> rather than failing outright. Pass the network explicitly.
>
> **Expect the enumeration total to exceed the index by a wide margin**, since most names ever
> registered have long since been released, and the index in turn to sit a little above the claimable
> count: the build keeps an extra week beyond the grace period so a name near the boundary can never
> be dropped at build time and then wanted at reconcile time. Sepolia at block 11,575,263: 68,849
> labels ever registered, 9,011 unexpired, 9,739 claimable, 9,782 in the index.
>
> During phases 2 and 5 the expected status is strictly `RESERVED`. Migration does not open to users
> until after phase 5, so a `REGISTERED` name in this window is an anomaly rather than a claim, and is
> reported as unexpected. Pass `--expected-status reserved-or-registered` when reconciling after
> migration has opened.

If you seeded a fixture corpus, run this a second time against its own CSV and work-dir — see
[Reserving the fixture labels on v2](#reserving-the-fixture-labels-on-v2).

### Phase 3: disable v1 registrars

- **Applies to:** live + clean-testnet.
- **Command:**
  ```bash
  bun run migration -- phase disable-v1-registrars --network sepolia \
    --private-key $SEPOLIA_V1_OWNER_KEY
  bun run migration -- phase verify-v1-registrars-disabled --network sepolia
  ```
- **Prerequisites:** phase 2 complete (so no active name is stranded by the freeze). Signed by the v1
  owner. **`premigration reconcile` must have passed** for this deployment on this chain — the
  command refuses to run otherwise. Freezing v1 is the irreversible step: a claimable name that
  pre-migration missed can never be picked up afterwards, and the reconciliation is what proves none
  was. `--skip-preconditions` overrides the gate when you have a reason to, and
  `--max-reconcile-age-blocks` controls how stale a pass may be (default ~1 day) — names keep being
  registered on v1 until the freeze, so an old pass says nothing about now. A reconciliation that
  *fails* revokes any earlier pass rather than leaving it standing. This command takes the key via `--private-key` explicitly — the env fallback applies only
  when it is run through `phase execute-owner-txs --role v1Owner`.
- **Env / args:** v1 owner key via `--private-key` (or `SEPOLIA_V1_OWNER_KEY` / `V1_OWNER_KEY` through
  execute-owner-txs). `--calldata-only` emits calldata for a multisig instead of broadcasting.
- **Expected outcome:** every v1 authorization the active deployment did not itself grant is revoked; new v1
  registrations frozen. The phase audits three v1 surfaces:

  | Surface | Candidates considered | Revoked via |
  | --- | --- | --- |
  | `BaseRegistrar` | the four v1 registration controllers, the handoff contracts (`ETHRenewerV1`, `Graveyard`, `TestnetV1PremigrationRegistrar`) of **every** namespace on this chain, and any address in the registrar's `ControllerAdded` history that no local artifact accounts for | `RegistrarSecurityController.removeRegistrarController` while it still owns the registrar, else `removeController` |
  | `ReverseRegistrar` | this tooling's handoff contracts granted there (`TestnetV1PremigrationRegistrar`, `ReverseRegistrarAdapter`) of **every** namespace on this chain, plus any address in the registrar's `ControllerChanged` history that reports forwarding to it | `setController(addr, false)` |
  | `DefaultReverseRegistrar` | this tooling's handoff contracts granted there (`TestnetV1PremigrationRegistrar`, `DefaultReverseRegistrarAdapter`) of **every** namespace on this chain, plus any address in the registrar's `ControllerChanged` history that reports forwarding to it | `setController(addr, false)` |

  Only the **active** namespace's handoff contracts are left authorized.
  `verify-v1-registrars-disabled` asserts that complete set and fails on anything else.

  Namespaces are matched against both the network and the active `--deployment-network`, so a custom
  namespace and the archives named after it are scanned too. The active namespace's artifacts are read
  directly rather than through that scan.

  v1-side controllers on the reverse registrars (the official registrar controllers, which set reverse
  records during registration) are **not** touched. A discovered address counts as this tooling's own
  only when it answers `REVERSE_REGISTRAR()` / `DEFAULT_REVERSE_REGISTRAR()` with the registrar holding
  the grant; everything else is listed as `v1-owned, outside migration remit` and left enabled.

> **Use an archival RPC.** Each surface's controller history is read from its events across the whole
> chain. An uncapped archival endpoint reads each surface in one request. Providers that cap
> `eth_getLogs` by block span or result count (free tiers commonly at 1k–10k blocks) still complete
> and return the same controllers, but cost hundreds of requests and several minutes. A refusal that
> persists at the smallest span, or a fork whose history predates its fork block, **fails** both
> commands rather than falling back to a partial audit.

### Phase 4: keep unmigrated names renewable

- **Applies to:** live + clean-testnet.
- **Command:** three v1-owner steps, **in order**, then verify:
  ```bash
  bun run migration -- phase authorize-v1-renewer            --network sepolia
  bun run migration -- phase activate-v1-handoff-controllers --network sepolia
  bun run migration -- phase activate-v1-renewer             --network sepolia
  bun run migration -- phase verify-v1-renewer               --network sepolia
  bun run migration -- phase verify-v1-registrars-disabled   --network sepolia --require-active-grants
  bun run migration -- phase verify-reverse-adapters         --network sepolia
  ```
- **Prerequisites:** phase 2 complete — `ETHRenewerV1` can only renew names already `RESERVED` on v2.
  Runs right after the phase 3 freeze. Order matters within the phase: every controller grant must be
  made **before** `activate-v1-renewer` transfers registrar ownership away from the v1 owner.
- **Env / args:** v1 owner key (`SEPOLIA_V1_OWNER_KEY` / `V1_OWNER_KEY`, read from env).
  `--calldata-only` for a multisig — with a DAO the three writes combine into one Safe/multisend
  transaction. On testnets `TestnetV1PremigrationRegistrar` is re-authorized alongside the
  `Graveyard` (the individual steps are also available as `activate-v1-graveyard` and
  `authorize-testnet-v1-premigration-registrar`).
- **Expected outcome:** `ETHRenewerV1` authorized as a v1 `BaseRegistrar` controller; `Graveyard` (+
  testnet helper) authorized; v1 `BaseRegistrar` ownership transferred to `ETHRenewerV1`. Unmigrated
  names are renewable from here, each renewal extending the v1 registration, the v2 reservation, and —
  for a wrapped name — the `NameWrapper`'s own copy of the expiry, all in one transaction, leaving the
  v2 entry `RESERVED`. This does **not** reopen the phase 3 registration freeze. `verify-v1-renewer`
  confirms both halves of the state a renewal needs.

> **The controller grant alone does not make a name renewable.** `ETHRenewerV1.renew` calls
> `syncWrapper`, which calls `addController` on the v1 `BaseRegistrar` so `NameWrapper` can update a
> wrapped name's expiry. `addController` is **owner-gated**, so a renewal reverts until the registrar
> is owned by `ETHRenewerV1`. That is why the ownership transfer belongs to this phase and not a later
> one: authorizing the controller and deferring the handoff leaves renewals broken for the whole of
> phase 5, which can run for days. `verify-v1-renewer` asserts the pair, and
> `test/e2e/renewerV1Smoke.test.ts` checks that the phase-4 end state renews and that the controller
> grant on its own does not.
>
> **The renewal outage therefore spans phase 3 → phase 4 only.** Run the two back-to-back, or combine
> their `--calldata-only` output into a single Safe transaction, and no renewal window is lost.

> **This is where the v1 owner stops being able to manage v1 controllers.** After
> `activate-v1-renewer` the registrar answers only to `ETHRenewerV1`, so every v1 authorization the
> migration needs has to be granted earlier in this phase. It is recoverable rather than final —
> `ETHRenewerV1.transferRegistrarOwnership` is owner-gated, and
> [`phase reclaim-v1-registrar-ownership`](#cli-commands) uses it to hand the registrar back — but
> renewals stop working for as long as the registrar is elsewhere.
>
> These grants are the last writes to touch v1 authorizations, so
> `verify-v1-registrars-disabled --require-active-grants` is run here to assert the final set in both
> directions: only the active deployment's contracts may hold a v1 grant, and every grant it depends
> on must be present. `fork full` runs this assertion automatically. It is the check that catches a
> superseded deployment's controller surviving the freeze — the phase 3 registration smoke test cannot
> see one, because it only exercises the official registrar controller's path.
>
> **Assert both directions, not just one.** By default that audit only looks for grants that should be
> *gone*: it tests whether a controller is enabled before anything else, so a grant the active
> deployment *needs* but does not have reads as "disabled" and passes. A revoked reverse adapter
> silently stops reverse records being written and nothing else reports it. `--require-active-grants`
> adds the missing direction, and `verify-reverse-adapters` checks the adapters specifically —
> including that each one points back at the registrar holding its grant, so an adapter authorized on
> the wrong registrar is caught too.

`fork full` performs a real renewal in this phase, asserting that the v1 registration, the v2
reservation and the `NameWrapper` expiry all move together, rather than only checking that the
renewer is an authorized controller.

### Phase 5: final pre-migration sync

- **Applies to:** live + clean-testnet.
- **Command:**
  ```bash
  bun run migration -- premigration run --network sepolia \
    --csv-file <fresh-post-freeze.csv> --work-dir .dev/premig-2

  # Sign-off: rebuild the index at the current head, then reconcile
  bun run migration -- premigration build-index --network sepolia --work-dir .dev/premig-2
  bun run migration -- premigration reconcile --network sepolia \
    --work-dir .dev/premig-2 --csv-file <fresh-post-freeze.csv>
  ```
- **Prerequisites:** phase 3 freeze done. Export a **fresh** post-freeze registration CSV so names
  registered or renewed since phase 2 are caught up.
- **Env / args:** same BatchRegistrar owner key as [phase 2](#phase-2-initial-pre-migration);
  `THEGRAPH_API_KEY` for `build-index`, or `--source rpc` to index from the chain instead.
- **Expected outcome:** names whose v1 expiry grew since phase 2 have their reservation extended —
  picking up `ETHRenewerV1` renewals since phase 4 — and newly eligible names are reserved for the
  first time. Names already carrying the right expiry are left alone rather than resubmitted, so this
  sync sends only what changed. `premigration reconcile` is the gate.

If you seeded a fixture corpus, re-run against the same `fixture-premigration.csv` as at phase 2 with
a fresh `--work-dir`; the corpus is frozen by then, so the file does not need regenerating.

### Phase 6: enable the v2 controller

- **Applies to:** live + clean-testnet.
- **Command:** two owner-gated steps, **in order**, then verify:
  ```bash
  bun run migration -- phase disable-batch-registrar          --network sepolia
  bun run migration -- phase enable-v2-registrar              --network sepolia
  bun run migration -- phase verify-v2-registrar              --network sepolia
  bun run migration -- phase verify-roles                     --network sepolia
  ```
- **Prerequisites:** phase 5 complete. Every v1-side write already happened in
  [phase 4](#phase-4-keep-unmigrated-names-renewable), so this phase touches only the v2 registry and
  needs only one signer.
- **Env / args:** registry root-role admin key (`OWNER_KEY`, falls back to `DEPLOYER_KEY`), and
  `--calldata-only` for a multisig.
- **Expected outcome:** `BatchRegistrar` roles revoked (pre-migration seeding ends); `ETHRegistrar`
  granted `REGISTRAR | RENEW` on the v2 `ETHRegistry` — live v2 registrations open.
  `verify-v2-registrar` confirms the grant.

  > `verify-roles` audits the v2 side the way
  > [phase 4](#phase-4-keep-unmigrated-names-renewable)'s `verify-v1-registrars-disabled` audits the
  > v1 side, and this is the last step to change v2 authority. It reads every role holder live at its
  > current resource rather than replaying `EACRolesChanged`, because the event log cannot reconstruct
  > the matrix: a name expiring bumps the resource id and orphans every grant against the old one with
  > no transaction and no event, and an ERC-1155 operator inherits the owner's roles through a
  > different event entirely. Logs are used only to decide which addresses to ask about. It catches a
  > role nobody granted, a grant that was never made, and admin bits left behind when only the regular
  > roles were revoked — none of which a single `hasRootRoles` spot check can see.

### Phase 7: switch the Universal Resolver to v2

- **Applies to:** live + clean-testnet. The **`switch-urp-to-managed`** step is **bootstrap-only**
  (mainnet and fresh chains); the sepolia reuse path skips it.
- **Command:**
  ```bash
  # Reuse networks (sepolia): the top URP already fronts the intermediate URP, so only the upgrade runs
  bun run migration -- phase upgrade-managed-urp --network sepolia
  bun run migration -- phase verify-urp          --network sepolia

  # Bootstrap networks (mainnet, fresh chains): point the top URP at the intermediate URP first
  bun run migration -- phase switch-urp-to-managed --network mainnet
  bun run migration -- phase upgrade-managed-urp   --network mainnet
  bun run migration -- phase verify-urp            --network mainnet
  ```

  Snapshot resolution **before** the cutover and diff it after, so the switch is verified by
  comparison rather than by a liveness probe:
  ```bash
  # Before switch-urp-to-managed / upgrade-managed-urp
  bun run migration -- phase snapshot-resolution --network mainnet \
    --names vitalik.eth,ens.eth,<a name with no resolver>,<an offchain name> \
    --out-file .dev/resolution-before.json
  # After
  bun run migration -- phase verify-resolution --network mainnet \
    --snapshot-file .dev/resolution-before.json
  ```
- **Prerequisites:** phase 6 complete. Run **last**, so public resolution flips to v2 only once
  everything else is live.
- **Env / args:** intermediate URP admin key (`UR_MANAGER_KEY`, falls back to `DEPLOYER_KEY`) for
  `upgrade-managed-urp`; top URP owner key (`SEPOLIA_TOP_URP_OWNER_KEY` / `TOP_URP_OWNER_KEY`) for the
  bootstrap `switch-urp-to-managed`. `--calldata-only` for a multisig/DAO.
- **Expected outcome:** the resolution cutover — the intermediate URP is upgraded to
  `UniversalResolverV2` and public resolution serves v2. `verify-urp` confirms both proxy
  implementations. See [universalResolver.md](./universalResolver.md) for the proxy chain and the
  optional post-cutover step.

> **A proxy pointing somewhere new is not a working cutover.** `verify-urp` compares implementation
> addresses; it says nothing about whether names still resolve. Checking that a name resolves to a
> non-zero address is barely stronger — a name that resolves to the *wrong* address, loses its text
> records, or stops answering a coin type it used to support all pass that test.
>
> `snapshot-resolution` records the real answers first — `addr`, each coin type, each text key, and
> contenthash — and `verify-resolution` re-asks exactly those questions afterwards and fails on any
> record that changed, in either direction: a record that stops resolving, one that starts, and one
> that returns something different are all differences. Include awkward cases in `--names`: a name
> with no resolver, a wildcard/offchain name, and a DNS TLD mirror.
>
> `fork full` does this automatically around phase 7 and prints any differences. Its sample is the
> run's own smoke names plus names drawn from `--csv-file` that are confirmed to carry records before
> the switch — a record that reverts on both sides counts as unchanged, so a sample of names that
> resolve nothing would pass while proving nothing. Add your own with `--resolution-names
> <comma-separated>`. When no sampled name resolves anything, the run says the cutover was **not
> verified** rather than reporting an unchanged result.

## Re-deploying onto an already-migrated network

"Re-deploying fresh" means deploying a brand-new v2 set onto a network whose v1 a previous deployment
already migrated. The earlier v2 set is archived (see [Deployment artifacts](#deployment-artifacts))
and left orphaned on-chain; every later phase re-seeds and re-wires v1 to the **new** addresses.

The phase order is unchanged, and **no phase may be skipped**. One extra step comes first:

```bash
bun run migration -- phase reclaim-v1-registrar-ownership --network sepolia
```

The v1 `BaseRegistrar` is still owned by the prior deployment's `ETHRenewerV1`, and one deferred
phase-1 transaction is an owner-gated `setResolver` the v1 owner must sign — so ownership has to come
back before the phase-1 replay. [`fork full`](#fork-full) detects an already-migrated chain and
adjusts automatically.

| Phase | What changes on a repeat deploy |
| --- | --- |
| 1 | Archives the existing `deployments/<network>/` namespace and deploys a brand-new v2 set with new addresses. `--resume` is for continuing an *interrupted* deploy into the same namespace, **not** for a fresh redeploy. Needs the `reclaim-v1-registrar-ownership` step above first. |
| 2 | The new v2 registry is empty, so this seeds from scratch exactly like a first run — reservations from the prior deployment lived on the now-archived registry. Use a fresh `--work-dir` so no stale `preMigration-checkpoint.json` is picked up. |
| 3 | **Must be run — not a no-op.** The v1 registration controllers stay frozen from the prior deployment, but *its* handoff contracts are still authorized. `TestnetV1PremigrationRegistrar` among them is a permissionless free registrar: leaving it enabled silently reopens `.eth` registration on v1, and the names it mints reserve into the **archived** v2 registry (they are also invisible to the TheGraph-based CSV export, so a later pre-migration will not pick them up). Follow with `verify-v1-registrars-disabled`. |
| 4 | Re-points v1 at the new set: authorizes the **newly-deployed** `ETHRenewerV1` and `Graveyard` (new addresses), then transfers v1 `BaseRegistrar` ownership to the new `ETHRenewerV1` (the ownership reclaimed above). The prior deployment's `Graveyard`/`ETHRenewerV1`/`TestnetV1PremigrationRegistrar` are removed by phase 3 in the same run, so run the phases in order rather than skipping ahead. |
| 5 | Same as phase 2 — re-seeds the new registry against a fresh post-freeze CSV and a fresh `--work-dir`. |
| 6 | `enable-v2-registrar` grants the new `ETHRegistrar` its roles on the new registry. |
| 7 | On a reuse network (sepolia) the top **and** intermediate URPs are adopted by address and never redeployed — phase 1 deploys a fresh `UniversalResolverV2` implementation and `upgrade-managed-urp` re-points the reused intermediate URP at it, orphaning the prior implementation. Bootstrap networks deploy a fresh intermediate URP instead. |

## Live deployment (Sepolia)

End-to-end runbook for a fresh Sepolia deployment against the canonical (live) v1. **Rehearse first**
— [`fork full`](#fork-full), ideally against a [Tenderly live fork](#tenderly-virtual-testnets),
exercises this exact sequence.

### Signer keys

Three keys cover every signature on the sepolia reuse path. The top URP owner key is **not** needed —
the top URP already fronts the intermediate URP, so the cutover never touches it.

| Key | Role |
| --- | --- |
| `DEPLOYER_KEY` | Deployer EOA; on sepolia also resolves as `owner` (registry root-role admin) and is the `BatchRegistrar` owner. Must be freshly funded — phase 1 sends many transactions. |
| `SEPOLIA_V1_OWNER_KEY` | v1 owner (`0x0f32b753afc8abad9ca6fe589f707755f4df2353`); signs the deferred phase-1 v1-owner txs, phase 3, and every phase-4 step. Phase 6 needs no v1-owner signature. |
| `UR_MANAGER_KEY` | Intermediate `ManagedUniversalResolverProxy` admin (`0x6d80F2172CFdEc5730fE683860C33d26fC42e6F1`, admin `0xffFffFFfFF52D316B7Bd028358089bc8066b8f80`); signs the phase-7 cutover. |

### Setup

```bash
cd contracts
bun run compile                                      # forge + hardhat → generated/artifacts

export SEPOLIA_RPC_URL=<reliable paid sepolia RPC>   # phase 1 sends many txs
export DEPLOYER_KEY=0x<fresh funded EOA>             # also owner / urManager / BatchRegistrar owner
export SEPOLIA_V1_OWNER_KEY=0x<key for 0x0f32…2353>
# HCA address variables are optional; Sepolia production defaults live in script/deploy-constants.ts.

mkdir -p .dev/sepolia-live
```

Also export a **current** Sepolia registration CSV for the pre-migration phases (Dune export — see
[premigration.md](./premigration.md)); the repo's `csv-data/ens-registrations-sepolia.csv` is a small
sample, not a real export.

> **Deployer and `.env` hygiene.** `DEPLOYER_KEY` should be a freshly funded EOA. If it happens to be
> the same address as the v1 owner, `phase deploy-v2` wires that address with the v1-owner key so it
> keeps a local signer. Keep `.env` values free of inline `#` comments — quote a value if it must
> contain a literal `#`.

### Run the phases

Run the phases in order; each links to its entry in [Phases](#phases) for the exact command,
prerequisites, and result:

1. [Phase 1 — deploy fresh v2](#phase-1-deploy-v2-contracts), recording v1-owner txs with
   `--defer-v1-owner-transactions --deferred-v1-owner-transactions-file .dev/sepolia-live/phase1-v1owner.jsonl`
   and replaying the resolver update and reverse-adapter grants via
   `phase execute-owner-txs --role v1Owner`.
   Then, *(optional)* [seed the ENSv1 test fixture corpus](#ensv1-test-fixture-corpus):
   `fixture seed-v1` → `fixture verify-v1`. **This must sit after phase 1**, which deploys the
   `MigrationHelper` the corpus approves, **and before phase 3**, which freezes v1 registration.
2. [Phase 2 — initial pre-migration](#phase-2-initial-pre-migration) (`--work-dir .dev/sepolia-live/premig-1`).
   Pass the fixture label CSV alongside the real export if the corpus was seeded.
3. [Phase 3 — freeze v1 registrations](#phase-3-disable-v1-registrars) (`--private-key $SEPOLIA_V1_OWNER_KEY`).
4. [Phase 4 — keep unmigrated names renewable](#phase-4-keep-unmigrated-names-renewable). Renewals
   are unavailable between the phase 3 freeze and this phase, so run the two back-to-back — with a
   DAO/multisig, as one Safe transaction — to keep the outage short.
5. [Phase 5 — final sync](#phase-5-final-pre-migration-sync) from a fresh post-freeze CSV
   (`--work-dir .dev/sepolia-live/premig-2`).
6. [Phase 6 — enable the v2 controller](#phase-6-enable-the-v2-controller).
7. [Phase 7 — resolution cutover](#phase-7-switch-the-universal-resolver-to-v2): sepolia is a reuse
   network, so only `upgrade-managed-urp` + `verify-urp` run.

This runbook assumes a first migration. On a repeat deploy the order is unchanged but extra steps
apply — see
[Re-deploying onto an already-migrated network](#re-deploying-onto-an-already-migrated-network).

> **Mainnet differs.** The owner, top URP admin, and v1 owner are all the DAO/multisig, so the
> owner-signed and URP-admin phases run with `--calldata-only` (or deferred) and execute through the
> Safe. Mainnet is also a **bootstrap** URP network, so phase 7 additionally runs
> `switch-urp-to-managed` first.

### After

The new `deployments/sepolia/` namespace (and any dated archive) is committed automatically —
`.gitignore` tracks real namespaces and ignores only the `-fork` / `-clean-` runtime sets (see
[deployments/README.md](../deployments/README.md)). Pre-migration (phases 2 and 5) is the heavy,
stateful part: it is checkpointed (`premigration resume`) and has its own flags — read
[premigration.md](./premigration.md) and confirm the CSV export before the live run.

> **Check the calldata before the Safe signs it.** `--calldata-only` output travels by hand into a
> Safe, where a wrong target or a transposed argument is invisible — one `0x…` looks like another, and
> once the threshold signs it executes. `phase verify-owner-tx --file <prepared.jsonl> --to <target>
> --data <calldata>` re-derives the comparison and fails unless the transaction matches one the tool
> produced, reporting the closest near-miss when it does not.

### Verify source code

Once live, submit the deployed contracts for source verification on Etherscan and Sourcify. This reads
the artifacts under `deployments/<network>/` — no recompile or redeploy is required:

```bash
cd contracts
export ETHERSCAN_API_KEY=<etherscan v2 api key>   # one key covers all chains; not needed for Sourcify
bun run verify:sepolia                            # → verify:mainnet for the mainnet set
```

A `clean-testnet` namespace also carries the ENSv1 stack it deployed, under
`deployments/v1/<namespace>`. Both sets are verified: the command picks up that tree whenever it
exists and submits it as a second pass. `--skip-v1` limits the run to v2. Pass the namespace as the
network for a clean testnet — the chain is read from the artifacts, not from a network config:

```bash
bun run verify -- --network sepolia-clean-<timestamp>
```

Verification is idempotent and re-runnable: contracts already verified on a backend are detected and
skipped. `--etherscan-only` and `--sourcify-only` limit the run to one backend, and
`--sourcify-server <url>` points at a self-hosted Sourcify. Any other flag passes through to
`rocketh-verify` (e.g. `bun run verify -- --network sepolia --etherscan-only`).

A contract that fails Sourcify verification is reported by name and the command exits non-zero; the
run continues through the rest of the set first, so one failure does not hide the others.

## ENSv1 test fixture corpus

An optional corpus of ENSv1 names, registered so the migration phases run against realistic v1 state
instead of only the names that happen to exist. Each name is shaped into a specific pre-migration
state — wrapped or unwrapped, particular fuses burned, particular resolver and record history, reverse
claims, parent/child hierarchies — and most of the labels are then reserved on v2 by the ordinary
pre-migration phases.

The corpus seeds v1 state and gets labels reserved. It does **not** migrate names: migrating a name is
a manual action its owner takes whenever they choose, and no phase performs it.

This is test scaffolding. It is refused against live mainnet, and nothing in the canonical phases
depends on it.

### Input data

The corpus ships with the repo as `contracts/fixtures/migration-fixture.tgz`. It expands to about
54MB, so the archive is tracked and the working copy is not: `postinstall` unpacks it alongside the
other CSV input, which is gitignored.

```
csv-data/migration-fixture/
  weighted-scenarios.jsonl    # one scenario per line, ~54MB
```

`bun install` does this. To unpack it by hand — after replacing the archive, or if a fresh checkout
skipped lifecycle scripts — run `bun run fixtures:extract` from the repo root. It re-extracts only
when the archive is newer than what was unpacked, so it is cheap to run repeatedly. To repack a
changed corpus:

```bash
cd contracts/csv-data && tar czf ../fixtures/migration-fixture.tgz migration-fixture
```

The scenario file is the whole corpus — the label list pre-migration reserves is derived from it, not
shipped beside it.

### Choosing a cohort

The bundle carries far more scenarios than a run needs, weighted by how common each migration shape
is. Selection flags compose:

| Flag | Effect |
| --- | --- |
| `--scenarios live_now` | Only scenarios a public testnet can express. `fork_only` needs Anvil/Tenderly time and reorg control. |
| `--replicas-per-vector <n>` | Keep at most *n* copies of each distinct scenario. |
| `--tiers <list>` | Restrict to popularity tiers. Concentrates volume on common shapes at the cost of behavioural coverage. |
| `--fixture-ids <list>` | An explicit set, for reproducing one case. |
| `--limit <n>` | Cap the cohort at *n* names, applied after the filters above. |

Seeding refuses a selection whose scenarios it cannot establish, naming them: an expiry that needs a
controlled clock, a v2 state that needs the name already registered there, or a lease below the v1
controller's minimum. `fixture verify` applies the same check offline, so a cohort can be tested
before a run starts. Every `live_now` scenario passes it.

> **Reverse records are shared.** A reverse node derives from the account that claims it, and each
> actor alias is one account, so scenarios claiming from the same alias all write the same node and
> only the last survives. Seeding reports the overlap. Nothing else the corpus shapes or checks
> depends on it, and no migration route reads a reverse record.

`--scenarios live_now --replicas-per-vector 4` is the recommended default: it covers every scenario
the public network can express, several times over, without the long tail of replicas that adds
registration cost but no new behaviour.

`--scenarios` filters on each scenario's `execution.scenario` — whether it can run on a public network
at all. That is a separate axis from the v2 state a scenario declares, which is what decides
[whether its label gets reserved](#reserving-the-fixture-labels-on-v2); neither filters the other, so
a `live_now` cohort still contains names meant to stay unreserved.

Always dry-run the selection first. `verify` sends nothing — it parses the corpus, checks the replica
contract, and plans every scenario's calls, so an unsupported action or an unresolvable reference
surfaces before anything touches a chain. It still derives the actor addresses the plan refers to, so
it needs the actor mnemonic and a network RPC variable set:

```bash
export MIGRATION_FIXTURE_ACTOR_MNEMONIC="<dedicated fixture mnemonic>"

bun run migration -- fixture verify --network sepolia \
  --fixture-root csv-data/migration-fixture --work-dir .dev/fixture \
  --scenarios live_now --replicas-per-vector 4
```

Planning is not a state check. It confirms every call can be *built*; whether the resulting state is
reachable on-chain is what [`verify-v1`](#checking-the-shaped-state) answers, after seeding.

### Seeding

Requires `bun run compile` first, a funded operator key, and a dedicated actor mnemonic
(`MIGRATION_FIXTURE_ACTOR_MNEMONIC`) — never a mnemonic used for anything else. Fixture names are
distributed across five named actors, which need funding because a large share of the state shaping
must be signed by the holder rather than batched.

```bash
export MIGRATION_FIXTURE_ACTOR_MNEMONIC="<dedicated fixture mnemonic>"

bun run migration -- fixture fund-actors --network sepolia \
  --fixture-root csv-data/migration-fixture --work-dir .dev/fixture

bun run migration -- fixture seed-v1 --network sepolia \
  --fixture-root csv-data/migration-fixture --work-dir .dev/fixture \
  --scenarios live_now --replicas-per-vector 4
```

`seed-v1` deploys a batching helper and the corpus's counterparty contracts, registers each name
through the official v1 commit/reveal controller at the duration its scenario asks for, shapes the v1
state, and writes `<work-dir>/fixture-premigration.csv`. It replays each scenario's registration
state, then the setup steps modelling the history in between, then closes on the target state — so a
name whose history clears records it is still expected to hold ends up holding them.

It is resumable per name: a name whose setup finished is skipped, and one registered to anyone but a
fixture actor aborts the run rather than shaping state against a name we do not control. A name whose
registration landed but whose setup did not also aborts, naming the name — its state is part-shaped,
and replaying setup over it would write against a name that has already moved on. Keep the work
directory when that happens: it records the batcher that holds the name, and a fresh one deploys
another and cannot reach it. Drop the name from the selection, or reseed against a fresh chain.

> **Recompile first.** `seed-v1` deploys the corpus's counterparty contracts from
> `generated/artifacts/`, which is gitignored. A tree compiled before those contracts last changed
> fails at the first deployment with viem's `AbiEncodingLengthMismatchError` — a stale-ABI mismatch,
> not a fault in the corpus or the chain.

> **Ordering.** Seeding sits **after [phase 1](#phase-1-deploy-v2-contracts) and before
> [phase 3](#phase-3-disable-v1-registrars)**. It cannot precede phase 1: much of the corpus approves
> `MigrationHelper` as an operator while shaping its v1 state, and that is a v2 contract phase 1
> deploys. It cannot follow phase 3 either, since that freezes v1 registration.

### Checking the shaped state

`verify-v1` reads the seeded state back and compares it against each scenario:

```bash
bun run migration -- fixture verify-v1 --network sepolia \
  --fixture-root csv-data/migration-fixture --work-dir .dev/fixture
```

For every seeded name it checks the registry owner, resolver and TTL, the `BaseRegistrar` token owner
(the parent's, for a child name), the `NameWrapper` owner, the burned fuses, and every record the
scenario declares. Reads are batched through multicall, so a large cohort costs a few round trips.
`NameWrapper` burns `PARENT_CANNOT_CONTROL | IS_DOT_ETH` itself on every wrapped `.eth` 2LD; the
corpus does not restate those, and the check allows for them.

It exits non-zero listing every mismatch, and writes the full set to
`<work-dir>/fixture-v1-verification.json`. Run it before pre-migration, while a name whose state did
not take can still be reshaped.

> **Known-bad vectors — exclude them from the cohort.** Some scenarios declare `CAN_EXTEND_EXPIRY` on
> a `.eth` 2LD, which cannot be satisfied on-chain: the fuse is parent-controlled, and `wrapETH2LD`
> always burns `PARENT_CANNOT_CONTROL`, so nothing can set it afterwards. Fuses are compared exactly,
> so `verify-v1` fails on any cohort containing one. `fixture verify` does not catch them — the plan
> is buildable; only the chain rejects it.
>
> 38 of the 761 distinct `live_now` vectors are affected; their ids all begin `3W-`, `FE-` or `PW-`
> (most vectors under those prefixes are fine — the report names the exact ones). Because
> `--replicas-per-vector` sorts by scenario id, `--limit` takes an alphabetical prefix that starts on
> an affected vector: ten of the first forty. Standalone this is a report you can read past;
> [in a rehearsal it aborts the run](#in-a-rehearsal). Until the corpus is fixed, pin the cohort with
> `--fixture-ids` from a list the affected vectors are excluded from.

### Reserving the fixture labels on v2

**Seeding registers the whole cohort on v1; pre-migration reserves only part of it.** Every scenario
declares the v2 state it expects to meet at migration time, and only those expecting `RESERVED` belong
in pre-migration. `seed-v1` applies that split when it writes `fixture-premigration.csv`, so the file
is already the correct subset — there is no flag, and no filtering to do downstream:

| Declared v2 state | Whole corpus | Of a `live_now` cohort | In `fixture-premigration.csv` |
| --- | --- | --- | --- |
| `present` — reserved on v2, the ordinary migration case | ~86% | ~94% | yes |
| `missing` — must still be available, never pre-migrated | ~6% | ~6% | no |
| `already_registered` — already fully owned on v2 | ~6% | — | no |
| `expired` — available or past its v2 expiry | ~2% | — | no |

Reserving one of the last three would destroy the precondition its scenario exists to test. Every
`already_registered` and `expired` scenario is `fork_only`, so a `live_now` cohort meets only the
first two — but it does meet `missing`.

The emitted CSV records each row's declared state in its `reservationState` column, so the file also
serves as the record of which fixture names pre-migration was expected to touch. It leads with a
`labelName` column, which is the column [`premigration`](./premigration.md#csv-input) locates by name,
so it is fed to the ordinary phases with no transformation (the remaining columns are diagnostic):

```bash
bun run migration -- premigration run --network sepolia \
  --csv-file .dev/fixture/fixture-premigration.csv \
  --work-dir .dev/sepolia-live/premig-fixture
```

Run it in addition to the real registration export, at [phase 2](#phase-2-initial-pre-migration) and
again at [phase 5](#phase-5-final-pre-migration-sync), with its own `--work-dir` so the two runs keep
separate checkpoints.

### In a rehearsal

`fork full` and `clean-testnet` run the whole corpus stage themselves when given `--fixture-root`,
placing each part where the ordering above requires: seeding and the state check after phase 1, and
the reservable fixture labels folded into the pre-migration CSV so phases 2 and 5 reserve them.

```bash
bun run migration -- fork full --network sepolia \
  --csv-file ./csv-data/ens-registrations-sepolia.csv \
  --work-dir .dev/forkfull --fixture-root ./csv-data/migration-fixture \
  --fixture-scenarios live_now --fixture-replicas-per-vector 1 --fixture-limit 40
```

The selection flags mirror the standalone ones (`--fixture-scenarios`, `--fixture-tiers`,
`--fixture-ids`, `--fixture-limit`, `--fixture-replicas-per-vector`). Keep a rehearsal cohort small:
every name is a real commit/reveal registration plus its state-shaping calls, so the whole corpus
costs far more wall-clock than the rest of the rehearsal put together.

A rehearsal prepends the fixture labels to its own transformed CSV rather than passing
`fixture-premigration.csv` to a second pre-migration run, but it reserves the same set. The written
file is still there for inspection under `<work-dir>/fixture/`. Because both phases read that one CSV,
a `--resume-from-phase 2` run skips reseeding and keeps the labels the earlier run already prepended.

Against a state-controlled RPC (a local fork or a Tenderly virtual testnet) the operator key and the
actor mnemonic are generated per run and funded directly, so no funded keys are needed; both are
written under `<work-dir>/fixture/` so a resumed run addresses the same accounts. Generating them also
avoids the EIP-7702 delegations that the well-known test accounts carry on live chains, which would
otherwise make ERC-1155 receipt fail. On an RPC without state controls, pass `--fixture-private-key`
and `--fixture-actor-mnemonic` (or their environment equivalents).

> **The state check is fatal here.** Standalone, `verify-v1` reports mismatches and exits non-zero,
> leaving you to decide. In a rehearsal it runs inside the seed stage, so one mismatch throws and
> takes the whole run down before phase 2 — including a
> [known-bad vector](#checking-the-shaped-state). The `--fixture-limit 40` cohort above trips it. Pin
> the cohort with `--fixture-ids` instead; a 60-vector cohort built that way runs end-to-end, with
> `verify-v1` passing and phases 2 and 5 reserving the labels.

## Rehearsals

### `fork full`

```bash
bun run migration -- fork full --network sepolia --csv-file ./csv-data/ens-registrations-sepolia.csv \
  [--work-dir <dir>] [--save-deployments] [--snapshot-file <path>] \
  [--require-full-coverage] [--resolution-names <comma-separated>]
```

Spawns a local Anvil fork of the network RPC (default port 8547 sepolia / 8548 mainnet), impersonates
the deployer, owner, v1 owner, URP admins, and BatchRegistrar owner, and runs phases 1–7 in order with
smoke checks interleaved:

- v1 registration succeeds before phase 3 and is rejected after;
- `ETHRenewerV1` owns the v1 `BaseRegistrar` after phase 4, and a real renewal there extends the v1
  registration, the v2 reservation, and a wrapped name's `NameWrapper` expiry together;
- a pre-migrated name is migrated to v2 via `UnlockedMigrationController` after phase 5;
- the v2 registrar rejects registrations before phase 6's grant, rejects pre-migrated reserved names
  after it, and accepts a fresh name after enablement.

When the target chain has already completed the v1 hand-off, `fork full` detects this from the v1
registrar-controller state — the run calls it **post-migration mode** — and skips the smoke checks
that require live v1 registration, while still running the deploy, pre-migration, renewer
authorization, the pre-enablement rejection, and the URP cutover. A pristine chain runs all of them;
it is detected automatically.

**Live Sepolia is already migrated, so every Sepolia rehearsal runs reduced.** This is expected, not a
misconfiguration, and no flag or CSV changes it — the fork inherits a chain on which no v1
registration controller is authorized, so nothing can mint a v1 name to test against. To exercise the
full set you need a chain whose v1 is still live: `fork full --network mainnet` (mainnet has not
migrated), or [`clean-testnet`](#clean-testnet), which deploys a fresh v1 stack you own.

> **Know what a run actually covered.** Post-migration mode drops the live v1 registrations, the
> phase 3 freeze rejection, the pre-migration `RESERVED` assertions, and the only v1 → v2 migration
> smoke in the script. On a network with no mintable payment token — mainnet, which whitelists real
> USDC/DAI — every paid-registration smoke is skipped too, so the entire `ETHRegistrar` commit/reveal,
> pricing, and ERC-20 payment path goes unexercised. A repeat mainnet run hits both at once and can
> perform **zero** registrations, **zero** migrations, and **zero** rejection assertions while still
> reporting success.
>
> On a fork with state controls the paid smokes are recovered rather than skipped: the rehearsal
> writes a real USDC balance for the smoke account directly (`tenderly_setErc20Balance`, or by
> locating the token's balances storage slot on Anvil) and runs the same registration and renewal
> checks against the real token. Only when that is not possible are they dropped.
>
> Every run therefore ends with a **coverage summary**: what stopped the rehearsal covering
> everything, the checks that cost, what still ran, and the command that would exercise the rest.
> `--require-full-coverage` turns a reduced run into a failure instead — post-migration mode fails
> before the rehearsal starts, and a fork that could not fund a payment token fails at the end.
>
> Detection reads *every* known v1 registration controller rather than the bundled
> `ETHRegistrarController` alone: reading one address would report a pristine chain as
> already-migrated if ENS ever rotated that controller, which would silently drop most of the
> rehearsal's assertions.

The rehearsal deploys into a `<network>-fork` namespace (gitignored, re-created each
run) rather than the live one, so it never tries to adopt the real chain's proxies —
pass `--deployment-network` to override. The managed URP's admin is read from chain
and impersonated, so `--ur-manager` is only needed when running without state
controls.

Options:

- `--direct` skips Anvil and targets `--rpc-url` directly (see
  [Tenderly virtual testnets](#tenderly-virtual-testnets)). It requires explicit `--deployer` and
  `--ur-manager` addresses, plus `--owner` on sepolia; the Hardhat `migration fork-full` task derives
  them from the keystore instead.
- `--resume-from-phase 2` (requires `--work-dir`) skips phase 1 and reloads saved deployments.
- `--snapshot-file` records a pre-rehearsal `evm_snapshot` id, which the Hardhat `migration revert`
  task can restore.

### `clean-testnet`

`clean-testnet` stands up a **complete, throwaway v1 → v2 migration on public Sepolia using a fresh v1
stack you fully own** — for integration testing or demos where you want a real, on-chain v1 + v2
migrated set without depending on, or risking, the canonical ENS deployment.

```bash
bun run migration -- clean-testnet --network sepolia --rpc-url <url> --deployer <address>
```

Sepolia only. It runs **phase 0** — a fresh v1 stack deployed into `deployments/v1/<namespace>` — then
phases 1–7 directly against the RPC, always including `TestnetV1PremigrationRegistrar`. The v2
namespace defaults to `sepolia-clean-<timestamp>`; the command refuses to reuse the canonical
`sepolia` namespace or any namespace that already contains deployment files. Without `--csv-file`,
only the generated smoke labels are seeded. Against an RPC without state controls (anything other than
a local node or a Tenderly virtual testnet) a configured deployer key is required — prefer the Hardhat
`migration clean-testnet` task, which signs with the configured Hardhat account.

Every persisted deploy writes `deployments/<namespace>/addresses.md` beside its artifacts — the same
table as [`docs/addresses/<network>.md`](./addresses), which only tracks a network's canonical
deployment. A `clean-testnet` namespace also gets a second section listing the ENSv1 contracts it
deployed, since the v1 stack lives in `deployments/v1/<namespace>`.

> **"Fresh v1" does not mean a fresh chain.** Only the ENS stack is deployed from scratch; the run
> still reads Sepolia contracts it does not deploy. `deploy/01_StandardRentPriceOracle.ts` reads
> `symbol()` and `decimals()` off the real Sepolia USDC, so on an empty local node that call returns
> `0x` and phase 1 dies in `decodeAbiParameters` with `AbiDecodingZeroDataError`. Point the command at
> real Sepolia, a Tenderly virtual testnet, or a **local Anvil forking Sepolia** — never a bare
> `anvil --chain-id 11155111`.

### Tenderly virtual testnets

Every command that impersonates signers also works against a **Tenderly Virtual TestNet** — an RPC
whose host is `virtual.<...>.rpc.tenderly.co`. The CLI **auto-detects** these (there is no `--tenderly`
flag) and uses Tenderly's state-control methods (`tenderly_setBalance`, `tenderly_impersonateAccount`,
time-travel) to fund and impersonate every account, so **no signer keys are needed**.

The main use is a **full dress rehearsal of a live network against a Tenderly live fork**: create a
Virtual TestNet that forks live Sepolia or mainnet (so the real v1 ENS state is present) and run the
whole migration against it in one command:

```bash
bun run migration -- fork full --direct --network sepolia \
  --rpc-url https://virtual.<...>.rpc.tenderly.co/<id> \
  --csv-file <fresh-sepolia.csv> \
  --deployer <address> --ur-manager <address> --owner <address>   # --owner required on sepolia
```

Mainnet works the same way (`--network mainnet`; it is a bootstrap URP network). Individual
[`phase`](#cli-commands) commands can likewise target a Tenderly RPC using their
`--impersonate-account` / `--impersonate-owner` / `--impersonate-v1-owner` flags instead of keys.

> `clean-testnet` also runs against a Tenderly virtual testnet, but it deploys a **fresh** v1 stack
> (phase 0) rather than migrating the forked live v1 — use `fork full --direct` to rehearse the real
> v1 → v2 migration of live Sepolia or mainnet.

## Reference

### Entry points

- **Operator CLI** — [`script/migration.ts`](../script/migration.ts), run as
  `bun run migration -- <command>` from `contracts/`. Each phase is an individual subcommand;
  `fork full` and `clean-testnet` run all phases end-to-end as rehearsals. The CLI auto-loads
  `contracts/.env` (already-set environment variables win).
- **Hardhat plugin** — [`plugins/migration/index.ts`](../plugins/migration/index.ts), registering
  `migration <task>` tasks that wrap the same phase functions but derive signers from the configured
  Hardhat network/keystore: `bunx hardhat --network <net> migration <task>`.
- **Phased deploy scripts** — the scripts under [`deploy/`](../deploy/) carry migration tags
  (`migration:phase1:deploy-v2`, `migration:phase5:switch-urp-to-managed`,
  `migration:phase6:upgrade-managed-urp`, `migration:post-cutover:direct-urp-to-v2`) so each on-chain
  change is bound to a deploy step. The tag strings are stable identifiers and do not track the phase
  numbering.

### Common options

Most commands share these option groups. Run `bun run migration -- <command> --help` for the
authoritative per-command list.

- **Network** (every on-chain command): `--network sepolia|mainnet` (required),
  `--rpc-url <url>` (falls back to `SEPOLIA_RPC_URL` / `MAINNET_RPC_URL`), `--chain-id <id>`.
- **Deployments**: `--deployments-dir <path>`, `--deployment-network <name>` (v2 addresses);
  `--v1-deployments-dir <path>`, `--v1-deployment-network <name>` (v1 addresses). Contract addresses
  default to the deployment JSON under these dirs; explicit address flags (e.g. `--registry`,
  `--batch-registrar`) override.
- **Owner-gated writes** (v1-owner and URP-admin phases): `--private-key <key>`, `--impersonate-owner`
  or `--impersonate-account <address>` (fork/Tenderly), `--calldata-only` (print the transaction
  target and calldata for multisig execution instead of broadcasting).

Two commands are **not** on-chain and intentionally omit the network options:

- **`premigration status`** reads the local checkpoint file only — its sole option is `--work-dir`.
  Passing `--network` / `--rpc-url` errors with `unknown option`.
- **`fetch-data`** queries TheGraph, not a chain — it has its own `--network` (default `mainnet`) and
  no `--rpc-url`.

### Deployment artifacts

Phase 1 reads and writes rocketh deployment artifacts under
[`deployments/`](../deployments/README.md), grouped into per-deployment **namespace** directories
selected with `--deployments-dir` / `--deployment-network` (v1 references via `--v1-deployments-dir` /
`--v1-deployment-network`).

`phase deploy-v2` **deploys fresh by default** — it archives the current namespace to
`deployments/<env>-<YYYYMMDD>-r<N>` and deploys into a clean one. Since phase 1 sends many
transactions and can be interrupted, re-run with `--resume` to continue into the existing namespace
instead (rocketh is idempotent, sending only the not-yet-deployed contracts). See
[`deployments/README.md`](../deployments/README.md) for the namespace layout, archiving, git-tracking,
and idempotency rules.

### CLI commands

| Command | Purpose |
| --- | --- |
| `fetch-data` | Export ENS registrations from the TheGraph subgraph (mainnet or sepolia) into a pre-migration CSV |
| `premigration run` | Start pre-migration reservations from a fresh checkpoint (phases 2/5) |
| `premigration resume` | Resume pre-migration from the checkpoint |
| `premigration status` | Print the current pre-migration checkpoint JSON (local; `--work-dir` only) |
| `premigration verify` | Verify eligible CSV names were reserved or registered on v2 (CSV-scoped; superseded as the phase 2/5 gate by `reconcile`) |
| `premigration build-index` | Build an independent labelhash-keyed index of v1 names, from the subgraph or from v1 `BaseRegistrar` logs (`--source subgraph\|rpc`; `--resume` continues a partial build) |
| `premigration index-status` | Print the local v1 name index metadata (local; `--work-dir` only) |
| `premigration reconcile` | Reconcile the v1 name index against v2 in both directions — the phase 2/5 sign-off (`--check-fuses` also counts names `CANNOT_TRANSFER` makes unclaimable; needs `--csv-file` for the labels) |
| `fixture verify` | Offline: validate a fixture selection and plan every scenario's calls |
| `fixture fund-actors` | Top up the fixture actor accounts from the operator key |
| `fixture deploy-fixtures` | Deploy the fixture batcher and the corpus counterparty contracts |
| `fixture seed-v1` | Register the ENSv1 fixture corpus, shape each name's pre-migration state, and emit the label subset pre-migration reserves (after phase 1, before phase 3) |
| `fixture verify-v1` | Read the shaped v1 state back and check it against each scenario (after `seed-v1`) |
| `phase deploy-v2` | Phase 1: deploy the v2 migration contracts, reverse-registrar adapters, and enabled HCA infrastructure with the registrar deferred; archives any existing namespace and deploys fresh by default (`--resume` continues an interrupted deploy) |
| `phase reclaim-v1-registrar-ownership` | Re-migration only: reclaim v1 `BaseRegistrar` ownership from a prior deployment's `ETHRenewerV1` back to the v1 owner (run before the phase-1 deferred-tx replay on an already-migrated chain) |
| `phase disable-v1-registrars` | Phase 3: revoke every v1 authorization (BaseRegistrar + reverse registrars) the active deployment did not grant |
| `phase set-v1-reverse-default-resolver` | Point the v1 `ReverseRegistrar` default resolver at the v1 `PublicResolver` (v1-owner write) |
| `phase verify-v1-registrars-disabled` | Verify no v1 authorization outside the active deployment is enabled (`--require-active-grants` also asserts the active deployment's own grants are present — run it after phase 4) |
| `phase verify-reverse-adapters` | Verify the active reverse-registrar adapters hold their v1 controller grants and point back at the right registrar |
| `phase verify-roles` | Audit who holds which roles on the v2 registries against the deployment's intent, in both directions |
| `phase verify-deployment` | Verify the code at every address in the namespace matches its artifact |
| `phase verify-registrar-economics` | Verify the registrar can price and take payment: oracle, beneficiary, accepted tokens |
| `phase authorize-v1-renewer` | Phase 4: authorize `ETHRenewerV1` as a v1 controller |
| `phase verify-v1-renewer` | Verify `ETHRenewerV1` is a v1 controller **and** owns the v1 `BaseRegistrar`, which is what a renewal needs |
| `phase execute-owner-txs` | Execute prepared owner transactions from a JSONL file (optionally filtered by `--role`); each success is journalled so a re-run does not re-send it |
| `phase verify-owner-tx` | Check a transaction about to be signed in a Safe against the prepared owner transactions |
| `phase disable-batch-registrar` | Phase 6: revoke registrar/renew roles from `BatchRegistrar` |
| `phase verify-batch-registrar-disabled` | Verify `BatchRegistrar` no longer has registrar/renew roles |
| `phase batch-registrar-owner` | Print and optionally verify the `BatchRegistrar` owner |
| `phase activate-v1-handoff-controllers` | Phase 4: authorize `Graveyard` + testnet helper as v1 controllers |
| `phase activate-v1-graveyard` | Phase 4 (individual): authorize `Graveyard` only |
| `phase authorize-testnet-v1-premigration-registrar` | Phase 4 (individual, testnet): authorize the testnet premigration helper |
| `phase activate-v1-renewer` | Phase 4: transfer v1 `BaseRegistrar` ownership to `ETHRenewerV1`, which is what makes renewals work (final v1 lock-down) |
| `phase enable-v2-registrar` | Phase 6: grant registrar/renew roles to `ETHRegistrar` |
| `phase verify-v2-registrar` | Verify `ETHRegistrar` has registrar/renew roles |
| `phase switch-urp-to-managed` | Phase 7 (bootstrap only): point the top URP at the managed URP |
| `phase upgrade-managed-urp` | Phase 7: upgrade the managed URP to `UniversalResolverV2` (resolution cutover) |
| `phase verify-urp` | Verify top and managed URP implementations |
| `phase snapshot-resolution` | Record how names resolve before the cutover (`addr`, coin types, text keys, contenthash) |
| `phase verify-resolution` | Re-resolve a snapshot's names and fail on any record that changed |
| `fork full` | Run the full phased migration rehearsal against an Anvil fork (or a Tenderly fork with `--direct`) |
| `clean-testnet` | Deploy fresh testnet v1 contracts and run the full phased migration (sepolia only) |

### Hardhat plugin tasks

```bash
bunx hardhat --network <net> migration <task> [--options]
```

The tasks select the migration network with `--migration-network sepolia|mainnet` and use the Hardhat
network's RPC and configured signer (so private keys can come from the Hardhat keystore instead of
flags/env). See `bunx hardhat migration <task> --help` for options.

| Task | Purpose |
| --- | --- |
| `snapshot` | Create an RPC state snapshot (`evm_snapshot`), optionally writing the id to `--file` |
| `revert` | Revert to a snapshot id (from `--snapshot-id` or `--file`) |
| `verify-all` | Verify final migration wiring plus resolution smoke checks against `--names` |
| `batch-registrar-owner` | Print and optionally verify the `BatchRegistrar` owner |
| `fork-full` | Run the full phased migration rehearsal (Hardhat-signer variant of `fork full`) |
| `clean-testnet` | Deploy fresh testnet v1 and run the full phased migration |
| `smoke-v2-registrar` | Register a fresh `.eth` name through the enabled v2 registrar |
| `set-v1-reverse-default-resolver` | Point the v1 `ReverseRegistrar` default resolver at the v1 `PublicResolver` |
| `deploy-v2` | Deploy the v2 migration contracts (phase 1) |
| `premigration-run` | Run pre-migration reservations (phases 2/5) with the Hardhat signer as BatchRegistrar owner |

### Environment variables

| Variable | Used for |
| --- | --- |
| `SEPOLIA_RPC_URL` / `MAINNET_RPC_URL` | Default RPC when `--rpc-url` is omitted |
| `DEPLOYER_KEY` | Deployer key (`phase deploy-v2`); fallback for owner/urManager keys |
| `OWNER_KEY` | Owner / registry root-role admin (`phase deploy-v2`, `disable-batch-registrar`, `enable-v2-registrar`; falls back to `DEPLOYER_KEY`) |
| `UR_MANAGER_KEY` | Intermediate URP admin (`phase upgrade-managed-urp`; falls back to `DEPLOYER_KEY`) |
| `SEPOLIA_V1_OWNER_KEY` / `V1_OWNER_KEY` | v1 owner (`disable-v1-registrars` †, `set-v1-reverse-default-resolver`, `authorize-v1-renewer`, `activate-v1-*`, `authorize-testnet-v1-premigration-registrar`) |
| `SEPOLIA_TOP_URP_OWNER_KEY` / `TOP_URP_OWNER_KEY` | Top URP admin (`phase switch-urp-to-managed`, bootstrap networks only) |
| `OWNER_TX_KEY` | Generic signer for `phase execute-owner-txs` when no role-specific key matches |
| `HCA_INTENT_EXECUTOR` | Optional intent-executor override; live/forked Sepolia defaults to the fixed Rhinestone address in `script/deploy-constants.ts` |
| `HCA_ENTRY_POINT` | Optional HCA ERC-4337 EntryPoint override |
| `HCA_GAS_REFUND_PAYMASTER` | Optional HCA validator gas-refund paymaster override |
| `<PREFIX>_MNEMONIC`, `<PREFIX>_MNEMONIC_PATH`, `<PREFIX>_MNEMONIC_INDEX`, `<PREFIX>_MNEMONIC_PASSPHRASE` | Mnemonic-backed signer alternatives for `phase execute-owner-txs`; prefixes `OWNER_TX`, `SEPOLIA_V1_OWNER` / `V1_OWNER`, `SEPOLIA_TOP_URP_OWNER` / `TOP_URP_OWNER` |
| `PREMIGRATION_PRIVATE_KEY`, `BATCH_REGISTRAR_OWNER_KEY`, `DEPLOYER_KEY` | BatchRegistrar owner key fallbacks for `premigration run` / `resume` |
| `MIGRATION_FIXTURE_ACTOR_MNEMONIC` | Dedicated mnemonic for the five `fixture` actor accounts — never reuse a mnemonic held elsewhere |
| `MIGRATION_FIXTURE_PRIVATE_KEY` | Fixture operator key (`fixture` commands) when `--private-key` is omitted |
| `MIGRATION_FIXTURE_V1_OWNER` | v1 owner address used only when `fixture seed-v1` finds v1 registration already frozen |
| `MIGRATION_FIXTURE_COMMIT_BATCH_SIZE`, `MIGRATION_FIXTURE_REGISTER_BATCH_SIZE` | Fixture registration batch sizes (default 80 and 12) |
| `THEGRAPH_API_KEY` / `GRAPH_API_KEY` | TheGraph Gateway key for `fetch-data` and `premigration build-index --source subgraph` (unused by `--source rpc`) |
| `ETHERSCAN_API_KEY` | Etherscan v2 (multichain) API key for source-code verification (`bun run verify:<network>`); not needed for Sourcify |

† `phase disable-v1-registrars` takes the key via `--private-key`; the env fallbacks apply when it is
executed through `phase execute-owner-txs` with `--role v1Owner`. For `phase execute-owner-txs`, the
key is selected by the `--role` filter: `v1Owner` → the v1-owner variables, `sepolia-top-urp-owner` →
the top-URP-owner variables, `deployer` → `DEPLOYER_KEY`; with no role, `OWNER_TX_KEY` then the
role-specific variables are tried in order.

## Related docs

- [premigration.md](./premigration.md) — the `BatchRegistrar` seeding step in detail (phases 2 and 5):
  CSV format, continuity expiry, checkpoints, verification.
- [universalResolver.md](./universalResolver.md) — the URP proxy chain behind phase 7, and the
  post-cutover step.
- [prepareMigration.md](./prepareMigration.md) — the non-phased, all-at-once role hand-off script that
  phase 6 supersedes.
- [deployments/README.md](../deployments/README.md) — deployment artifact layout, namespace naming,
  and the idempotency rule for fresh re-deploys.
