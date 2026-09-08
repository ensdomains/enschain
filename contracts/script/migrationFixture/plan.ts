import {
  encodeFunctionData,
  keccak256,
  namehash,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import {
  isChild,
  isWrapped,
  ownerControlledFuses,
  preMigrationOwnerAlias,
  resolveFuses,
  resolveOptionalRef,
  resolveRef,
  stripActorPrefix,
  v1Form,
  type RefContext,
} from "./scenario.js";
import {
  FUSES,
  type FixtureEnvelope,
  type RecordSpec,
  type SetupStep,
} from "./types.js";

/// Minimal explicit ABIs. The deployed PublicResolver exposes overloaded
/// `setAddr`, which viem cannot disambiguate from a full artifact ABI, so the
/// two arities are declared separately.
const RESOLVER_ABI = [
  {
    type: "function",
    name: "setAddr",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "a", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setText",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
      { name: "value", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setContenthash",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "hash", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const RESOLVER_MULTICOIN_ABI = [
  {
    type: "function",
    name: "setAddr",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "coinType", type: "uint256" },
      { name: "a", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const REGISTRY_ABI = [
  {
    type: "function",
    name: "setResolver",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "resolver", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setTTL",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "ttl", type: "uint64" },
    ],
    outputs: [],
  },
] as const;

const WRAPPER_ABI = [
  {
    type: "function",
    name: "wrapETH2LD",
    stateMutability: "nonpayable",
    inputs: [
      { name: "label", type: "string" },
      { name: "wrappedOwner", type: "address" },
      { name: "ownerControlledFuses", type: "uint16" },
      { name: "resolver", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "unwrapETH2LD",
    stateMutability: "nonpayable",
    inputs: [
      { name: "labelhash", type: "bytes32" },
      { name: "registrant", type: "address" },
      { name: "controller", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setSubnodeRecord",
    stateMutability: "nonpayable",
    inputs: [
      { name: "parentNode", type: "bytes32" },
      { name: "label", type: "string" },
      { name: "owner", type: "address" },
      { name: "resolver", type: "address" },
      { name: "ttl", type: "uint64" },
      { name: "fuses", type: "uint32" },
      { name: "expiry", type: "uint64" },
    ],
    outputs: [{ name: "node", type: "bytes32" }],
  },
  {
    type: "function",
    name: "setFuses",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "ownerControlledFuses", type: "uint16" },
    ],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "setResolver",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "resolver", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setTTL",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "ttl", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const ERC721_ABI = [
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reclaim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "owner", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

const ERC1155_ABI = [
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const REVERSE_REGISTRAR_ABI = [
  {
    type: "function",
    name: "setName",
    stateMutability: "nonpayable",
    inputs: [{ name: "name", type: "string" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const CONTROLLER_RENEW_ABI = [
  {
    type: "function",
    name: "renew",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "duration", type: "uint256" },
      { name: "referrer", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/// Who must sign a planned call. `batcher` means the MigrationFixtureBatcher,
/// which can be aggregated; an actor alias means a direct wallet transaction
/// because the action's authority or its emitted provenance depends on caller.
export type Signer = { kind: "batcher" } | { kind: "actor"; alias: string };

/// A price the planner cannot know. Planning is offline and pure — it runs
/// against placeholder addresses in `fixture verify` — so a call whose value
/// comes from a live contract quote carries the query instead of the amount,
/// and the executor resolves it just before sending.
export type CallQuote = { kind: "renew"; label: string; duration: bigint };

export type PlannedCall = {
  signer: Signer;
  target: Address;
  value: bigint;
  data: Hex;
  allowFailure: boolean;
  label: string;
  quote?: CallQuote;
};

export type PlanContext = RefContext & {
  batcher: Address;
  addresses: {
    baseRegistrar: Address;
    registry: Address;
    wrapper: Address;
    controller: Address;
    publicResolver: Address;
    reverseRegistrar: Address;
    defaultReverseRegistrar: Address;
  };
};

const BATCHER: Signer = { kind: "batcher" };
const actorSigner = (alias: string): Signer => ({ kind: "actor", alias });

export function labelhashOf(label: string): Hex {
  return keccak256(stringToHex(label));
}

export function tokenIdOf(label: string): bigint {
  return BigInt(labelhashOf(label));
}

/// Calls that move a v1 name to a new holder.
///
/// An unwrapped name lives in two places: the ERC-721 registration and the
/// registry record the registrar can rewrite. The reclaim runs first, while the
/// sender is still authorised over the token, so it can point the registry at
/// the recipient itself; reclaiming after the transfer would need a signature
/// from the recipient, which a handover to an address we hold no key for cannot
/// produce. A wrapped name carries both in its ERC-1155 balance, so one
/// transfer is the whole move.
///
/// The ERC-721 move is the plain transfer rather than the safe one: the receipt
/// hook adds nothing for the accounts the corpus hands names to, and refusing a
/// recipient is the job of the one check made before any name moves.
///
/// `signer` and `from` are separate because an approved operator may send on
/// the holder's behalf, which is how a whole cohort moves in batches instead of
/// one transaction per name.
export function transferNameCalls(args: {
  wrapped: boolean;
  signer: Signer;
  from: Address;
  to: Address;
  tokenId: bigint;
  node: Hex;
  addresses: PlanContext["addresses"];
  label: string;
}): PlannedCall[] {
  const { wrapped, signer, from, to, tokenId, node, addresses, label } = args;
  const call = (target: Address, suffix: string, data: Hex): PlannedCall => ({
    signer,
    target,
    value: 0n,
    allowFailure: false,
    label: `${label} ${suffix}`,
    data,
  });

  if (wrapped) {
    return [
      call(
        addresses.wrapper,
        "wrapper transfer",
        encodeFunctionData({
          abi: ERC1155_ABI,
          functionName: "safeTransferFrom",
          args: [from, to, BigInt(node), 1n, "0x"],
        }),
      ),
    ];
  }
  return [
    call(
      addresses.baseRegistrar,
      "reclaim",
      encodeFunctionData({
        abi: ERC721_ABI,
        functionName: "reclaim",
        args: [tokenId, to],
      }),
    ),
    call(
      addresses.baseRegistrar,
      "transfer",
      encodeFunctionData({
        abi: ERC721_ABI,
        functionName: "transferFrom",
        args: [from, to, tokenId],
      }),
    ),
  ];
}

/// Ownership of a fixture name over the course of its setup. Names are
/// registered to the batcher, handed to the scenario's initial owner, and may
/// move again via `transfer_registrant`; each planned call records the actor
/// who is authorised at that point.
class OwnershipCursor {
  constructor(private current: string) {}
  get alias(): string {
    return this.current;
  }
  set(alias: string) {
    this.current = alias;
  }
}

function recordCalls(
  resolver: Address,
  node: Hex,
  records: readonly RecordSpec[],
  ctx: PlanContext,
  signer: Signer,
  labelPrefix: string,
): PlannedCall[] {
  const calls: PlannedCall[] = [];
  for (const record of records) {
    if (record.kind === "addr") {
      const coinType = record.coin_type ?? 60;
      const value = recordValue(record, ctx);
      calls.push({
        signer,
        target: resolver,
        value: 0n,
        allowFailure: false,
        label: `${labelPrefix} setAddr(${coinType})`,
        data:
          coinType === 60
            ? encodeFunctionData({
                abi: RESOLVER_ABI,
                functionName: "setAddr",
                args: [node, value as Address],
              })
            : encodeFunctionData({
                abi: RESOLVER_MULTICOIN_ABI,
                functionName: "setAddr",
                args: [node, BigInt(coinType), value as Hex],
              }),
      });
    } else if (record.kind === "text") {
      calls.push({
        signer,
        target: resolver,
        value: 0n,
        allowFailure: false,
        label: `${labelPrefix} setText(${record.key})`,
        data: encodeFunctionData({
          abi: RESOLVER_ABI,
          functionName: "setText",
          args: [node, record.key ?? "", recordValue(record, ctx)],
        }),
      });
    } else if (record.kind === "contenthash") {
      calls.push({
        signer,
        target: resolver,
        value: 0n,
        allowFailure: false,
        label: `${labelPrefix} setContenthash`,
        data: encodeFunctionData({
          abi: RESOLVER_ABI,
          functionName: "setContenthash",
          args: [node, recordValue(record, ctx) as Hex],
        }),
      });
    } else {
      throw new Error(`unknown record kind "${(record as RecordSpec).kind}"`);
    }
  }
  return calls;
}

/// Plans every V1 setup call for one fixture row, in corpus order.
///
/// The name is registered to the batcher, so calls that only need registry or
/// resolver authority are planned as batcher calls and can be aggregated. Calls
/// whose effect is derived from `msg.sender` — reverse claims — or which grant
/// authority on behalf of the holder — operator and token approvals — are
/// planned against the actor that must sign them.
/// Steps that address the scenario's own node. For a child scenario that node
/// only exists once the child has been created.
const NODE_SCOPED_ACTIONS = new Set([
  "set_ttl",
  "set_resolver",
  "write_records",
  "set_text",
  "clear_records",
  "approve_wrapper_token_before_burning_cannot_approve",
]);

const APPROVE_BEFORE_BURN =
  "approve_wrapper_token_before_burning_cannot_approve";

/// Steps that leave the name wrapped, so the wrapper token exists afterwards.
const WRAPPING_ACTIONS = new Set([
  "wrap_2ld",
  "ensure_wrapped_2ld",
  "ensure_wrapped_parent_and_child",
]);

/// Orders a child scenario's setup so the child exists before anything writes to
/// it.
///
/// Several scenarios list a record history ahead of the step that creates the
/// child, which cannot be carried out in that order — the node has no owner yet,
/// so the resolver rejects the write. Only the creation step moves, and only as
/// far as the first step that needs it, so steps that must precede it (renewing
/// the 2LD before it is wrapped, for instance) keep their place, and the history
/// keeps its own sequence on the child.
function orderedSetupSteps(steps: SetupStep[], child: boolean): SetupStep[] {
  const ordered = child ? orderedChildSteps(steps) : steps;
  return orderedApproveSteps(ordered);
}

function orderedChildSteps(steps: SetupStep[]): SetupStep[] {
  const create = steps.findIndex(
    (s) => s.action === "ensure_wrapped_parent_and_child",
  );
  const firstNodeScoped = steps.findIndex((s) =>
    NODE_SCOPED_ACTIONS.has(s.action),
  );
  if (create < 0 || firstNodeScoped < 0 || create < firstNodeScoped) {
    return steps;
  }
  const rest = steps.filter((_, i) => i !== create);
  return [
    ...rest.slice(0, firstNodeScoped),
    steps[create],
    ...rest.slice(firstNodeScoped),
  ];
}

/// Moves an approval of the wrapper token to just after the step that creates
/// it. The wrapper token does not exist until the name is wrapped, so a
/// scenario listing the approval first cannot be carried out in that order.
/// The wrap step withholds `CANNOT_APPROVE` when this step follows it, so the
/// approval still lands before the fuse that would forbid it.
function orderedApproveSteps(steps: SetupStep[]): SetupStep[] {
  const approve = steps.findIndex((s) => s.action === APPROVE_BEFORE_BURN);
  if (approve < 0) return steps;
  const wrap = steps.findIndex((s) => WRAPPING_ACTIONS.has(s.action));
  if (wrap < 0 || approve > wrap) return steps;
  const rest = steps.filter((_, i) => i !== approve);
  const wrapAfter = rest.findIndex((s) => WRAPPING_ACTIONS.has(s.action));
  return [
    ...rest.slice(0, wrapAfter + 1),
    steps[approve],
    ...rest.slice(wrapAfter + 1),
  ];
}

/// Identity of a record slot, so a later write can be recognised as replacing
/// an earlier one.
function recordKey(record: RecordSpec): string {
  if (record.kind === "addr") return `addr/${record.coin_type ?? 60}`;
  if (record.kind === "text") return `text/${record.key ?? ""}`;
  return record.kind;
}

/// The value a record write lands.
///
/// The call encoder and the bookkeeping that reconciles the final state both
/// read this, so neither can resolve a record differently from the other.
///
/// A multicoin address is `bytes`, not an `address`: the corpus carries the
/// target chain's own encoding in the hex field, and substituting a 20-byte
/// Ethereum address for it seeds the coin type with a value the scenario never
/// declared — which reads back as present, so nothing notices.
export function recordValue(record: RecordSpec, ctx: RefContext): string {
  if (record.kind === "addr") {
    const declared = record.value_actor ?? record.value;
    if ((record.coin_type ?? 60) === 60)
      return resolveOptionalRef(declared, ctx);
    return record.value_hex ?? (declared ? resolveRef(declared, ctx) : "0x");
  }
  if (record.kind === "contenthash")
    return record.value_hex ?? record.value ?? "0x";
  return record.value ?? "";
}

/// The empty write that clears a record slot.
///
/// A record is cleared by writing the empty value its setter accepts, so every
/// value the corpus declared for the slot has to be dropped. Carrying a
/// contenthash's raw bytes through would make the clear re-write exactly what it
/// exists to remove, and an all-zero address is a present value for a multicoin
/// slot rather than an absent one.
export function clearedRecord(record: RecordSpec): RecordSpec {
  const slot = {
    kind: record.kind,
    coin_type: record.coin_type,
    key: record.key,
  };
  if (record.kind === "text") return { ...slot, value: "" };
  if (record.kind === "addr" && (record.coin_type ?? 60) === 60)
    return { ...slot, value: zeroAddress };
  return { ...slot, value_hex: "0x" };
}

export function planSetupSteps(
  row: FixtureEnvelope,
  ctx: PlanContext,
): PlannedCall[] {
  const scenario = row.scenario;
  const form = v1Form(scenario);
  const wrapped = isWrapped(form);
  const child = isChild(form);
  const label = scenario.top_level_label;
  const node = namehash(scenario.name) as Hex;
  const topNode = namehash(`${label}.eth`) as Hex;
  const tokenId = tokenIdOf(label);
  const calls: PlannedCall[] = [];

  const registrationOwner = stripActorPrefix(
    scenario.v1.registration.owner_actor ?? preMigrationOwnerAlias(scenario),
  );
  const cursor = new OwnershipCursor(registrationOwner);

  // While the batcher still holds the ERC-721, node-scoped writes are cheapest
  // and are authorised by the registry controller it already is.
  let heldByBatcher = true;
  const nodeSigner = (): Signer =>
    heldByBatcher ? BATCHER : actorSigner(cursor.alias);

  const registrationResolver = resolveOptionalRef(
    scenario.v1.registration.resolver_ref,
    ctx,
  );

  // Whether the name is wrapped at this point in the plan. A wrapped name is
  // owned in the registry by the NameWrapper, so resolver writes have to go
  // through the wrapper instead; the scenario's final form is not enough to
  // decide, because wrapping happens partway through.
  let wrappedNow = false;

  // The resolver and record values the plan has already put on the node, so the
  // closing reconciliation only writes what actually differs.
  let currentResolver = registrationResolver;
  const pushSetResolver = (resolver: Address, callLabel: string) => {
    calls.push({
      signer: nodeSigner(),
      target: wrappedNow ? ctx.addresses.wrapper : ctx.addresses.registry,
      value: 0n,
      allowFailure: false,
      label: callLabel,
      data: encodeFunctionData({
        abi: wrappedNow ? WRAPPER_ABI : REGISTRY_ABI,
        functionName: "setResolver",
        args: [node, resolver],
      }),
    });
    // Records live on the resolver contract, so anything written to the old one
    // is no longer readable through the name. Forgetting them makes the closing
    // reconciliation re-write whatever the target state still expects.
    if (resolver !== currentResolver) writtenRecords.clear();
    currentResolver = resolver;
  };
  const writtenRecords = new Map<string, RecordSpec>();
  const noteRecords = (records: RecordSpec[]) => {
    for (const record of records) {
      writtenRecords.set(recordKey(record), record);
    }
  };

  // Baseline resolver and records from the registration block. These describe
  // the name as first registered; later steps mutate it. For a child scenario
  // the node does not exist until the step that creates it, so the baseline is
  // deferred until then rather than written against an unowned node.
  const registrationRecords = scenario.v1.registration.records ?? [];
  const emitRegistrationState = () => {
    if (registrationResolver === zeroAddress) return;
    // A name that gets wrapped later takes its resolver from the wrap call, so
    // only names that are already in their resolver-bearing form set it here.
    if (!wrapped || wrappedNow) {
      pushSetResolver(
        registrationResolver,
        `${row.fixture_id} registration setResolver`,
      );
    }
    if (registrationRecords.length) {
      calls.push(
        ...recordCalls(
          registrationResolver,
          node,
          registrationRecords,
          ctx,
          nodeSigner(),
          `${row.fixture_id} registration`,
        ),
      );
      noteRecords(registrationRecords);
    }
  };
  if (!child) emitRegistrationState();

  const setupSteps = orderedSetupSteps(scenario.v1.setup_steps ?? [], child);
  // A scenario that approves the wrapper token must do so while approval is
  // still permitted, so the wrap withholds CANNOT_APPROVE and the approval step
  // burns it once the approval is in place.
  const approvesBeforeBurn = setupSteps.some(
    (s) => s.action === APPROVE_BEFORE_BURN,
  );
  let deferredFuses = 0;
  for (const [index, step] of setupSteps.entries()) {
    const tag = `${row.fixture_id}#${index} ${step.action}`;
    switch (step.action) {
      case "set_ttl": {
        const ttl = BigInt(step.ttl ?? 0);
        calls.push({
          signer: nodeSigner(),
          target: wrappedNow ? ctx.addresses.wrapper : ctx.addresses.registry,
          value: 0n,
          allowFailure: false,
          label: tag,
          data: encodeFunctionData({
            abi: wrappedNow ? WRAPPER_ABI : REGISTRY_ABI,
            functionName: "setTTL",
            args: [node, ttl],
          }),
        });
        break;
      }

      case "set_resolver": {
        // Reordering a child's creation ahead of its history can leave this
        // step asking for the resolver the creating step already set. Rewriting
        // it is not merely redundant: the same step may burn
        // CANNOT_SET_RESOLVER, which forbids the write.
        const resolver = resolveRef(step.resolver_ref, ctx);
        if (resolver !== currentResolver) pushSetResolver(resolver, tag);
        break;
      }

      case "write_records": {
        const resolver = resolveRef(step.resolver_ref, ctx);
        calls.push(
          ...recordCalls(
            resolver,
            node,
            step.records ?? [],
            ctx,
            nodeSigner(),
            tag,
          ),
        );
        if (resolver === currentResolver) noteRecords(step.records ?? []);
        break;
      }

      case "set_text": {
        noteRecords([
          {
            kind: "text",
            key: String(step.key ?? ""),
            value: String(step.value ?? ""),
          },
        ]);
        calls.push({
          signer: nodeSigner(),
          target: ctx.addresses.publicResolver,
          value: 0n,
          allowFailure: false,
          label: tag,
          data: encodeFunctionData({
            abi: RESOLVER_ABI,
            functionName: "setText",
            args: [node, String(step.key ?? ""), String(step.value ?? "")],
          }),
        });
        break;
      }

      // Deletion is an explicit write of an empty value so the operation stays
      // in resolver history rather than merely being forgotten locally.
      case "clear_records": {
        // Cleared from what the plan has written so far, not from the corpus's
        // static record list: earlier steps add slots the static list never
        // mentions, and those would survive a clear that is meant to empty the
        // resolver.
        const cleared = [...writtenRecords.values()].map(clearedRecord);
        calls.push(
          ...recordCalls(
            ctx.addresses.publicResolver,
            node,
            cleared,
            ctx,
            nodeSigner(),
            tag,
          ),
        );
        noteRecords(cleared);
        break;
      }

      // An ERC-721 transfer alone leaves the registry controller stale, so the
      // reclaim is part of the action rather than an optional follow-up.
      case "transfer_registrant": {
        const to = stripActorPrefix(step.to_actor);
        const toAddress = resolveRef(to, ctx);
        const fromAddress = heldByBatcher
          ? ctx.batcher
          : resolveRef(cursor.alias, ctx);
        calls.push({
          signer: heldByBatcher ? BATCHER : actorSigner(cursor.alias),
          target: ctx.addresses.baseRegistrar,
          value: 0n,
          allowFailure: false,
          label: `${tag} transfer`,
          data: encodeFunctionData({
            abi: ERC721_ABI,
            functionName: "safeTransferFrom",
            args: [fromAddress, toAddress, tokenId],
          }),
        });
        calls.push({
          signer: actorSigner(to),
          target: ctx.addresses.baseRegistrar,
          value: 0n,
          allowFailure: false,
          label: `${tag} reclaim`,
          data: encodeFunctionData({
            abi: ERC721_ABI,
            functionName: "reclaim",
            args: [tokenId, toAddress],
          }),
        });
        heldByBatcher = false;
        cursor.set(to);
        break;
      }

      case "renew_v1": {
        const duration = BigInt(step.duration_seconds ?? 0);
        // Renewal is priced by the controller, so the amount is resolved from a
        // live quote at execution time rather than planned.
        calls.push({
          signer: BATCHER,
          target: ctx.addresses.controller,
          value: 0n,
          quote: { kind: "renew", label, duration },
          allowFailure: false,
          label: `${tag}:renew:${label}:${step.duration_seconds}`,
          data: encodeFunctionData({
            abi: CONTROLLER_RENEW_ABI,
            functionName: "renew",
            args: [label, duration, `0x${"00".repeat(32)}` as Hex],
          }),
        });
        break;
      }

      case "wrap_2ld":
      case "ensure_wrapped_2ld": {
        const owner = stripActorPrefix(
          step.wrapped_owner_actor ?? cursor.alias,
        );
        const declared = ownerControlledFuses(resolveFuses(step));
        // Burning CANNOT_APPROVE here would forbid the approval this scenario
        // still has to make, so it is held back until the approval lands.
        const withheld =
          approvesBeforeBurn && declared & FUSES.CANNOT_APPROVE
            ? FUSES.CANNOT_APPROVE
            : 0;
        const fuses = declared & ~withheld;
        deferredFuses |= withheld;
        const resolver = resolveOptionalRef(step.resolver_ref, ctx);
        // The batcher holds the ERC-721 and must approve the wrapper before it
        // can wrap. Owner, fuses and resolver are all set by this single call,
        // so the resolver is in place before CANNOT_SET_RESOLVER can bite.
        calls.push({
          signer: heldByBatcher ? BATCHER : actorSigner(cursor.alias),
          target: ctx.addresses.baseRegistrar,
          value: 0n,
          allowFailure: false,
          label: `${tag} approve wrapper`,
          data: encodeFunctionData({
            abi: ERC721_ABI,
            functionName: "setApprovalForAll",
            args: [ctx.addresses.wrapper, true],
          }),
        });
        calls.push({
          signer: heldByBatcher ? BATCHER : actorSigner(cursor.alias),
          target: ctx.addresses.wrapper,
          value: 0n,
          allowFailure: false,
          label: `${tag} wrapETH2LD`,
          data: encodeFunctionData({
            abi: WRAPPER_ABI,
            functionName: "wrapETH2LD",
            args: [label, resolveRef(owner, ctx), fuses, resolver],
          }),
        });
        if (resolver !== zeroAddress) currentResolver = resolver;
        wrappedNow = true;
        heldByBatcher = false;
        cursor.set(owner);
        break;
      }

      case "unwrap_2ld": {
        const to = resolveRef(cursor.alias, ctx);
        calls.push({
          signer: actorSigner(cursor.alias),
          target: ctx.addresses.wrapper,
          value: 0n,
          allowFailure: false,
          label: tag,
          data: encodeFunctionData({
            abi: WRAPPER_ABI,
            functionName: "unwrapETH2LD",
            args: [labelhashOf(label), to, to],
          }),
        });
        wrappedNow = false;
        break;
      }

      // Parent is wrapped to the batcher so it can mint the child with the
      // exact fuse/expiry shape, then both tokens are handed to the actor.
      case "ensure_wrapped_parent_and_child": {
        const owner = stripActorPrefix(
          step.wrapped_owner_actor ?? cursor.alias,
        );
        const ownerAddress = resolveRef(owner, ctx);
        // NameWrapper refuses to burn an owner-controlled fuse on a subname
        // unless the name is emancipated in the same breath, so a scenario that
        // names only the owner-controlled bits still has to burn
        // PARENT_CANNOT_CONTROL. Emancipation is implied by locking rather than
        // a change of intent; scenarios that ask only for parent-controlled
        // fuses are left exactly as declared. The 2LD path needs no equivalent:
        // wrapping a `.eth` name emancipates it anyway.
        const declaredChildFuses = resolveFuses(step);
        const childFuses = ownerControlledFuses(declaredChildFuses)
          ? declaredChildFuses | FUSES.PARENT_CANNOT_CONTROL
          : declaredChildFuses;
        const resolver = resolveOptionalRef(step.resolver_ref, ctx);
        const childLabel = scenario.child_label;
        if (!childLabel) {
          throw new Error(
            `${row.fixture_id}: child scenario without child_label`,
          );
        }
        calls.push({
          signer: BATCHER,
          target: ctx.addresses.baseRegistrar,
          value: 0n,
          allowFailure: false,
          label: `${tag} approve wrapper`,
          data: encodeFunctionData({
            abi: ERC721_ABI,
            functionName: "setApprovalForAll",
            args: [ctx.addresses.wrapper, true],
          }),
        });
        calls.push({
          signer: BATCHER,
          target: ctx.addresses.wrapper,
          value: 0n,
          allowFailure: false,
          label: `${tag} wrap parent`,
          data: encodeFunctionData({
            abi: WRAPPER_ABI,
            functionName: "wrapETH2LD",
            args: [label, ctx.batcher, FUSES.CANNOT_UNWRAP, resolver],
          }),
        });
        // Child expiry is clamped to the parent's by NameWrapper; passing the
        // maximum lets it take the parent value rather than guessing one.
        calls.push({
          signer: BATCHER,
          target: ctx.addresses.wrapper,
          value: 0n,
          allowFailure: false,
          label: `${tag} setSubnodeRecord`,
          data: encodeFunctionData({
            abi: WRAPPER_ABI,
            functionName: "setSubnodeRecord",
            args: [
              topNode,
              childLabel,
              ownerAddress,
              resolver,
              0n,
              childFuses,
              BigInt("0xffffffffffffffff"),
            ],
          }),
        });
        if (resolver !== zeroAddress) currentResolver = resolver;
        wrappedNow = true;
        heldByBatcher = false;
        cursor.set(owner);
        // The child exists now, so its registration baseline can be written.
        emitRegistrationState();
        break;
      }

      // Approval must come from the holder, so this is always actor-signed.
      case "set_operator_approval": {
        const token = resolveRef(step.token_contract, ctx);
        const operator = resolveRef(step.operator_ref, ctx);
        calls.push({
          signer: actorSigner(cursor.alias),
          target: token,
          value: 0n,
          allowFailure: false,
          label: tag,
          data: encodeFunctionData({
            abi: ERC721_ABI,
            functionName: "setApprovalForAll",
            args: [operator, Boolean(step.approved ?? true)],
          }),
        });
        break;
      }

      // Installs the stale approval that the following fuse burn freezes; this
      // is the precondition for the locked migration FrozenTokenApproval guard.
      case "approve_wrapper_token_before_burning_cannot_approve": {
        const approved = resolveRef(stripActorPrefix(step.approved_actor), ctx);
        calls.push({
          signer: actorSigner(cursor.alias),
          target: ctx.addresses.wrapper,
          value: 0n,
          allowFailure: false,
          label: tag,
          data: encodeFunctionData({
            abi: WRAPPER_ABI,
            functionName: "approve",
            args: [approved, BigInt(node)],
          }),
        });
        if (deferredFuses) {
          calls.push({
            signer: actorSigner(cursor.alias),
            target: ctx.addresses.wrapper,
            value: 0n,
            allowFailure: false,
            label: `${tag} burn withheld fuses`,
            data: encodeFunctionData({
              abi: WRAPPER_ABI,
              functionName: "setFuses",
              args: [node, deferredFuses],
            }),
          });
          deferredFuses = 0;
        }
        break;
      }

      // The reverse node is derived from msg.sender, so only the claiming actor
      // can make this call; a batcher-signed equivalent would claim the wrong
      // reverse node entirely.
      case "set_reverse_claim": {
        const claimant = stripActorPrefix(step.address_actor);
        const namespace = String(step.namespace ?? "ethereum");
        const registrar =
          namespace === "default"
            ? ctx.addresses.defaultReverseRegistrar
            : ctx.addresses.reverseRegistrar;
        calls.push({
          signer: actorSigner(claimant),
          target: registrar,
          value: 0n,
          allowFailure: false,
          label: `${tag} (${namespace})`,
          data: encodeFunctionData({
            abi: REVERSE_REGISTRAR_ABI,
            functionName: "setName",
            args: [String(step.claimed_name ?? scenario.name)],
          }),
        });
        break;
      }

      default:
        throw new Error(
          `${row.fixture_id}: unsupported V1 setup action "${step.action}"`,
        );
    }
  }

  // Bring the name to the state the corpus says it is in when migration runs.
  //
  // A scenario describes two points in time: how the name was registered, and
  // the resolver and records it carries by migration time — `target_current_*`,
  // which is what `expected_pre_migration` restates. The setup steps model the
  // history in between (writes, clears, rewrites) but do not always end on the
  // target, so the target is applied here as the closing state. Names already
  // sitting on it get no extra calls, and one whose target is empty keeps its
  // cleared records.
  const targetResolver = resolveOptionalRef(
    scenario.v1.registration.target_current_resolver_ref,
    ctx,
  );
  const targetRecords: RecordSpec[] =
    scenario.v1.registration.target_current_records ?? [];
  if (targetResolver !== zeroAddress) {
    if (targetResolver !== currentResolver) {
      pushSetResolver(targetResolver, `${row.fixture_id} target setResolver`);
    }
    const missing = targetRecords.filter((record) => {
      const written = writtenRecords.get(recordKey(record));
      return !written || recordValue(written, ctx) !== recordValue(record, ctx);
    });
    if (missing.length) {
      calls.push(
        ...recordCalls(
          targetResolver,
          node,
          missing,
          ctx,
          nodeSigner(),
          `${row.fixture_id} target`,
        ),
      );
    }
  }

  // Hand the name to its terminal pre-migration owner if setup never moved it.
  const terminalOwner = preMigrationOwnerAlias(scenario);
  if (heldByBatcher && !child) {
    calls.push(
      ...transferNameCalls({
        wrapped: false,
        signer: BATCHER,
        from: ctx.batcher,
        to: resolveRef(terminalOwner, ctx),
        tokenId,
        node,
        addresses: ctx.addresses,
        label: `${row.fixture_id} handover`,
      }),
    );
  }

  return calls;
}

/// The wrapper treats a `.eth` 2LD as expiring when its grace period opens,
/// which is what decides whether a transfer is refused.
const WRAPPER_GRACE_PERIOD = 90n * 86_400n;

/// What a name looks like on chain when a handover is planned, read once per
/// name rather than replayed from the seeding plan — a name may have moved
/// between actors during setup, and a rerun must see where it actually is.
export type HandoverState = {
  /// NameWrapper owner, fuses and expiry for the name's own node.
  wrapperOwner: Address;
  wrapperFuses: number;
  wrapperExpiry: bigint;
  /// BaseRegistrar registrant of the 2LD. For a wrapped name this is the
  /// NameWrapper itself.
  registrant: Address;
  /// The same wrapper reading for a child's parent 2LD.
  parentWrapperOwner?: Address;
  parentWrapperFuses?: number;
  parentWrapperExpiry?: bigint;
  /// Seconds since the epoch the plan is built against.
  now: bigint;
};

/// A name, or a child's parent, the handover cannot move, and why.
export type HandoverSkip = { subject: string; reason: string };

export type HandoverPlan = {
  calls: PlannedCall[];
  skips: HandoverSkip[];
  /// Addresses the plan moves a token away from. Each has to approve the
  /// batcher before the batch runs.
  holders: Address[];
  /// Who holds the name itself right now — which is what a later check has to
  /// compare against, since it may not be the actor the corpus declares.
  nameHolder: Address;
};

const sameAddress = (a: Address, b: Address): boolean =>
  a.toLowerCase() === b.toLowerCase();

/// Mirrors `NameWrapper._beforeTransfer`: an emancipated name is frozen once it
/// expires, and a live one is frozen by `CANNOT_TRANSFER`. Reproducing the rule
/// here turns a whole batch that would revert on one member into a name that is
/// reported as left behind.
function wrapperTransferBlock(
  fuses: number,
  expiry: bigint,
  now: bigint,
): string | null {
  const effective =
    fuses & FUSES.IS_DOT_ETH ? expiry - WRAPPER_GRACE_PERIOD : expiry;
  if (effective < now) {
    return fuses & FUSES.PARENT_CANNOT_CONTROL ? "expired" : null;
  }
  return fuses & FUSES.CANNOT_TRANSFER ? "CANNOT_TRANSFER burned" : null;
}

/// Calls that give one seeded name to `to`, planned against what the chain
/// currently says rather than against the plan that shaped it.
///
/// Every call is sent by the batcher, which the holders approve as an operator
/// beforehand, so a cohort moves in batches rather than one transaction per
/// name. A name already at the target plans nothing, which makes a rerun a
/// no-op and lets an interrupted run resume.
///
/// A child's parent moves too: it stays wrapped to the batcher throughout
/// setup, and the helper refuses a subname whose parent has not migrated, so a
/// recipient holding only the child could never migrate it.
export function planHandover(
  row: FixtureEnvelope,
  ctx: PlanContext,
  to: Address,
  state: HandoverState,
): HandoverPlan {
  const scenario = row.scenario;
  const form = v1Form(scenario);
  const topLabel = scenario.top_level_label;
  const wrapped = isWrapped(form);

  type Subject = {
    subject: string;
    wrapped: boolean;
    holder: Address;
    fuses: number;
    expiry: bigint;
    tokenId: bigint;
    node: Hex;
  };

  /// Why this subject cannot move, or null when it can. A subject already at
  /// the recipient needs no calls and blocks nothing.
  const refusal = (s: Subject): string | null => {
    if (sameAddress(s.holder, to)) return null;
    if (s.holder === zeroAddress) return "no v1 holder";
    if (!s.wrapped && sameAddress(s.holder, ctx.addresses.wrapper)) {
      return "held by the NameWrapper";
    }
    return s.wrapped
      ? wrapperTransferBlock(s.fuses, s.expiry, state.now)
      : null;
  };

  const name: Subject = {
    subject: scenario.name,
    wrapped,
    holder: wrapped ? state.wrapperOwner : state.registrant,
    fuses: state.wrapperFuses,
    expiry: state.wrapperExpiry,
    tokenId: tokenIdOf(topLabel),
    node: namehash(scenario.name) as Hex,
  };

  // A subname and the name above it are one unit. The helper refuses a subname
  // whose parent has not migrated, and only the parent's owner can migrate the
  // parent — so a wallet holding one without the other can drive neither. Both
  // are therefore decided before either is scheduled: whichever is refused, the
  // pair stays put.
  const subjects: Subject[] = [name];
  if (isChild(form)) {
    subjects.push({
      subject: `${topLabel}.eth`,
      wrapped: true,
      holder: state.parentWrapperOwner ?? zeroAddress,
      fuses: state.parentWrapperFuses ?? 0,
      expiry: state.parentWrapperExpiry ?? 0n,
      tokenId: tokenIdOf(topLabel),
      node: namehash(`${topLabel}.eth`) as Hex,
    });
  }

  const refusals = subjects.map((s) => ({ subject: s, reason: refusal(s) }));
  const refused = refusals.find((r) => r.reason);
  if (refused) {
    return {
      calls: [],
      skips: refusals.map((r) => ({
        subject: r.subject.subject,
        reason:
          r.reason ??
          (r.subject === name ? "its parent stayed" : "its child stayed"),
      })),
      holders: [],
      nameHolder: name.holder,
    };
  }

  const calls: PlannedCall[] = [];
  const holders: Address[] = [];
  for (const s of subjects) {
    if (sameAddress(s.holder, to)) continue;
    holders.push(s.holder);
    calls.push(
      ...transferNameCalls({
        wrapped: s.wrapped,
        signer: BATCHER,
        from: s.holder,
        to,
        tokenId: s.tokenId,
        node: s.node,
        addresses: ctx.addresses,
        label:
          s.subject === scenario.name
            ? `${row.fixture_id} handover`
            : `${row.fixture_id} handover (${s.subject})`,
      }),
    );
  }

  return { calls, skips: [], holders, nameHolder: name.holder };
}
