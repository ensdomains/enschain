import hre from "hardhat";
import { describe, expect, it, test } from "vitest";

const connection = await hre.network.connect();

async function fixture() {
  return connection.viem.deployContract("MockLibISO8601Implementer");
}

const loadFixture = async () => connection.networkHelpers.loadFixture(fixture);

function timestampToISO8601(timestamp: bigint): string {
  const date = new Date(Number(timestamp) * 1000);
  return date.toISOString().replace(".000Z", "Z");
}

function dateToTimestamp(isoString: string): bigint {
  return BigInt(Math.floor(new Date(isoString).getTime() / 1000));
}

// =========================================================================
// All Input → Output Tests
// =========================================================================
const testCases = [
  [
    "Unix Epoch and Basic Tests",
    [
      ["1970-01-01T00:00:00Z", "Unix epoch"],
      ["1970-01-01T00:00:01Z", "One second after epoch"],
      ["1970-01-01T00:01:00Z", "One minute after epoch"],
      ["1970-01-01T01:00:00Z", "One hour after epoch"],
      ["1970-01-02T00:00:00Z", "One day after epoch"],
    ],
  ],
  [
    "Time Component Tests",
    [
      ["1970-01-02T00:00:00Z", "Midnight"],
      ["1970-01-01T12:00:00Z", "Noon"],
      ["1970-01-01T23:59:59Z", "End of day"],
      ["1970-01-01T01:23:45Z", "01:23:45"],
      ["1970-01-01T09:08:07Z", "09:08:07 - single digit padding"],
      ["1970-01-01T10:11:12Z", "10:11:12 - double digits"],
    ],
  ],
  [
    "Year Transition Tests",
    [
      ["1970-12-31T23:59:59Z", "End of 1970"],
      ["1971-01-01T00:00:00Z", "Start of 1971"],
      ["2000-01-01T00:00:00Z", "Y2K"],
      ["1999-12-31T23:59:59Z", "End of 1999"],
    ],
  ],
  [
    "Leap Year Tests",
    [
      ["2000-02-29T00:00:00Z", "Feb 29, 2000 - leap year divisible by 400"],
      ["2000-02-28T00:00:00Z", "Feb 28, 2000"],
      ["2000-03-01T00:00:00Z", "Mar 1, 2000 - day after Feb 29 in leap year"],
      ["2004-02-29T00:00:00Z", "Feb 29, 2004 - leap year divisible by 4"],
      ["2024-02-29T00:00:00Z", "Feb 29, 2024 - leap year"],
      ["2001-02-28T00:00:00Z", "Feb 28, 2001 - non-leap year"],
      [
        "2001-03-01T00:00:00Z",
        "Mar 1, 2001 - day after Feb 28 in non-leap year",
      ],
      ["2100-02-28T00:00:00Z", "Feb 28, 2100 - century year non-leap"],
      [
        "2100-03-01T00:00:00Z",
        "Mar 1, 2100 - day after Feb 28 in non-leap century year",
      ],
    ],
  ],
  [
    "Month Boundary Tests",
    [
      ["1970-01-31T00:00:00Z", "Jan 31 - 31-day month"],
      ["1970-02-01T00:00:00Z", "Feb 1"],
      ["1970-02-28T00:00:00Z", "Feb 28, 1970 - non-leap year"],
      ["1970-03-01T00:00:00Z", "Mar 1, 1970 - after Feb 28 in non-leap year"],
      ["1970-04-30T00:00:00Z", "Apr 30 - 30-day month"],
      ["1970-05-01T00:00:00Z", "May 1"],
      ["1970-06-30T00:00:00Z", "Jun 30 - 30-day month"],
      ["1970-07-31T00:00:00Z", "Jul 31 - 31-day month"],
      ["1970-08-31T00:00:00Z", "Aug 31 - 31-day month"],
      ["1970-09-30T00:00:00Z", "Sep 30 - 30-day month"],
      ["1970-10-31T00:00:00Z", "Oct 31 - 31-day month"],
      ["1970-11-30T00:00:00Z", "Nov 30 - 30-day month"],
      ["1970-12-31T00:00:00Z", "Dec 31 - 31-day month end of year"],
    ],
  ],
  [
    "Padding Tests",
    [
      ["1970-09-05T00:00:00Z", "Month 09 padded with zero"],
      ["1970-11-15T00:00:00Z", "Month 11 - double digit"],
      ["1970-01-05T00:00:00Z", "Day 05 padded with zero"],
      ["1970-01-25T00:00:00Z", "Day 25 - double digit"],
      ["1970-01-01T05:00:00Z", "Hour 05 padded with zero"],
      ["1970-01-01T00:07:00Z", "Minute 07 padded with zero"],
      ["1970-01-01T00:00:03Z", "Second 03 padded with zero"],
    ],
  ],
  [
    "Known Timestamps from Real-World Events",
    [
      ["2009-01-03T18:15:05Z", "Bitcoin genesis block"],
      ["2015-07-30T15:26:13Z", "Ethereum genesis block"],
      ["2022-09-15T06:42:42Z", "Ethereum Merge"],
    ],
  ],
  [
    "Far Future Dates",
    [
      ["2038-01-19T03:14:07Z", "Y2038 - max signed 32-bit timestamp"],
      ["2038-01-19T03:14:08Z", "One second after Y2038"],
      ["2100-01-01T00:00:00Z", "Year 2100"],
      ["3000-01-01T00:00:00Z", "Year 3000"],
      ["9999-12-31T23:59:59Z", "End of year 9999"],
    ],
  ],
  [
    "All Months of 2023",
    [
      ["2023-01-01T00:00:00Z", "January"],
      ["2023-02-01T00:00:00Z", "February"],
      ["2023-03-01T00:00:00Z", "March"],
      ["2023-04-01T00:00:00Z", "April"],
      ["2023-05-01T00:00:00Z", "May"],
      ["2023-06-01T00:00:00Z", "June"],
      ["2023-07-01T00:00:00Z", "July"],
      ["2023-08-01T00:00:00Z", "August"],
      ["2023-09-01T00:00:00Z", "September"],
      ["2023-10-01T00:00:00Z", "October"],
      ["2023-11-01T00:00:00Z", "November"],
      ["2023-12-01T00:00:00Z", "December"],
    ],
  ],
  [
    "Edge Cases",
    [
      ["1987-11-22T13:37:42Z", "All components non-zero"],
      ["1970-01-01T01:02:03Z", "All single digit time components padded"],
    ],
  ],
  [
    "Sequential Days",
    [
      ["1970-01-01T00:00:00Z", "Day 1"],
      ["1970-01-02T00:00:00Z", "Day 2"],
      ["1970-01-03T00:00:00Z", "Day 3"],
      ["1970-01-04T00:00:00Z", "Day 4"],
      ["1970-01-05T00:00:00Z", "Day 5"],
      ["1970-01-06T00:00:00Z", "Day 6"],
      ["1970-01-07T00:00:00Z", "Day 7"],
    ],
  ],
  [
    "Leap Year Boundary Tests",
    [
      ["2020-02-28T00:00:00Z", "Feb 28, 2020 (leap year)"],
      ["2020-02-29T00:00:00Z", "Feb 29, 2020 (leap year)"],
      ["2020-03-01T00:00:00Z", "Mar 1, 2020 (leap year)"],
      ["2019-02-28T00:00:00Z", "Feb 28, 2019 (non-leap year)"],
      ["2019-03-01T00:00:00Z", "Mar 1, 2019 (non-leap year)"],
    ],
  ],
  // Add to testCases array:
  [
    "Additional Edge Cases",
    [
      // Year 2400 - century year that IS a leap year (divisible by 400)
      ["2400-02-29T00:00:00Z", "Feb 29, 2400 - century leap year"],
      [
        "2400-03-01T00:00:00Z",
        "Mar 1, 2400 - after Feb 29 in century leap year",
      ],

      // Era boundary around year 2000 (algorithm's internal epoch is March 1, 2000)
      ["2000-02-29T23:59:59Z", "Last second of Feb 29, 2000 (era boundary)"],
      ["2000-03-01T00:00:00Z", "March 1, 2000 - algorithm epoch"],

      // Exact midnight transitions
      ["2020-02-29T23:59:59Z", "Last second of Feb 29, 2020 leap year"],
      ["2020-03-01T00:00:00Z", "First second of Mar 1, 2020"],
      ["2019-02-28T23:59:59Z", "Last second of Feb 28, 2019 non-leap year"],

      // Year 2400 era boundary
      ["2399-12-31T23:59:59Z", "End of era 5"],
      ["2400-01-01T00:00:00Z", "Start of era 6"],

      // Another century non-leap year for variety
      ["2200-02-28T00:00:00Z", "Feb 28, 2200 - century non-leap"],
      [
        "2200-03-01T00:00:00Z",
        "Mar 1, 2200 - after Feb 28 in non-leap century",
      ],
      ["2300-02-28T23:59:59Z", "Last second of Feb 28, 2300"],
    ],
  ],

  [
    "Boundary Timestamp Values",
    [
      // Maximum representable timestamp
      ["9999-12-31T23:59:59Z", "Maximum 4-digit year timestamp"],
      // One second before various boundaries
      ["1999-12-31T23:59:59Z", "One second before Y2K"],
      ["2099-12-31T23:59:59Z", "One second before 2100"],
    ],
  ],
] satisfies [string, [string, string][]][];

