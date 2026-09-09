/// Owner-gated transactions that someone else signs.
///
/// On mainnet the owner, the v1 owner and the URP admin are all the DAO, so the
/// phases cannot broadcast: they emit calldata, a Safe executes it later, and this
/// module prepares, reads back and replays those transactions. Everything here is
/// about that hand-off — nothing in it knows what a phase does.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAddress, type Address, type Chain } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

import { resolve } from "node:path";
import { keccak256, stringToHex } from "viem";

import {
  envPrivateKey,
  envValue,
  errorMessageChain,
  migrationChain,
  parseNumber,
  publicClient,
  sameAddress,
  waitForSuccessfulReceipt,
  type MigrationNetwork,
} from "./plumbing.js";
import { walletClient } from "./rpc.js";

type WalletAccount =
  | ReturnType<typeof privateKeyToAccount>
  | ReturnType<typeof mnemonicToAccount>;

/// One owner-gated transaction, as written to the deferred-transaction JSONL.
export type PreparedOwnerTransaction = {
  account?: string;
  role?: string;
  from?: Address;
  to: Address;
  value?: string;
  data: `0x${string}`;
  phase?: string;
  label?: string;
  functionName?: string;
  deployment?: string;
};

export function printPreparedCall(
  label: string,
  target: Address,
  data: `0x${string}`,
): void {
  console.log(`${label}`);
  console.log(`  to:   ${target}`);
  console.log(`  data: ${data}`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePreparedOwnerTransaction(
  value: unknown,
  lineNumber: number,
): PreparedOwnerTransaction {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid owner tx on line ${lineNumber}: expected object`);
  }
  const input = value as Record<string, unknown>;
  const to = optionalString(input.to);
  const data = optionalString(input.data);
  if (!to)
    throw new Error(`Invalid owner tx on line ${lineNumber}: missing to`);
  if (!data?.startsWith("0x")) {
    throw new Error(`Invalid owner tx on line ${lineNumber}: missing calldata`);
  }

  const rawValue = input.value;
  return {
    account: optionalString(input.account),
    role: optionalString(input.role),
    from: input.from ? getAddress(String(input.from)) : undefined,
    to: getAddress(to),
    value: rawValue === undefined ? undefined : String(rawValue),
    data: data as `0x${string}`,
    phase: optionalString(input.phase),
    label: optionalString(input.label),
    functionName: optionalString(input.functionName),
    deployment: optionalString(input.deployment),
  };
}

export function readPreparedOwnerTransactions(
  file: string,
  role?: string,
): PreparedOwnerTransaction[] {
  const roleFilter = role?.toLowerCase();
  return readFileSync(resolve(file), "utf-8")
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, lineNumber }) =>
      parsePreparedOwnerTransaction(JSON.parse(line), lineNumber),
    )
    .filter((tx) => {
      if (!roleFilter) return true;
      return [tx.role, tx.account]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase() === roleFilter);
    });
}

function preparedOwnerTransactionRole(tx: PreparedOwnerTransaction): string {
  return tx.role ?? tx.account ?? "owner";
}

export function preparedOwnerTransactionLabel(
  tx: PreparedOwnerTransaction,
): string {
  const action = tx.label ?? tx.functionName ?? tx.deployment ?? "transaction";
  return [tx.phase, action].filter(Boolean).join(": ");
}

// Role-specific env-var prefixes for prepared owner transactions. Roles not listed
// here fall back to OWNER_TX_ENV_DEFAULT_PREFIXES. Role names are matched after
// lowercasing and stripping dashes (e.g. "v1-owner" -> "v1owner").
const OWNER_TX_ENV_PREFIXES: Record<string, readonly string[]> = {
  v1owner: ["SEPOLIA_V1_OWNER", "V1_OWNER"],
  sepoliatopurpowner: ["SEPOLIA_TOP_URP_OWNER", "TOP_URP_OWNER"],
};

const OWNER_TX_ENV_DEFAULT_PREFIXES = [
  "OWNER_TX",
  "SEPOLIA_V1_OWNER",
  "V1_OWNER",
  "SEPOLIA_TOP_URP_OWNER",
  "TOP_URP_OWNER",
] as const;

function normalizeOwnerTransactionRole(role: string | undefined): string {
  return role?.toLowerCase().replace(/-/g, "") ?? "";
}

function ownerTransactionEnv(
  role: string | undefined,
  suffix: string,
): string | undefined {
  const prefixes =
    OWNER_TX_ENV_PREFIXES[normalizeOwnerTransactionRole(role)] ??
    OWNER_TX_ENV_DEFAULT_PREFIXES;
  return envValue(...prefixes.map((prefix) => `${prefix}${suffix}`));
}

function ownerTransactionPrivateKey(
  role: string | undefined,
  privateKey: `0x${string}` | undefined,
): `0x${string}` | undefined {
  if (privateKey) return privateKey;
  if (normalizeOwnerTransactionRole(role) === "deployer") {
    return envPrivateKey("DEPLOYER_KEY");
  }
  return ownerTransactionEnv(role, "_KEY") as `0x${string}` | undefined;
}

function ownerTransactionMnemonic(
  role: string | undefined,
): string | undefined {
  return ownerTransactionEnv(role, "_MNEMONIC");
}

function ownerTransactionMnemonicPath(
  role: string | undefined,
): string | undefined {
  return ownerTransactionEnv(role, "_MNEMONIC_PATH");
}

function ownerTransactionMnemonicPassphrase(
  role: string | undefined,
): string | undefined {
  return ownerTransactionEnv(role, "_MNEMONIC_PASSPHRASE");
}

function ownerTransactionMnemonicIndex(role: string | undefined): number {
  return parseNumber(ownerTransactionEnv(role, "_MNEMONIC_INDEX"), 0);
}

function ownerTransactionSigner(
  role: string | undefined,
  privateKey: `0x${string}` | undefined,
): WalletAccount | undefined {
  const resolvedPrivateKey = ownerTransactionPrivateKey(role, privateKey);
  if (resolvedPrivateKey) return privateKeyToAccount(resolvedPrivateKey);

  const mnemonic = ownerTransactionMnemonic(role);
  if (!mnemonic) return undefined;

  const path = ownerTransactionMnemonicPath(role);
  const passphrase = ownerTransactionMnemonicPassphrase(role);
  return mnemonicToAccount(
    mnemonic,
    (path
      ? { path, passphrase }
      : {
          addressIndex: ownerTransactionMnemonicIndex(role),
          passphrase,
        }) as never,
  );
}

// Identity of a prepared transaction, independent of its position in the file, so a
// re-run recognises one it has already sent even if the file was regenerated or
// filtered differently.
function preparedOwnerTransactionId(tx: PreparedOwnerTransaction): string {
  return keccak256(
    stringToHex(
      [
        normalizeOwnerTransactionRole(tx.role),
        getAddress(tx.to),
        tx.data,
        BigInt(tx.value ?? "0").toString(),
      ].join("|"),
    ),
  );
}

type OwnerTransactionJournal = Record<
  string,
  {
    label: string;
    hash: string;
    // Recorded so a journal left over from a fork rehearsal cannot suppress the same
    // transaction on a different chain. Chain id alone does not settle it — a
    // mainnet fork answers 1 — so the block the transaction landed in is recorded
    // too, and re-checked against the connected chain before anything is skipped.
    chainId: number;
    blockNumber: string;
    blockHash: string;
    executedAt: string;
  }
>;

function ownerTransactionJournalPath(file: string, explicit?: string): string {
  return explicit ?? `${file}.executed.json`;
}

// Whether a journalled transaction is still where the journal says it is. An absent
// receipt means it never landed here; a reverted one means it landed and did nothing;
// a different block hash means the branch it was in is no longer canonical.
async function journalledTransactionStillLanded(
  client: ReturnType<typeof publicClient>,
  entry: OwnerTransactionJournal[string],
): Promise<boolean> {
  if (!entry.blockHash) return false;
  try {
    const receipt = await client.getTransactionReceipt({
      hash: entry.hash as `0x${string}`,
    });
    return (
      receipt.status === "success" &&
      receipt.blockHash.toLowerCase() === entry.blockHash.toLowerCase()
    );
  } catch {
    return false;
  }
}

function readOwnerTransactionJournal(path: string): OwnerTransactionJournal {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OwnerTransactionJournal;
  } catch {
    return {};
  }
}

export async function executePreparedOwnerTransactions(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  file: string;
  role?: string;
  privateKey?: `0x${string}`;
  dryRun?: boolean;
  journalFile?: string;
  // Re-send transactions the journal already records as executed.
  force?: boolean;
}) {
  const transactions = readPreparedOwnerTransactions(opts.file, opts.role);
  if (transactions.length === 0) {
    throw new Error(`No prepared owner transactions found in ${opts.file}`);
  }

  const account = ownerTransactionSigner(opts.role, opts.privateKey);
  if (!account && !opts.dryRun) {
    throw new Error(
      "Missing --private-key, owner key env var, or owner mnemonic env var for prepared owner transactions",
    );
  }

  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain);
  const wallet = account
    ? walletClient({ rpcUrl: opts.rpcUrl, chain, account })
    : null;

  // These are owner-gated writes against live v1 contracts. Re-running the file
  // after a partial failure must not re-send what already landed, so each success is
  // journalled and skipped on a later run.
  const journalPath = ownerTransactionJournalPath(opts.file, opts.journalFile);
  const journal = readOwnerTransactionJournal(journalPath);
  let executed = 0;
  let skipped = 0;

  for (const tx of transactions) {
    const label = preparedOwnerTransactionLabel(tx);
    const role = preparedOwnerTransactionRole(tx);
    const id = preparedOwnerTransactionId(tx);
    const previous = journal[id];

    // A journal entry is only evidence if the transaction it names is still on this
    // chain. A rehearsal on a mainnet fork writes entries claiming chain 1, and a
    // reorg can take a real one back out; skipping on either would leave an
    // owner-gated write unsent while the run reports it as already done.
    const alreadyExecuted =
      previous?.chainId === chain.id &&
      (await journalledTransactionStillLanded(client, previous));
    if (previous && !alreadyExecuted && !opts.dryRun) {
      console.log(
        `journalled ${role}: ${label} (tx ${previous.hash}) is not on this chain — re-sending`,
      );
    }
    if (alreadyExecuted && !opts.force && !opts.dryRun) {
      skipped++;
      console.log(
        `already executed ${role}: ${label} (tx ${previous.hash}, block ${previous.blockNumber}) — skipping; pass --force to re-send`,
      );
      continue;
    }

    console.log(`${opts.dryRun ? "prepared" : "executing"} ${role}: ${label}`);
    console.log(`  to:   ${tx.to}`);
    console.log(`  data: ${tx.data}`);
    if (alreadyExecuted && opts.dryRun) {
      console.log(`  note: already executed as ${previous.hash}`);
    }

    if (account && tx.from && !sameAddress(account.address, tx.from)) {
      throw new Error(
        `Signer ${account.address} does not match prepared tx sender ${tx.from} for ${label}`,
      );
    }
    if (opts.dryRun) continue;

    const hash = await wallet!.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value ?? "0"),
    });
    const receipt = await waitForSuccessfulReceipt(client, hash, label);
    console.log(`  tx:   ${hash}`);

    journal[id] = {
      label,
      hash,
      chainId: chain.id,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      executedAt: new Date().toISOString(),
    };
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    executed++;
  }

  if (!opts.dryRun) {
    console.log(
      `owner transactions: ${executed} executed, ${skipped} already executed (journal ${journalPath})`,
    );
  }
}
