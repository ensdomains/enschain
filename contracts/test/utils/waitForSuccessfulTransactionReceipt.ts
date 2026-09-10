import {
  type Address,
  type Client,
  type Hash,
  type TransactionReceipt,
} from "viem";
import { waitForTransactionReceipt } from "viem/actions";

type WaitForSuccessfulTransactionReceiptParams = {
  hash: Hash;
  ensureDeployment?: boolean;
};

type SuccessfulTransactionReceipt = TransactionReceipt & { status: "success" };
type DeployedTransactionReceipt = SuccessfulTransactionReceipt & {
  contractAddress: Address;
};

export async function waitForSuccessfulTransactionReceipt(
  client: Client,
  { hash, ensureDeployment }: { hash: Hash; ensureDeployment: true },
): Promise<DeployedTransactionReceipt>;
export async function waitForSuccessfulTransactionReceipt(
  client: Client,
  { hash, ensureDeployment }: { hash: Hash; ensureDeployment?: false },
): Promise<SuccessfulTransactionReceipt>;
export async function waitForSuccessfulTransactionReceipt(
  client: Client,
  { hash, ensureDeployment }: WaitForSuccessfulTransactionReceiptParams,
): Promise<TransactionReceipt> {
  const receipt = await waitForTransactionReceipt(client, { hash });
  if (ensureDeployment && receipt.contractAddress === null)
    throw new Error("Deployment failed");
  if (receipt.status !== "success") throw new Error("Transaction failed");
  return receipt;
}
