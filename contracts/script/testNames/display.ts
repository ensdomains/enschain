import { decodeFunctionResult, encodeFunctionData } from "viem";

import type { DevnetEnvironment } from "../setup.js";
import { MAX_EXPIRY, STATUS } from "../deploy-constants.js";
import { dnsEncodeName, namehash } from "../../test/utils/utils.js";
import { getNameData } from "./registry.js";
import {
  ADDR_ABI,
  MULTICALL_ABI,
  PROFILE_ABI,
} from "../../test/utils/resolver-abis.js";

/**
 * Display name information in a formatted table
 */
export async function showName(env: DevnetEnvironment, names: string[]) {
  await env.sync();

  const nameData = [];

  for (const name of names) {
    const node = namehash(name);

    const data = await getNameData(env, name);

    // Batch addr and text resolution using resolver multicall
    const resolverCalls = [
      encodeFunctionData({
        abi: ADDR_ABI,
        functionName: "addr",
        args: [node],
      }),
      encodeFunctionData({
        abi: PROFILE_ABI,
        functionName: "text",
        args: [node, "description"],
      }),
    ];

    const multicallData = encodeFunctionData({
      abi: MULTICALL_ABI,
      functionName: "multicall",
      args: [resolverCalls],
    });

    // Single UniversalResolver call with multicall
    let ethAddress: string | undefined;
    let description: string | undefined;

    try {
      const [result] = await env.v2.UniversalResolver.read.resolve([
        dnsEncodeName(name),
        multicallData,
      ]);

      // Decode the multicall result - returns array of bytes directly
      const results = decodeFunctionResult({
        abi: MULTICALL_ABI,
        functionName: "multicall",
        data: result,
      }) as readonly `0x${string}`[];

      // Decode individual results
      ethAddress = decodeFunctionResult({
        abi: ADDR_ABI,
        functionName: "addr",
        data: results[0],
      });
      description = decodeFunctionResult({
        abi: PROFILE_ABI,
        functionName: "text",
        data: results[1],
      }) as string;
    } catch {
      // Resolution may fail for names without a resolver (e.g., reserved or unregistered names)
    }

    nameData.push({
      Name: name,
      Registry: truncateAddress(data?.parentRegistry.address),
      Status: formatStatus(data?.status),
      Owner: truncateAddress(data?.owner),
      Expiry: formatExpiry(data?.expiry ?? 0n),
      Resolver: truncateAddress(data?.resolver),
      Address: truncateAddress(ethAddress),
      Description: description || "-",
    });
  }

  console.log(`\nName Information:`);
  console.table(nameData);
}

export function truncateAddress(addr: string | undefined) {
  if (!addr || addr === "0x") return "-";
  return addr.slice(0, 7);
}

export function formatExpiry(sec: bigint) {
  switch (sec) {
    case 0n:
      return "Unset (0)";
    case MAX_EXPIRY:
      return "Never (MAX_EXPIRY)";
    default:
      return new Date(Number(sec) * 1000).toISOString();
  }
}

export function formatStatus(status: number | undefined) {
  for (const [k, x] of Object.entries(STATUS)) {
    if (x === status) {
      return k;
    }
  }
  return "UKNOWN";
}
