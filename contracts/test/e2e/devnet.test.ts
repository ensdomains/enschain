import { describe, expect, it } from "bun:test";
import { expectVar } from "../utils/expectVar.js";

describe("Devnet", () => {
  const { env, setupEnv, resetInitialState } = process.TEST_GLOBALS!;

  setupEnv({ resetOnEach: true });

  it("sync", async () => {
    await env.client.mine({ blocks: 1, interval: 10 }); // advance chain
    const block0 = await env.client.getBlock();
    const t = await env.sync();
    const block1 = await env.client.getBlock();
    expect(block1.timestamp).toBeGreaterThanOrEqual(block0.timestamp);
    expectVar({ t }).toStrictEqual(block1.timestamp);
  });

  it("warp", async () => {
    const warpSec = 60;
    const block0 = await env.client.getBlock();
    const t = await env.sync({ warpSec }); // time warp
    const block1 = await env.client.getBlock();
    expect(block1.timestamp - block0.timestamp).toBeGreaterThanOrEqual(warpSec);
    expect(block1.timestamp).toBeGreaterThanOrEqual(t);
    expectVar({ t }).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("saveState", async () => {
    const gateways = await env.shared.BatchGatewayProvider.read.gateways();
    await env.shared.BatchGatewayProvider.write.setGateways([[]], {
      account: env.namedAccounts.owner,
    });
    expect(
      env.shared.BatchGatewayProvider.read.gateways(),
    ).resolves.toStrictEqual([]);
    await resetInitialState();
    expect(
      env.shared.BatchGatewayProvider.read.gateways(),
    ).resolves.toStrictEqual(gateways);
  });

  it(`computeVerifiableProxyAddress`, async () => {
    const account = env.namedAccounts.deployer;
    const salt = 1234n;
    const contract = await env.deployPermissionedResolver({
      account,
      salt,
    });
    const address = env.computeVerifiableProxyAddress(account.address, salt);
    expect(address).toStrictEqual(contract.address);
  });
});
