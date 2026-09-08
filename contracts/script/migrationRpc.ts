/// Talking to a node: transports, providers, and the state controls a fork offers.
///
/// Everything here is about *how* a request reaches a chain rather than what the
/// migration asks of it. The distinction matters because a rehearsal and a live run
/// differ almost entirely in this layer — impersonation instead of keys, snapshots,
/// balance writes — and keeping it separate stops those differences leaking into the
/// phase logic.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import {
  createPublicClient,
  custom,
  http,
  type Address,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { setTimeout as sleep } from "node:timers/promises";
import { createWalletClient, getAddress, parseEther } from "viem";

import {
  errorMessageChain,
  NETWORKS,
  publicClient,
  type MigrationNetwork,
  type RpcProvider,
} from "./migrationPlumbing.js";

/// Retries viem applies to a JSON-RPC call it did reach the node with.
export const RPC_RETRY_COUNT = 3;

/// Transport-level retries for a dropped connection, on top of viem's own JSON-RPC
/// retries, which never see a request that failed to reach the node.
const RPC_TRANSPORT_RETRIES = 5;
const RPC_TRANSPORT_BACKOFF_MS = 250;

/// The first of several equivalent RPC methods the node answers.
///
/// Anvil, Hardhat and Tenderly spell the same state control differently, so each is
/// tried in turn and the last error is kept if none is understood.
export async function requestAny(
  client: RpcProvider,
  requests: Array<{ method: string; params: unknown[] }>,
) {
  let lastError: unknown;
  for (const request of requests) {
    try {
      return await client.request({
        method: request.method as any,
        params: request.params as any,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function setBalance(client: RpcProvider, address: Address) {
  const balance = `0x${parseEther("100").toString(16)}`;
  await requestAny(client, [
    { method: "anvil_setBalance", params: [address, balance] },
    { method: "hardhat_setBalance", params: [address, balance] },
    { method: "tenderly_setBalance", params: [address, balance] },
    { method: "tenderly_setBalance", params: [[address], balance] },
  ]);
}

// An EIP-7702 delegation designator makes an EOA run its delegate's code on every
// call. The delegates found on widely-known public test keys do not return the
// ERC-1155 acceptance value, so any token mint or safe transfer to such an account
// reverts. A fork of a live chain inherits whatever delegations exist there, which
// silently breaks the registry writes that hand a migration signer its root names
// and roles. Clearing the code restores a plain EOA, which skips the acceptance
// callback entirely. Reading the designator rather than matching known addresses
// keeps this working as delegates are rotated.
const EIP7702_DESIGNATOR_PREFIX = "0xef0100";

export async function clearAccountDelegations(
  client: ReturnType<typeof publicClient>,
  accounts: Array<{ address: Address; label: string }>,
) {
  const seen = new Set<string>();
  for (const { address, label } of accounts) {
    const key = getAddress(address);
    if (seen.has(key)) continue;
    seen.add(key);
    const code = await client.getCode({ address });
    if (!code || !code.toLowerCase().startsWith(EIP7702_DESIGNATOR_PREFIX))
      continue;
    try {
      await requestAny(client, [
        { method: "anvil_setCode", params: [address, "0x"] },
        { method: "hardhat_setCode", params: [address, "0x"] },
        { method: "tenderly_setCode", params: [address, "0x"] },
      ]);
    } catch (error) {
      console.log(
        `warning: ${label} ${address} carries an EIP-7702 delegation that could not be cleared (${errorMessageChain(error)[0]}); token mints to it will revert`,
      );
      continue;
    }
    console.log(`cleared EIP-7702 delegation on ${label} ${address}`);
  }
}

export async function impersonate(client: RpcProvider, address: Address) {
  await requestAny(client, [
    { method: "anvil_impersonateAccount", params: [address] },
    { method: "hardhat_impersonateAccount", params: [address] },
    { method: "tenderly_impersonateAccount", params: [address] },
    { method: "tenderly_impersonateAccount", params: [[address]] },
  ]);
  await setBalance(client, address);
}

export async function waitForRpc(rpcUrl: string, chain: Chain): Promise<void> {
  const client = publicClient(rpcUrl, chain);
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      await client.getChainId();
      return;
    } catch {
      try {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_chainId",
            params: [],
          }),
        });
        const payload = await response.json();
        if (typeof payload?.result === "string") return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Timed out waiting for RPC at ${rpcUrl}`);
}

export function buildFeeHistoryResult(params: any) {
  const blockCount = Number(BigInt(params?.[0] ?? "0x1"));
  const percentiles = params?.[2] ?? [];
  return {
    oldestBlock: "0x1",
    baseFeePerGas: Array.from({ length: blockCount + 1 }, () => "0x1"),
    gasUsedRatio: Array.from({ length: blockCount }, () => 0),
    reward: Array.from({ length: blockCount }, () =>
      Array.from({ length: percentiles.length }, () => "0x1"),
    ),
  };
}

export function buildFeeHistoryResponse(request: any) {
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: buildFeeHistoryResult(request.params),
  };
}

export function isMissingFeeHistory(error: any): boolean {
  const message = String(error?.details ?? error?.message ?? "");
  return (
    error?.code === -32601 ||
    error?.code === -32001 ||
    message.includes("eth_feeHistory") ||
    message.includes("Method not found") ||
    message.includes("method not found") ||
    message === "not found"
  );
}

export function withRpcCompatibility(
  provider: RpcProvider,
  debugRpc = false,
): RpcProvider {
  return {
    async request(args) {
      try {
        return await provider.request(args);
      } catch (error) {
        if (args.method === "eth_feeHistory" && isMissingFeeHistory(error)) {
          return buildFeeHistoryResult(
            Array.isArray(args.params) ? args.params : [],
          );
        }
        if (debugRpc) {
          console.error(`rpc error from ${args.method}:`, error);
        }
        throw error;
      }
    },
  };
}

export function httpRpcProvider(rpcUrl: string): RpcProvider {
  let id = 0;
  return {
    async request(args) {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: args.method,
          params: args.params ?? [],
        }),
      });
      const payload = (await response.json()) as {
        result?: unknown;
        error?: { code?: number; message?: string; data?: unknown };
      };
      if (payload.error) {
        const error = new Error(
          payload.error.message ?? "JSON-RPC error",
        ) as Error & {
          code?: number;
          data?: unknown;
        };
        error.code = payload.error.code;
        error.data = payload.error.data;
        throw error;
      }
      return payload.result;
    },
  };
}

export function privateKeyRpcProvider({
  rpcUrl,
  chain,
  privateKey,
}: {
  rpcUrl: string;
  chain: Chain;
  privateKey: `0x${string}`;
}): RpcProvider {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl, { retryCount: RPC_RETRY_COUNT }),
  });
  const fallback = httpRpcProvider(rpcUrl);
  const normalizeTransaction = (transaction: any) => {
    if (transaction.type === "0x2") {
      return { ...transaction, type: "eip1559" };
    }
    if (transaction.maxFeePerGas || transaction.maxPriorityFeePerGas) {
      const { gasPrice: _gasPrice, type: _type, ...rest } = transaction;
      return { ...rest, type: "eip1559" };
    }
    return transaction;
  };
  return {
    async request(args) {
      if (args.method === "eth_accounts")
        return [account.address.toLowerCase()];
      if (args.method === "eth_sendTransaction") {
        const [transaction] = (args.params ?? []) as [any];
        return await client.sendTransaction(normalizeTransaction(transaction));
      }
      if (args.method === "eth_signTransaction") {
        const [transaction] = (args.params ?? []) as [any];
        return await client.signTransaction(normalizeTransaction(transaction));
      }
      return fallback.request(args);
    },
  };
}

export function privateKeySignerProtocol(rpcUrl: string, chain: Chain) {
  return async (protocolString: string) => {
    const privateKey = protocolString.slice(
      "privateKey:".length,
    ) as `0x${string}`;
    return {
      type: "remote" as const,
      signer: privateKeyRpcProvider({ rpcUrl, chain, privateKey }) as any,
    } as any;
  };
}

export function impersonatedAccountProvider(
  provider: RpcProvider,
  address: Address,
): RpcProvider {
  return {
    async request(args) {
      if (args.method === "eth_accounts") return [address];
      return provider.request(args);
    },
  };
}

export async function createRpcSnapshot(
  provider: RpcProvider,
): Promise<string> {
  const snapshotId = await provider.request({
    method: "evm_snapshot",
    params: [],
  });
  if (typeof snapshotId !== "string") {
    throw new Error(`unexpected evm_snapshot response: ${String(snapshotId)}`);
  }
  return snapshotId;
}

export function saveRpcSnapshotFile(
  path: string,
  snapshotId: string,
  network: string,
) {
  const filePath = resolve(path);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        network,
        snapshotId,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

/// Reads outside the `eth_get*` family that a dropped connection can re-issue.
const RETRYABLE_RPC_METHODS = new Set([
  "eth_accounts",
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_protocolVersion",
  "eth_syncing",
  "net_listening",
  "net_version",
  "web3_clientVersion",
]);

/// Whether re-issuing a request cannot change the chain.
///
/// Reads are recognised explicitly so a method nobody has classified is left
/// alone rather than replayed on a guess. Transaction submission is the case
/// this exists to exclude: a node-signed send carries no client nonce, so a
/// replay lands a second, distinct transaction rather than being rejected as a
/// duplicate. The state controls are equally unsafe — replaying a clock
/// increment advances it twice — and a batch is an array whose members cannot be
/// judged from the envelope.
export function isRetryableRpcRequest(request: any): boolean {
  if (!request || Array.isArray(request)) return false;
  const method = request.method;
  return (
    typeof method === "string" &&
    (method.startsWith("eth_get") || RETRYABLE_RPC_METHODS.has(method))
  );
}

/// Retries a fetch that never produced a response.
///
/// A long deploy issues thousands of RPC calls, and a single dropped connection
/// would otherwise abort it partway through — leaving a half-deployed namespace
/// that cannot be resumed. Only transport failures are retried: an HTTP response
/// of any status is returned untouched, so JSON-RPC errors keep their existing
/// handling.
///
/// Only idempotent requests are retried. Replaying a send would be unsafe, and
/// would not help either: a node that accepted the first submission rejects the
/// second as already known, so the run aborts whether or not it is retried.
export async function fetchWithTransportRetry(
  originalFetch: typeof globalThis.fetch,
  input: any,
  init: any,
  request: any,
): Promise<Response> {
  const attempts = isRetryableRpcRequest(request) ? RPC_TRANSPORT_RETRIES : 0;
  let lastError: unknown;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      return await originalFetch(input, init);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const backoff = RPC_TRANSPORT_BACKOFF_MS * 2 ** attempt;
      await sleep(backoff + Math.floor(Math.random() * backoff));
    }
  }
  throw lastError;
}

/**
 * Permanently monkey-patches `globalThis.fetch` to add JSON-RPC compatibility
 * fallbacks for HTTP traffic issued by libraries we do not control (rocketh/viem
 * internals): when an RPC lacks `eth_feeHistory` and returns an error, a synthetic
 * fee-history response is fabricated so EIP-1559 fee estimation can proceed. With
 * `debugRpc` enabled, JSON-RPC error payloads are also logged. The patch is
 * process-wide, never uninstalled, and otherwise passes responses through untouched.
 */
export function installRpcCompatibility(debugRpc: boolean): void {
  const originalFetch = globalThis.fetch.bind(globalThis);
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const request = (() => {
      if (typeof init?.body !== "string") return null;
      try {
        return JSON.parse(init.body);
      } catch {
        return null;
      }
    })();
    const response = await fetchWithTransportRetry(
      originalFetch,
      input,
      init,
      request,
    );
    try {
      const payload = await response.clone().json();
      if (
        request?.method === "eth_feeHistory" &&
        isMissingFeeHistory(payload?.error)
      ) {
        return new Response(JSON.stringify(buildFeeHistoryResponse(request)), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (debugRpc && payload?.error) {
        console.error(
          `rpc error from ${request?.method ?? "unknown"}:`,
          payload.error,
        );
      }
    } catch {
      // Non-JSON responses are unrelated to JSON-RPC compatibility handling.
    }
    return response;
  };
}

export function isLocalRpcUrl(rpcUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(?::|\/|$)/i.test(rpcUrl);
}

// Tenderly virtual testnets expose state-control RPC methods (impersonation, time
// travel, setBalance) just like a local node, so they can run the rehearsal
// without configured signer keys.
export function isTenderlyVirtualRpc(rpcUrl: string): boolean {
  try {
    const hostname = new URL(rpcUrl).hostname.toLowerCase();
    return (
      hostname.startsWith("virtual.") && hostname.endsWith(".rpc.tenderly.co")
    );
  } catch {
    return false;
  }
}
