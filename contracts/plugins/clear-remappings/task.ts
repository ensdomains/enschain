import type { TaskOverrideActionFunction } from "hardhat/types/tasks";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const REMAPPINGS_PATHS = [
  "../../lib/ens-contracts/remappings.txt",
  "../../lib/nexus/remappings.txt",
].map((path) => resolve(import.meta.dirname, path));

// This is for emptying out remappings.txt files in submodules so that they do
// not break the build. We already have the required remappings in our own local
// file, but the build process still reads submodule remappings whose npm-style
// targets do not exist in this checkout.

const action: TaskOverrideActionFunction = async (
  taskArguments,
  _hre,
  runSuper,
) => {
  const originals = await Promise.all(
    REMAPPINGS_PATHS.map(
      async (path) => [path, await readFile(path, "utf8")] as const,
    ),
  );
  await Promise.all(originals.map(([path]) => writeFile(path, "")));
  try {
    return await runSuper(taskArguments);
  } finally {
    await Promise.all(
      originals.map(([path, original]) => writeFile(path, original)),
    );
  }
};

export default action;
