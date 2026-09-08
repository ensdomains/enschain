import { loadDeploymentsFromFiles } from "@rocketh/node";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_DOCS_DIR = resolve(
  new URL(import.meta.url).pathname,
  "../..",
  "docs",
  "addresses",
);

/// Block explorer base URLs keyed by chain id. Chains absent from this map
/// render plain (unlinked) addresses.
const EXPLORER_BASE: Record<number, string> = {
  1: "https://etherscan.io",
  11155111: "https://sepolia.etherscan.io",
};

export interface ContractEntry {
  name: string;
  address: string;
}

/// True for `<Base>_Implementation` / `<Base>_Proxy` artifacts whose `<Base>`
/// deployment also exists, so the proxy chain collapses to its canonical entry.
export function isProxyArtifact(name: string, names: Set<string>): boolean {
  for (const suffix of ["_Implementation", "_Proxy"]) {
    if (name.endsWith(suffix) && names.has(name.slice(0, -suffix.length))) {
      return true;
    }
  }
  return false;
}

/// Build the canonical, sorted list of contracts for a deployment namespace:
/// proxy implementation/proxy artifacts and entries without an address are
/// dropped, the remainder sorted alphabetically by name.
export function loadContractEntries(
  deployments: Record<string, unknown>,
): ContractEntry[] {
  const names = new Set(Object.keys(deployments));
  return Object.entries(deployments)
    .map(([name, deployment]) => ({
      name,
      address: (deployment as { address?: string }).address ?? "",
    }))
    .filter(({ name, address }) => address && !isProxyArtifact(name, names))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/// Etherscan address URL for a chain, or `null` when the chain is unknown.
export function explorerUrl(chainId: number, address: string): string | null {
  const base = EXPLORER_BASE[chainId];
  return base ? `${base}/address/${address}` : null;
}

/// Markdown address cell: an explorer link when the chain is known, otherwise
/// the plain address.
function addressCell(chainId: number | undefined, address: string): string {
  const url = chainId === undefined ? null : explorerUrl(chainId, address);
  return url ? `[${address}](${url})` : address;
}

function formatTable(
  contracts: ContractEntry[],
  chainId: number | undefined,
): string {
  const rows = [
    ["Contract", "Address"],
    ["---", "---"],
    ...contracts.map(({ name, address }) => [
      name,
      addressCell(chainId, address),
    ]),
  ];
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export interface GenerateAddressMarkdownOptions {
  /// Root deployments directory containing the namespace subdirectory.
  deploymentsDir: string;
  /// Namespace subdirectory to read artifacts from (e.g. `sepolia`).
  namespace: string;
  /// Canonical network name used for the output filename and heading (e.g.
  /// `sepolia`). Defaults to `namespace`.
  docName?: string;
  /// Output directory for the generated markdown. Defaults to
  /// `contracts/docs/addresses`.
  outDir?: string;
  /// Basename of the generated file, without the extension. Defaults to
  /// `docName`, which is what the canonical per-network docs use; a deployment
  /// that carries its own table alongside its artifacts sets this instead, so
  /// the file is found by a fixed name while the heading still names the
  /// network.
  fileName?: string;
  /// Line telling a reader how the file is produced. Defaults to the canonical
  /// docs command; a deploy that writes its own table names itself instead.
  generatedBy?: string;
  /// Further namespaces to tabulate under their own headings, after the main
  /// one. A clean testnet deploys its own v1 stack into a separate tree, and
  /// those addresses are as much a part of the deployment as the v2 ones — a
  /// reader given only the v2 table cannot reach the registry the names live in.
  extraSections?: {
    /// Heading for the section.
    title: string;
    /// Root deployments directory holding `namespace`. Defaults to the main one.
    deploymentsDir?: string;
    /// Namespace subdirectory to read.
    namespace: string;
  }[];
}

/// Generate a markdown address table for a deployment namespace and write it to
/// `<outDir>/<docName>.md`. Returns the written file path.
export async function generateAddressMarkdown(
  opts: GenerateAddressMarkdownOptions,
): Promise<string> {
  const deploymentsDir = resolve(opts.deploymentsDir);
  const docName = opts.docName ?? opts.namespace;
  const outDir = resolve(opts.outDir ?? DEFAULT_DOCS_DIR);

  const { deployments } = await loadDeploymentsFromFiles(
    deploymentsDir,
    opts.namespace,
    false,
  );
  const contracts = loadContractEntries(deployments);

  const namespaceDir = join(deploymentsDir, opts.namespace);
  const chain = readJson<{ chainId?: string | number }>(
    join(namespaceDir, ".chain"),
  );
  const deployment = readJson<{ deployedAt?: string }>(
    join(namespaceDir, ".deployment.json"),
  );
  const chainId =
    chain?.chainId !== undefined ? Number(chain.chainId) : undefined;

  const title = `# ENSv2 ${capitalize(docName)} Deployment Addresses`;
  const meta = [
    `- **Network:** ${docName}`,
    chainId !== undefined ? `- **Chain ID:** ${chainId}` : null,
    deployment?.deployedAt
      ? `- **Deployed at:** ${deployment.deployedAt}`
      : null,
  ].filter(Boolean) as string[];

  const sections: string[] = [formatTable(contracts, chainId)];
  for (const extra of opts.extraSections ?? []) {
    const extraDir = resolve(extra.deploymentsDir ?? opts.deploymentsDir);
    const loaded = await loadDeploymentsFromFiles(
      extraDir,
      extra.namespace,
      false,
    ).catch(() => null);
    const extraContracts = loaded
      ? loadContractEntries(loaded.deployments)
      : [];
    // A namespace that was never written is reported rather than omitted, so a
    // missing section reads as a fact about the deployment instead of looking
    // like the table simply forgot it.
    sections.push(
      "",
      `## ${extra.title}`,
      "",
      extraContracts.length
        ? formatTable(extraContracts, chainId)
        : `_No deployments found under \`${extra.namespace}\`._`,
    );
  }

  const body = [
    title,
    "",
    `> Auto-generated by ${opts.generatedBy ?? "`bun run docs:addresses`"}. Do not edit by hand.`,
    "",
    ...meta,
    "",
    ...sections,
    "",
  ].join("\n");

  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${opts.fileName ?? docName}.md`);
  writeFileSync(outPath, body);
  return outPath;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
