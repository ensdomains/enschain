// Global test setup
import { afterAll, beforeAll, beforeEach, expect } from "bun:test";
import { isAddress, isAddressEqual, type Address } from "viem";
import {
  type DevnetEnvironment,
  type StateSnapshot,
  setupDevnet,
} from "../../script/setup.js";

declare global {
  namespace NodeJS {
    interface Process {
      TEST_GLOBALS?: {
        env: DevnetEnvironment;
        resetInitialState: StateSnapshot;
        setupEnv(options: {
          resetOnEach: boolean;
          initialize?: () => Promise<unknown>;
        }): void;
      };
    }
  }
}

expect.extend({
  // bug: bun custom maters don't relay `message`
  toEqualAddress(actual, expected: Address) {
    const pass =
      typeof actual === "string" &&
      isAddress(actual) &&
      isAddressEqual(actual, expected);
    return {
      pass,
      message: () =>
        `expected ${this.utils.printReceived(actual)}${pass ? " not " : " "}to equal address ${this.utils.printExpected(expected)}`,
    };
  },
});

const t0 = Date.now();

const env = await setupDevnet({ procLog: false, chainId: 1 });

// save the initial state
const resetInitialState = await env.saveState();

console.log(new Date(), `Ready! <${Date.now() - t0}ms>`);

// the state that gets reset on each
let resetEachState: StateSnapshot | undefined = resetInitialState; // default to full reset

// the environment is shared between all tests
process.TEST_GLOBALS = {
  env,
  resetInitialState,
  setupEnv({ resetOnEach, initialize }) {
    beforeAll(async () => {
      if (!resetOnEach || initialize) {
        await resetInitialState();
      }
      resetEachState = resetOnEach ? resetInitialState : undefined;
      if (initialize) {
        await initialize();
        if (resetOnEach) {
          resetEachState = await env.saveState();
        }
      }
      if (!resetOnEach) {
        await env.sync();
      }
    });
  },
};

beforeEach(async () => {
  await resetEachState?.();
  if (resetEachState) {
    await env.sync();
  }
});

afterAll(async () => {
  await env.shutdown();
});
