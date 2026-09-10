import { concat, type Hex, keccak256, stringToBytes, zeroHash } from "viem";

export { dnsEncodeName } from "../../lib/ens-contracts/test/fixtures/dnsEncodeName.js";
export { dnsDecodeName } from "../../lib/ens-contracts/test/fixtures/dnsDecodeName.js";
export * from "../../lib/ens-contracts/test/fixtures/ensip19.js";

// NOTE: viem's {name,label}hash() has long-label support, which ENSv2 is not using
// use the following replacements instead

export function labelhash(label: string): Hex {
  return keccak256(stringToBytes(label));
}

// NameCoder.namehash()
export function namehash(name: string): Hex {
  return splitName(name).reduceRight<Hex>(
    (a, x) => keccak256(concat([a, labelhash(x)])),
    zeroHash,
  );
}

// LibLabel.id()
export function idFromLabel(label: string): bigint {
  return BigInt(labelhash(label));
}

// LibLabel.withVersion()
export function idWithVersion(id: bigint, version = 0): bigint {
  return id ^ BigInt.asUintN(32, id ^ BigInt(version));
}

//      "" => []
// "a.b.c" => ["a", "b", "c"]
export function splitName(name: string): string[] {
  return name ? name.split(".") : [];
}

//      "" => ""
// "a.b.c" => "b.c"
export function getParentName(name: string): string {
  const i = name.indexOf(".");
  return i === -1 ? "" : name.slice(i + 1);
}

// "a.b.c"  0 => "a" aka firstLabel()
//         -1 => "c"
//          5 => ""
export function getLabelAt(name: string, index = 0): string {
  return splitName(name).at(index) ?? "";
}
