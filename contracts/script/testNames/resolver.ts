import type { Address } from "viem";

import type { DevnetAccount, DevnetEnvironment } from "../setup.js";
import { trackGas } from "./gas.js";
import { COIN_TYPE_ETH, dnsEncodeName } from "../../test/utils/utils.js";

/**
 * Deploy a resolver and set default records
 */
export async function setupResolver(
  env: DevnetEnvironment,
  account: DevnetAccount,
  name: string,
  records: {
    description?: string;
    address?: Address;
  },
  shouldTrackGas: boolean = false,
) {
  const { resolver } = account;

  if (shouldTrackGas) {
    trackGas("deployResolver", resolver.deploymentReceipt);
  }

  // Set ETH address (coin type 60)
  if (records.address) {
    const receipt = await env.waitFor(
      resolver.write.setAddress([
        dnsEncodeName(name),
        COIN_TYPE_ETH,
        records.address,
      ]),
    );
    if (shouldTrackGas) trackGas(`setAddr(${name})`, receipt);
  }

  // Set description text record
  if (records.description) {
    const receipt = await env.waitFor(
      resolver.write.setText([
        dnsEncodeName(name),
        "description",
        records.description,
      ]),
    );
    if (shouldTrackGas) trackGas(`setText(${name})`, receipt);
  }

  return resolver;
}
