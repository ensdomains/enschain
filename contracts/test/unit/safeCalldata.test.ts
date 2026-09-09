import { describe, expect, it } from "bun:test";
import { encodeFunctionData, parseAbi } from "viem";

import {
  compareCalldata,
  decodeCalldata,
  describeVerdict,
} from "../../script/migrations/safeCalldata.js";

const ABI = parseAbi([
  "function setController(address controller, bool enabled)",
]);

const TARGET = "0x00000000000000000000000000000000000000aa";
const OTHER_TARGET = "0x00000000000000000000000000000000000000bb";
const CONTROLLER = "0x00000000000000000000000000000000000000c1";
const OTHER_CONTROLLER = "0x00000000000000000000000000000000000000c2";

function call(controller: string, enabled: boolean) {
  return encodeFunctionData({
    abi: ABI,
    functionName: "setController",
    args: [controller as `0x${string}`, enabled],
  });
}

describe("compareCalldata", () => {
  it("matches an identical transaction", () => {
    const data = call(CONTROLLER, true);
    expect(
      compareCalldata({ to: TARGET, data }, { to: TARGET, data }).kind,
    ).toBe("match");
  });

  it("matches regardless of address checksum casing", () => {
    const data = call(CONTROLLER, true);
    const verdict = compareCalldata(
      { to: TARGET.toLowerCase(), data },
      { to: TARGET.toUpperCase().replace("0X", "0x"), data },
    );
    expect(verdict.kind).toBe("match");
  });

  it("catches correct calldata sent to the wrong contract", () => {
    const data = call(CONTROLLER, true);
    const verdict = compareCalldata(
      { to: TARGET, data },
      { to: OTHER_TARGET, data },
    );
    expect(verdict.kind).toBe("target-mismatch");
    expect(describeVerdict(verdict)).toContain("target mismatch");
  });

  it("catches a transposed argument, which no visual check would show", () => {
    // Same function, same target, one address different.
    const verdict = compareCalldata(
      { to: TARGET, data: call(CONTROLLER, true) },
      { to: TARGET, data: call(OTHER_CONTROLLER, true) },
    );
    expect(verdict.kind).toBe("data-mismatch");
  });

  it("catches a flipped boolean, the difference between granting and revoking", () => {
    const verdict = compareCalldata(
      { to: TARGET, data: call(CONTROLLER, true) },
      { to: TARGET, data: call(CONTROLLER, false) },
    );
    expect(verdict.kind).toBe("data-mismatch");
  });

  it("catches value attached to a call that should carry none", () => {
    const data = call(CONTROLLER, true);
    const verdict = compareCalldata(
      { to: TARGET, data },
      { to: TARGET, data, value: "1000000000000000000" },
    );
    expect(verdict.kind).toBe("value-mismatch");
    expect(describeVerdict(verdict)).toContain("wei");
  });

  it("treats an absent value and an explicit zero as the same", () => {
    const data = call(CONTROLLER, true);
    expect(
      compareCalldata({ to: TARGET, data }, { to: TARGET, data, value: "0" })
        .kind,
    ).toBe("match");
  });
});

describe("decodeCalldata", () => {
  it("renders calldata as a function call rather than a hex blob", () => {
    const decoded = decodeCalldata(ABI, call(CONTROLLER, true));
    expect("functionName" in decoded && decoded.functionName).toBe(
      "setController",
    );
    expect("args" in decoded && decoded.args[1]).toBe(true);
  });

  it("reports payload that is not the call it is claimed to be", () => {
    const decoded = decodeCalldata(ABI, "0xdeadbeef");
    expect("error" in decoded).toBe(true);
  });
});
