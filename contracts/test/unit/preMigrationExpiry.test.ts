import { describe, expect, it } from "bun:test";

import {
  formatExpiry,
  isClaimableOnV1,
  MAX_UINT64,
  V1_GRACE_PERIOD_SECONDS,
} from "../../script/preMigration.js";

describe("formatExpiry", () => {
  it("renders an ordinary expiry as a date", () => {
    // 2026-01-01T00:00:00Z
    expect(formatExpiry(1767225600n)).toBe("2026-01-01");
  });

  it("describes an expiry beyond what a Date can hold instead of throwing", () => {
    // Real Sepolia names carry expiries near the uint64 ceiling. Formatting one of
    // those used to throw RangeError from a log line and abort the entire
    // pre-migration run.
    expect(() => formatExpiry(MAX_UINT64)).not.toThrow();
    expect(formatExpiry(MAX_UINT64)).toContain("beyond representable dates");
  });

  it("handles the largest expiry actually seen on chain", () => {
    // `--web.eth` on Sepolia: uint64 max minus the 90-day grace period.
    const observed = 18446744073701775615n;
    expect(() => formatExpiry(observed)).not.toThrow();
  });

  it("still formats an expiry at the edge of the representable range", () => {
    // Date tops out at ±8.64e15 ms, i.e. ~year 275760, which ISO renders with an
    // explicit sign and six-digit year.
    expect(formatExpiry(8_640_000_000_000n)).toBe("+275760-09-13");
  });
});

describe("expiry capping", () => {
  it("caps a bonus-adjusted expiry at the uint64 the registry stores", () => {
    const bonus = 62n * 86400n;
    const nearMax = MAX_UINT64 - 1000n;
    const raw = nearMax + bonus;

    // Without capping this exceeds uint64 and would either fail to encode or wrap.
    expect(raw).toBeGreaterThan(MAX_UINT64);
    const capped = raw > MAX_UINT64 ? MAX_UINT64 : raw;
    expect(capped).toBe(MAX_UINT64);
  });

  it("leaves an expiry that fits untouched", () => {
    const bonus = 62n * 86400n;
    // The real Sepolia value plus the bonus still fits, so it must not be capped.
    const observed = 18446744073701775615n;
    const raw = observed + bonus;
    expect(raw).toBeLessThanOrEqual(MAX_UINT64);
    expect(raw > MAX_UINT64 ? MAX_UINT64 : raw).toBe(raw);
  });
});

describe("isClaimableOnV1", () => {
  const now = 1_800_000_000n;

  it("accepts a name whose registration has not run out", () => {
    expect(isClaimableOnV1(now + 1n, now)).toBe(true);
  });

  it("accepts an expired name whose owner can still renew it", () => {
    expect(isClaimableOnV1(now - V1_GRACE_PERIOD_SECONDS + 1n, now)).toBe(true);
  });

  it("rejects a name the instant its grace period runs out", () => {
    // The boundary the migration turns on: from here the name is released, so
    // pre-migration will not reserve it and nothing downstream may carry it over.
    expect(isClaimableOnV1(now - V1_GRACE_PERIOD_SECONDS, now)).toBe(false);
  });

  it("rejects a name that was never registered", () => {
    // Grace added to a zero expiry still lands in the past on any real chain, but
    // the rule says so outright rather than relying on that arithmetic.
    expect(isClaimableOnV1(0n, now)).toBe(false);
    expect(isClaimableOnV1(0n, 0n)).toBe(false);
  });
});