describe("LibISO8601", () => {
  describe.each(testCases)("%s", (_, cases) => {
    test.each(cases)("$1", async (expected) => {
      const contract = await loadFixture();
      const timestamp = dateToTimestamp(expected);
      const result = await contract.read.toISO8601([timestamp]);
      expect(result).toBe(expected);
    });
  });

  describe("Overflow Behavior", () => {
    it("should revert for timestamp of year 10000", async () => {
      const contract = await loadFixture();
      // 253402300800n = 10000-01-01T00:00:00Z
      await expect(contract.read.toISO8601([253402300800n]))
        .toBeRevertedWithCustomError("TimestampOutOfRange")
        .withArgs([253402300800n]);
    });
    it("should revert for timestamp of year 10000 + 1 second", async () => {
      const contract = await loadFixture();
      await expect(contract.read.toISO8601([253402300801n]))
        .toBeRevertedWithCustomError("TimestampOutOfRange")
        .withArgs([253402300801n]);
    });
  });

  describe("String Format Verification", () => {
    it("output length is always 20 characters", async () => {
      const contract = await loadFixture();

      let result = await contract.read.toISO8601([0n]);
      expect(result.length).toBe(20);

      const timestamp = dateToTimestamp("9999-12-31T23:59:59Z");
      result = await contract.read.toISO8601([timestamp]);
      expect(result.length).toBe(20);
    });

    it("format structure is correct", async () => {
      const contract = await loadFixture();
      const result = await contract.read.toISO8601([0n]);

      expect(result[4]).toBe("-");
      expect(result[7]).toBe("-");
      expect(result[10]).toBe("T");
      expect(result[13]).toBe(":");
      expect(result[16]).toBe(":");
      expect(result[19]).toBe("Z");
    });

    it("all digit positions are numeric", async () => {
      const contract = await loadFixture();
      const timestamp = dateToTimestamp("2009-02-13T23:31:30Z");
      const result = await contract.read.toISO8601([timestamp]);

      const isDigit = (c: string) => c >= "0" && c <= "9";
      const digitPositions = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18];
      for (const pos of digitPositions) {
        expect(isDigit(result[pos])).toBe(true);
      }
    });
  });

  describe("Fuzz/Bulk Tests", () => {
    test("100k random timestamps", async () => {
      const contract = await loadFixture();

      const ITERATIONS = 100_000;
      const BATCH_SIZE = 500;
      const MAX_TIMESTAMP = 253402300799n;

      let seed = 12345n;
      const nextRandom = (): bigint => {
        seed = (seed * 1103515245n + 12345n) % 2n ** 31n;
        return seed;
      };
      const randomTimestamp = (): bigint => nextRandom() % (MAX_TIMESTAMP + 1n);

      const errors: Array<{
        timestamp: bigint;
        solidity: string;
        javascript: string;
      }> = [];

      for (let batch = 0; batch < ITERATIONS / BATCH_SIZE; batch++) {
        const timestamps = Array.from({ length: BATCH_SIZE }, randomTimestamp);
        const results = await contract.read.toISO8601_batch([timestamps]);

        for (let i = 0; i < results.length; i++) {
          const jsResult = timestampToISO8601(timestamps[i]);
          if (results[i] !== jsResult) {
            errors.push({
              timestamp: timestamps[i],
              solidity: results[i],
              javascript: jsResult,
            });
          }
        }

        if ((batch + 1) % 20 === 0) {
          console.log(
            `  Progress: ${(
              (batch + 1) * BATCH_SIZE
            ).toLocaleString()} / ${ITERATIONS.toLocaleString()}`,
          );
        }
      }

      if (errors.length > 0) {
        console.error(`\nFound ${errors.length} mismatches:`);
        for (const err of errors.slice(0, 10)) {
          console.error(
            `  Timestamp ${err.timestamp}: Solidity="${err.solidity}" vs JS="${err.javascript}"`,
          );
        }
        throw new Error(
          `Fuzz test failed: ${errors.length} mismatches found out of ${ITERATIONS} tests`,
        );
      }

      console.log(`\n✓ All ${ITERATIONS.toLocaleString()} fuzz tests passed!`);
    }, 60_000);

    test("daily exhaustive from 1970-01-01 to 2970-01-01", async () => {
      const contract = await loadFixture();

      const SECONDS_PER_DAY = 86400n;
      const START_TIMESTAMP = 0n;
      const END_TIMESTAMP = dateToTimestamp("2970-01-01T00:00:00Z");
      const BATCH_SIZE = 500;

      const errors: Array<{
        timestamp: bigint;
        solidity: string;
        javascript: string;
      }> = [];

      let currentTimestamp = START_TIMESTAMP;
      let dayCount = 0;
      const totalDays = Number(
        (END_TIMESTAMP - START_TIMESTAMP) / SECONDS_PER_DAY,
      );

      console.log(
        `\nTesting ${totalDays.toLocaleString()} days (1000 years)...`,
      );

      while (currentTimestamp <= END_TIMESTAMP) {
        const timestamps: bigint[] = [];
        for (
          let i = 0;
          i < BATCH_SIZE && currentTimestamp <= END_TIMESTAMP;
          i++
        ) {
          timestamps.push(currentTimestamp);
          currentTimestamp += SECONDS_PER_DAY;
          dayCount++;
        }

        const results = await contract.read.toISO8601_batch([timestamps]);

        for (let i = 0; i < results.length; i++) {
          const jsResult = timestampToISO8601(timestamps[i]);
          if (results[i] !== jsResult) {
            errors.push({
              timestamp: timestamps[i],
              solidity: results[i],
              javascript: jsResult,
            });
          }
        }

        if (dayCount % 50000 < BATCH_SIZE) {
          const percent = ((dayCount / totalDays) * 100).toFixed(1);
          console.log(
            `  Progress: ${dayCount.toLocaleString()} / ${totalDays.toLocaleString()} days (${percent}%)`,
          );
        }
      }

      if (errors.length > 0) {
        console.error(`\nFound ${errors.length} mismatches:`);
        for (const err of errors.slice(0, 10)) {
          console.error(
            `  Timestamp ${err.timestamp}: Solidity="${err.solidity}" vs JS="${err.javascript}"`,
          );
        }
        throw new Error(
          `Daily exhaustive test failed: ${errors.length} mismatches found out of ${dayCount} days`,
        );
      }

      console.log(`\n✓ All ${dayCount.toLocaleString()} daily tests passed!`);
    }, 300_000);
  });
});
