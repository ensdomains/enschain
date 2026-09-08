/// Primitives the migration tooling shares.
///
/// These are the pieces every entry point needs — the CLI, the hardhat tasks, and the
/// fixture corpus — and which each had grown its own copy of. A second copy of a
/// primitive is not just repetition: the copies drift, and the drift is invisible
/// until an operator runs one entry point from a directory the other never sees.
///
/// Nothing here reaches back into the modules that use it, so it can be imported from
/// anywhere in the tooling without closing a cycle.

import type { Hex } from "viem";

/// A name in the length-prefixed wire encoding the v1 and v2 resolvers read.
export function dnsEncodeName(name: string): Hex {
  const bytes: number[] = [];
  for (const label of name.split(".")) {
    const labelBytes = Buffer.from(label, "utf8");
    if (labelBytes.length > 255) throw new Error(`label is too long: ${label}`);
    bytes.push(labelBytes.length, ...labelBytes);
  }
  bytes.push(0);
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/// Every message in an error's `cause` chain, outermost first.
///
/// Providers bury the useful part — a reverted call, a refused block span — under
/// several layers of wrapping, so a match against the outermost message alone misses
/// it. Bounded so a self-referencing chain cannot spin.
export function errorMessageChain(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && messages.length < 10) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages;
}
