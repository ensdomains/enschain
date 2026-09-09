import { describe, expect, it } from "bun:test";
import { toFunctionSignature, type AbiFunction } from "viem";

import * as abis from "../../script/abis.js";

/// The fragments are cut from the compiled artifacts, so they cannot disagree
/// with the contracts — a renamed function resolves to `never` and fails the
/// build. What is still fallible is the cut itself: a name that is overloaded
/// yields more than one entry unless an arity says which, and an ABI carrying
/// two arities of one name is one viem cannot encode against.
/// Namespaces group a contract's fragments; a bare array is a composition of
/// them, checked separately because its entries are the fragments themselves.
const NAMESPACES = Object.entries(abis).filter(
  ([, value]) => !Array.isArray(value),
) as [string, Record<string, readonly unknown[]>][];

const COMPOSITIONS = Object.entries(abis).filter(([, value]) =>
  Array.isArray(value),
) as [string, readonly unknown[]][];

describe("shared ABI fragments", () => {
  it("covers every contract the scripts call", () => {
    expect(NAMESPACES.map(([name]) => name).sort()).toEqual([
      "BaseRegistrar",
      "EnsRegistry",
      "EthRegistrarController",
      "NameWrapper",
      "PermissionedRegistry",
      "PublicResolver",
      "RegistrarOwnership",
      "ReverseRegistrar",
    ]);
  });

  for (const [contract, fragments] of NAMESPACES) {
    for (const [name, fragment] of Object.entries(fragments)) {
      it(`${contract}.${name} is a single function fragment`, () => {
        expect(fragment).toHaveLength(1);
        const entry = fragment[0] as AbiFunction;
        expect(entry.type).toBe("function");
        // Signature rather than name: it is what the selector is taken from,
        // so it pins the arity an overload was picked by.
        expect(() => toFunctionSignature(entry)).not.toThrow();
      });
    }
  }

  it("composes only fragments that are already checked", () => {
    expect(COMPOSITIONS.map(([name]) => name)).toEqual([
      "RegistrarOwnershipAbi",
    ]);
    const known = new Set(
      NAMESPACES.flatMap(([, fragments]) =>
        Object.values(fragments).map((f) =>
          toFunctionSignature(f[0] as AbiFunction),
        ),
      ),
    );
    for (const [, composed] of COMPOSITIONS) {
      for (const entry of composed) {
        expect(known).toContain(toFunctionSignature(entry as AbiFunction));
      }
    }
  });

  it("separates the overloaded resolver arities", () => {
    const sig = (f: readonly unknown[]) =>
      toFunctionSignature(f[0] as AbiFunction);
    expect(sig(abis.PublicResolver.addr)).toBe("addr(bytes32)");
    expect(sig(abis.PublicResolver.addrMulticoin)).toBe(
      "addr(bytes32,uint256)",
    );
    expect(sig(abis.PublicResolver.setAddr)).toBe("setAddr(bytes32,address)");
    expect(sig(abis.PublicResolver.setAddrMulticoin)).toBe(
      "setAddr(bytes32,uint256,bytes)",
    );
    expect(sig(abis.BaseRegistrar.safeTransferFrom)).toBe(
      "safeTransferFrom(address,address,uint256)",
    );
    expect(sig(abis.NameWrapper.safeTransferFrom)).toBe(
      "safeTransferFrom(address,address,uint256,uint256,bytes)",
    );
  });
});
