import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createRpcSnapshot,
  saveRpcSnapshotFile,
} from "../../../script/migrate.js";

// The canonical snapshot create/save implementations (and the JSON payload shape of
// the snapshot file) live in script/migrations/rpc.ts; these are thin re-exports so the
// Hardhat tasks and the standalone CLI cannot drift apart.
export const createSnapshot = createRpcSnapshot;

export async function saveSnapshotFile(
  path: string,
  snapshotId: string,
  network: string,
): Promise<void> {
  saveRpcSnapshotFile(path, snapshotId, network);
}

export async function readSnapshotFile(path: string): Promise<string> {
  const contents = await readFile(resolve(path), "utf8");
  try {
    const parsed = JSON.parse(contents);
    if (typeof parsed.snapshotId === "string") return parsed.snapshotId;
  } catch {
    // Plain snapshot id files are also accepted.
  }
  const snapshotId = contents.trim();
  if (!snapshotId) throw new Error(`snapshot file is empty: ${path}`);
  return snapshotId;
}
