import { describe, expect, it } from "bun:test";
import type { Address } from "viem";

import { RHINESTONE_INTENT_EXECUTOR } from "../../script/deploy-constants.js";
import deployDefaultReverseRegistrarAdapter from "../../deploy/02_DefaultReverseRegistrarAdapter.js";
import deployReverseRegistrarAdapter from "../../deploy/02_ReverseRegistrarAdapter.js";
import deployHCAOwnerAndSessionValidator from "../../deploy/hca/01_HCAOwnerAndSessionValidator.js";
import {
  controllerAddressHistory,
  isHCAOnlyDeployment,
  replacedDeploymentAddresses,
  resolveHCAIntentExecutor,
  SUPERSEDED_CONTROLLER_ADDRESSES,
} from "../../deploy/hca/_helpers.js";

const MOCK_EXECUTOR = "0x0000000000000000000000000000000000000101" as Address;
const EXISTING_EXECUTOR =
  "0x0000000000000000000000000000000000000102" as Address;
const OVERRIDE_EXECUTOR =
  "0x0000000000000000000000000000000000000301" as Address;
const CURRENT_DEPLOYMENT =
  "0x0000000000000000000000000000000000000401" as Address;
const PREVIOUS_DEPLOYMENT =
  "0x0000000000000000000000000000000000000402" as Address;
const LEGACY_DEPLOYMENT =
  "0x0000000000000000000000000000000000000403" as Address;

describe("HCA deployment address resolution", () => {
  it("uses fixed production addresses on Sepolia before mock artifacts", () => {
    const tags = { hca: true, sepolia: true };

    expect(
      resolveHCAIntentExecutor({
        tags,
        localExecutor: MOCK_EXECUTOR,
        existingExecutor: EXISTING_EXECUTOR,
        env: {},
      }),
    ).toBe(RHINESTONE_INTENT_EXECUTOR);
  });

  it("uses the same Sepolia defaults for the live dev environment", () => {
    const tags = { hca: true, sepolia: true, dev: true };

    expect(resolveHCAIntentExecutor({ tags, env: {} })).toBe(
      RHINESTONE_INTENT_EXECUTOR,
    );
  });

  it("keeps local mocks for clean-testnet deployments", () => {
    const tags = { hca: true, sepolia: true, "clean-testnet": true };

    expect(
      resolveHCAIntentExecutor({
        tags,
        localExecutor: MOCK_EXECUTOR,
        existingExecutor: EXISTING_EXECUTOR,
        env: {},
      }),
    ).toBe(MOCK_EXECUTOR);
  });

  it("allows explicit environment overrides", () => {
    const tags = { hca: true, sepolia: true };
    const env = {
      HCA_INTENT_EXECUTOR: OVERRIDE_EXECUTOR,
    };

    expect(resolveHCAIntentExecutor({ tags, env })).toBe(OVERRIDE_EXECUTOR);
  });
});

describe("HCA deployment script scope", () => {
  it("includes both reverse adapters in an HCA-only deploy", () => {
    expect(isHCAOnlyDeployment(["hca"])).toBe(true);
    expect(deployDefaultReverseRegistrarAdapter.tags).toContain("hca");
    expect(deployReverseRegistrarAdapter.tags).toContain("hca");
  });

  it("pins the HCA validator to stable authorization dependencies", () => {
    expect(deployHCAOwnerAndSessionValidator.dependencies).toContain(
      "DefaultReverseRegistrarAdapter",
    );
    expect(deployHCAOwnerAndSessionValidator.dependencies).not.toContain(
      "DefaultReverseRegistrarHCAAdapter",
    );
    expect(deployHCAOwnerAndSessionValidator.dependencies).toContain(
      "ETHRegistry",
    );
    expect(deployHCAOwnerAndSessionValidator.dependencies).toContain(
      "PermissionedResolverImpl",
    );
    expect(deployHCAOwnerAndSessionValidator.dependencies).not.toContain(
      "ETHRegistrar",
    );
  });

  it("identifies unique prior adapter addresses for controller revocation", () => {
    const priorDeployment = {
      address: PREVIOUS_DEPLOYMENT,
      linkedData: {
        [SUPERSEDED_CONTROLLER_ADDRESSES]: [LEGACY_DEPLOYMENT],
      },
    };

    expect(
      controllerAddressHistory([
        priorDeployment,
        { address: LEGACY_DEPLOYMENT },
      ]),
    ).toEqual([PREVIOUS_DEPLOYMENT, LEGACY_DEPLOYMENT]);
    expect(
      replacedDeploymentAddresses({ address: CURRENT_DEPLOYMENT }, [
        { address: CURRENT_DEPLOYMENT },
        priorDeployment,
        { address: LEGACY_DEPLOYMENT },
        null,
      ]),
    ).toEqual([PREVIOUS_DEPLOYMENT, LEGACY_DEPLOYMENT]);
  });

  it("preserves prior controller addresses across an interrupted resume", () => {
    const replacementDeployment = {
      address: CURRENT_DEPLOYMENT,
      linkedData: {
        [SUPERSEDED_CONTROLLER_ADDRESSES]: [
          PREVIOUS_DEPLOYMENT,
          LEGACY_DEPLOYMENT,
        ],
      },
    };

    expect(
      replacedDeploymentAddresses(replacementDeployment, [
        replacementDeployment,
      ]),
    ).toEqual([PREVIOUS_DEPLOYMENT, LEGACY_DEPLOYMENT]);
  });
});
