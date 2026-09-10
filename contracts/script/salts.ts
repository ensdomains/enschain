import {
  type Address,
  encodeAbiParameters,
  keccak256,
  stringToHex,
} from "viem";
import { namehash } from "../test/utils/utils.js";

export function computeOwnedResolverSalt(owner: Address, version = 0n) {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [
          { name: "id", type: "bytes32" },
          { name: "owner", type: "address" },
          { name: "version", type: "uint256" },
        ],
        [keccak256(stringToHex("OwnedResolver")), owner, version],
      ),
    ),
  );
}

export function computeUserRegistrySalt(name: string, version = 0n) {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [
          { name: "id", type: "bytes32" },
          { name: "node", type: "bytes32" },
          { name: "version", type: "uint256" },
        ],
        [keccak256(stringToHex("UserRegistry")), namehash(name), version],
      ),
    ),
  );
}

export function computeWrapperRegistrySalt(name: string) {
  return BigInt(namehash(name));
}
