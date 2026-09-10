import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000);

import { existsSync, unlinkSync } from "node:fs";
import { STATUS } from "../../script/deploy-constants.js";
import { preMigrateDevnetNames } from "../../script/preMigrateDevnetNames.js";
import {
  registerV1Name,
  setupBaseRegistrarController,
  verifyV2State,
} from "../utils/mockPreMigration.js";
import { idFromLabel } from "../utils/utils.js";

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

describe("preMigrateDevnetNames", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;

  const cleanupFiles = [
    "preMigration-checkpoint.json",
    "preMigration-errors.log",
    "preMigration.log",
  ];

  setupEnv({
    resetOnEach: true,
    async initialize() {
      await setupBaseRegistrarController(env);
    },
  });

  afterEach(() => {
    for (const file of cleanupFiles) {
      if (existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {}
      }
    }
  });

  it("reserves the given names on v2", async () => {
    const labels = ["premigone", "premigtwo"];
    const { user } = env.namedAccounts;
    for (const label of labels) {
      await registerV1Name(env, label, user.address, ONE_YEAR_SECONDS);
    }

    await preMigrateDevnetNames(env, { labels });

    for (const label of labels) {
      const state = await verifyV2State(env, label);
      expect(state.status).toBe(STATUS.RESERVED);
    }
  });

  it("reassigns v1 ownership of an unwrapped name to a devnet account", async () => {
    const label = "reassignme";
    const { user, user2 } = env.namedAccounts;
    await registerV1Name(env, label, user2.address, ONE_YEAR_SECONDS);

    await preMigrateDevnetNames(env, {
      labels: [label],
      reassignOwnerTo: "user",
    });

    const state = await verifyV2State(env, label);
    expect(state.status).toBe(STATUS.RESERVED);

    const owner = await env.v1.BaseRegistrar.read.ownerOf([idFromLabel(label)]);
    expect(owner.toLowerCase()).toBe(user.address.toLowerCase());
  });
});
