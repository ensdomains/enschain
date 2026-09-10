import { loadDeploymentsFromFiles } from "@rocketh/node";
import { Command } from "commander";
import { resolve } from "path";
import { isProxyArtifact } from "./addressDocs.js";

const currentPath = new URL(import.meta.url).pathname;
const defaultDeploymentsDir = resolve(currentPath, "../..", "deployments");

const program = new Command()
  .option("--chain-name <name>", "Deployment network name", "sepolia-dev")
  .option(
    "--deployments-dir <path>",
    "Root directory for v2 deployment files",
    defaultDeploymentsDir,
  )
  .option(
    "--v1-deployments-dir <path>",
    "Root directory for v1 deployment files",
  )
  .option("--v2-only", "Only list v2 deployment files", false)
  .option(
    "--raw",
    "Include proxy implementation/proxy deployment artifacts",
    false,
  );

program.parse(process.argv);
const opts = program.opts<{
  chainName: string;
  deploymentsDir: string;
  v1DeploymentsDir?: string;
  v2Only: boolean;
  raw: boolean;
}>();

const deploymentsDir = resolve(opts.deploymentsDir);
const v1DeploymentsDir = opts.v1DeploymentsDir
  ? resolve(opts.v1DeploymentsDir)
  : resolve(deploymentsDir, "v1");

const deploymentRoots = opts.v2Only
  ? { v2: deploymentsDir }
  : { v1: v1DeploymentsDir, v2: deploymentsDir };

for (const [chain, root] of Object.entries(deploymentRoots)) {
  const deployments = await loadDeploymentsFromFiles(
    root,
    opts.chainName,
    false,
  ).then((d) => d.deployments);
  const names = new Set(Object.keys(deployments));
  const contracts = Object.entries(deployments)
    .filter(([name]) => opts.raw || !isProxyArtifact(name, names))
    .map(([name, deployment]) => ({
      name,
      address: (deployment as { address: string }).address,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (contracts.length === 0) {
    console.log(`${chain}: no deployments found in ${root}/${opts.chainName}`);
    continue;
  }

  console.log(chain);
  console.log(formatMarkdownTable(contracts));
}

function formatMarkdownTable(
  contracts: Array<{ name: string; address: string }>,
): string {
  const rows = [
    ["Name", "Address"],
    ["---", "---"],
    ...contracts.map(({ name, address }) => [name, address]),
  ];
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}
