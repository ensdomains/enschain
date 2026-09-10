import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { readSnapshotFile } from "./snapshot-utils.js";

type RevertTaskArgs = {
  snapshotId: string;
  file: string;
};

const action: NewTaskActionFunction<RevertTaskArgs> = async (args, hre) => {
  if (args.snapshotId === "" && args.file === "") {
    throw new Error("Provide --snapshot-id or --file");
  }
  const snapshotId = args.snapshotId || (await readSnapshotFile(args.file));
  const connection = await hre.network.connect();
  try {
    const result = await connection.provider.request({
      method: "evm_revert",
      params: [snapshotId],
    });
    if (result !== true) {
      throw new Error(
        `evm_revert failed for snapshot ${snapshotId}: ${String(result)}`,
      );
    }
    console.log(`reverted snapshot: ${snapshotId}`);
  } finally {
    await connection.close();
  }
};

export default action;
