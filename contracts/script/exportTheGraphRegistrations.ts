#!/usr/bin/env bun

import { Command } from "commander";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { bold, cyan, dim, Logger } from "./logger.js";

// Types
interface ENSRegistration {
  id: string;
  labelName: string | null;
  registrant: {
    id: string | null;
  } | null;
  expiryDate: string | null;
  registrationDate: string | null;
  domain: {
    id: string | null;
    name: string | null;
    labelhash: string | null;
    parent: {
      id: string | null;
    } | null;
  } | null;
}

interface GraphQLResponse {
  data: {
    registrations: ENSRegistration[];
  };
  errors?: Array<{ message: string }>;
}

interface MetaResponse {
  data: {
    _meta: { block: { number: number } } | null;
  };
  errors?: Array<{ message: string }>;
}

export type ENSRegistrationNetwork = "mainnet" | "sepolia";

interface ExportConfig {
  thegraphApiKey: string;
  network: ENSRegistrationNetwork;
  batchSize: number;
  startId: string;
  limit: number | null;
  outputFile: string;
  block: number | null;
}

// Constants
const SUBGRAPH_IDS: Record<ENSRegistrationNetwork, string> = {
  mainnet: "5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH",
  sepolia: "G1SxZs317YUb9nQX3CC98hDyvxfMJNZH5pPRGpNrtvwN",
};
const GATEWAY_ENDPOINT_TEMPLATE =
  "https://gateway.thegraph.com/api/{API_KEY}/subgraphs/id/{SUBGRAPH_ID}";
const RATE_LIMIT_DELAY_MS = 200;

const logger = new Logger();

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

function requireTheGraphApiKey(value: string | undefined): string {
  const apiKey = value ?? envValue("THEGRAPH_API_KEY", "GRAPH_API_KEY");
  if (!apiKey) {
    throw new Error(
      "Missing --thegraph-api-key or THEGRAPH_API_KEY/GRAPH_API_KEY",
    );
  }
  return apiKey;
}

export function parseENSRegistrationNetwork(
  value: string,
): ENSRegistrationNetwork {
  if (value === "mainnet" || value === "sepolia") return value;
  throw new Error(`Unsupported ENS registrations network: ${value}`);
}

export function getGatewayEndpoint(config: {
  thegraphApiKey: string;
  network: ENSRegistrationNetwork;
}): string {
  return GATEWAY_ENDPOINT_TEMPLATE.replace(
    "{API_KEY}",
    config.thegraphApiKey,
  ).replace("{SUBGRAPH_ID}", SUBGRAPH_IDS[config.network]);
}

async function postGraphQL<T>(
  config: Pick<ExportConfig, "thegraphApiKey" | "network">,
  body: { query: string; variables?: Record<string, unknown> },
  fetchFn: typeof fetch,
): Promise<T> {
  const response = await fetchFn(getGatewayEndpoint(config), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HTTP error! status: ${response.status}, body: ${errorText}`,
    );
  }

  const result = (await response.json()) as T & {
    errors?: Array<{ message: string }>;
  };

  if (result.errors) {
    throw new Error(
      `GraphQL error: ${result.errors.map((e) => e.message).join(", ")}`,
    );
  }

  return result;
}

// The subgraph's current head. Every page is then requested at this exact height so
// registrations indexed mid-export cannot shift the result set.
export async function fetchIndexedBlock(
  config: Pick<ExportConfig, "thegraphApiKey" | "network">,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const result = await postGraphQL<MetaResponse>(
    config,
    { query: `query IndexedBlock { _meta { block { number } } }` },
    fetchFn,
  );
  const block = result.data?._meta?.block?.number;
  if (typeof block !== "number") {
    throw new Error("Invalid response from TheGraph: missing _meta.block");
  }
  return block;
}

// One page of registrations after `afterId`, ordered by id. Cursor paging is what
// makes a full export possible: gateways cap `skip`, and an offset into a live
// result set duplicates and drops rows as new registrations are indexed.
async function fetchRegistrations(
  config: ExportConfig,
  afterId: string,
  first: number,
  block: number,
  fetchFn: typeof fetch = fetch,
): Promise<ENSRegistration[]> {
  const query = `
    query GetEthRegistrations($first: Int!, $afterId: ID!, $block: Int!) {
      registrations(
        first: $first
        where: { id_gt: $afterId }
        orderBy: id
        orderDirection: asc
        block: { number: $block }
      ) {
        id
        labelName
        registrant {
          id
        }
        expiryDate
        registrationDate
        domain {
          id
          name
          labelhash
          parent {
            id
          }
        }
      }
    }
  `;

  const result = await postGraphQL<GraphQLResponse>(
    config,
    { query, variables: { first, afterId, block } },
    fetchFn,
  );

  if (!result.data || !result.data.registrations) {
    throw new Error(
      `Invalid response structure from TheGraph: missing data.registrations`,
    );
  }

  return result.data.registrations;
}

function escapeCSV(value: string | null | undefined): string {
  const text = value ?? "";
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function registrationToCSVRow(reg: ENSRegistration): string {
  return [
    escapeCSV(reg.domain?.id),
    escapeCSV(reg.domain?.name),
    // The registration id is the labelhash the registrar emitted. `domain.labelhash`
    // is only populated by the registry handler and is frequently null, so it cannot
    // be used as the key a reconciliation joins on.
    escapeCSV(reg.id),
    escapeCSV(reg.registrant?.id),
    "",
    "",
    escapeCSV(reg.labelName),
    escapeCSV(reg.registrationDate),
    escapeCSV(reg.expiryDate),
  ].join(",");
}

// Registrations whose label the subgraph could not decode are kept here rather than
// discarded. They cannot go in the main CSV — the pre-migration reader rejects an
// empty label cell — but they are real names, and their count and labelhashes are
// what a completeness check needs to report who cannot be migrated.
export function unlabelledFilePath(outputFile: string): string {
  return outputFile.replace(/(\.csv)?$/i, ".unlabelled.csv");
}

// Records how a CSV was produced. A reconciliation must not verify a CSV against the
// same indexer that generated it, and this is what lets that be checked rather than
// remembered.
export function sourceStampPath(outputFile: string): string {
  return `${outputFile}.source.json`;
}

export type CsvSourceStamp = {
  source: "subgraph";
  network: ENSRegistrationNetwork;
  subgraphId: string;
  block: number;
  /** Last registration id written; a resumed export continues after it. */
  lastId: string;
  /** False while rows are still being appended, so a partial file cannot be used. */
  complete: boolean;
  totalRegistrations: number;
  labelledRegistrations: number;
  unlabelledRegistrations: number;
};

function readSourceStamp(outputFile: string): CsvSourceStamp | null {
  const path = sourceStampPath(outputFile);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as CsvSourceStamp;
  } catch {
    return null;
  }
}

// Written after every page rather than only at the end, so an interrupted export
// leaves behind the cursor a resume needs and a `complete: false` that stops the
// partial file being read as a finished one.
function writeSourceStamp(
  config: ExportConfig,
  state: {
    block: number;
    cursor: string;
    totalCount: number;
    skippedNoLabel: number;
    complete: boolean;
  },
): void {
  const stamp: CsvSourceStamp = {
    source: "subgraph",
    network: config.network,
    subgraphId: SUBGRAPH_IDS[config.network],
    block: state.block,
    lastId: state.cursor,
    complete: state.complete,
    totalRegistrations: state.totalCount,
    labelledRegistrations: state.totalCount - state.skippedNoLabel,
    unlabelledRegistrations: state.skippedNoLabel,
  };
  writeFileSync(
    sourceStampPath(config.outputFile),
    `${JSON.stringify(stamp, null, 2)}\n`,
    "utf-8",
  );
}

export async function exportRegistrations(
  config: ExportConfig,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  let cursor = config.startId;
  let hasMore = true;
  let totalCount = 0;
  let skippedNoLabel = 0;
  // Only an empty or short page proves the source had nothing left. Stopping because
  // of --limit proves the opposite, and a file cut off there must not be stamped as
  // the whole registration set.
  let exhausted = false;
  // Stopping at --limit is a truncation whatever the last page's size said, so it is
  // tracked separately rather than inferred from the page.
  let limitTruncated = false;

  // A resume continues an existing file rather than starting one. Truncating here
  // would leave only the rows after the cursor, and the completed stamp written at
  // the end would present that suffix as the whole registration set.
  const resuming = config.startId !== "";
  const previous = resuming ? readSourceStamp(config.outputFile) : null;
  if (resuming) {
    if (!existsSync(config.outputFile) || !previous) {
      throw new Error(
        `cannot resume: ${config.outputFile} and its ${sourceStampPath(config.outputFile)} must both exist. Run the export without --start-id to begin one.`,
      );
    }
    if (previous.network !== config.network) {
      throw new Error(
        `cannot resume: ${config.outputFile} was exported from ${previous.network}, not ${config.network}`,
      );
    }
    if (previous.lastId !== config.startId) {
      throw new Error(
        `cannot resume at ${config.startId}: ${config.outputFile} stopped at ${previous.lastId}. Pass that id, or re-export from the start.`,
      );
    }
    if (config.block !== null && config.block !== previous.block) {
      throw new Error(
        `cannot resume at block ${config.block}: ${config.outputFile} was exported at block ${previous.block}`,
      );
    }
    totalCount = previous.totalRegistrations;
    skippedNoLabel = previous.unlabelledRegistrations;
  }

  // A resumed export stays pinned to the block the earlier pages were read at, or
  // the two halves of the file describe different chain states.
  const block =
    previous?.block ??
    config.block ??
    (await fetchIndexedBlock(config, fetchFn));
  logger.config("Pinned Block", block);

  const unlabelledFile = unlabelledFilePath(config.outputFile);
  if (!resuming) {
    writeFileSync(
      config.outputFile,
      "node,name,labelHash,owner,parentName,parentLabelHash,labelName,registrationDate,expiryDate\n",
      "utf-8",
    );
    writeFileSync(
      unlabelledFile,
      "labelHash,registrationDate,expiryDate\n",
      "utf-8",
    );
  }
  writeSourceStamp(config, {
    block,
    cursor,
    totalCount,
    skippedNoLabel,
    complete: false,
  });

  logger.info(
    resuming
      ? `Resuming ${cyan(config.outputFile)} after id ${cursor} (${totalCount} row(s) already written)`
      : `CSV file created: ${cyan(config.outputFile)}`,
  );
  logger.info(`Fetching registrations from TheGraph Gateway...\n`);

  while (hasMore) {
    try {
      let registrations = await fetchRegistrations(
        config,
        cursor,
        config.batchSize,
        block,
        fetchFn,
      );

      // Recorded before --limit trims the page, or a trimmed page would look like
      // the end of the result set. Recomputed rather than latched: a short page is
      // evidence about that page only, and a later full one withdraws it.
      exhausted = registrations.length < config.batchSize;

      if (registrations.length === 0) {
        hasMore = false;
        break;
      }

      if (config.limit && totalCount + registrations.length > config.limit) {
        registrations = registrations.slice(0, config.limit - totalCount);
        hasMore = false;
        limitTruncated = true;
      }

      // Rows whose label the subgraph could not decode go to the sidecar keyed by
      // labelhash: the pre-migration reader rejects an empty label cell, but the
      // names are real and a completeness check has to account for them.
      const labelled = registrations.filter(
        (reg) => (reg.labelName ?? "").trim() !== "",
      );
      const unlabelled = registrations.filter(
        (reg) => (reg.labelName ?? "").trim() === "",
      );
      skippedNoLabel += unlabelled.length;

      if (labelled.length > 0) {
        appendFileSync(
          config.outputFile,
          labelled.map(registrationToCSVRow).join("\n") + "\n",
          "utf-8",
        );
      }
      if (unlabelled.length > 0) {
        appendFileSync(
          unlabelledFile,
          unlabelled
            .map((reg) =>
              [
                escapeCSV(reg.id),
                escapeCSV(reg.registrationDate),
                escapeCSV(reg.expiryDate),
              ].join(","),
            )
            .join("\n") + "\n",
          "utf-8",
        );
      }

      totalCount += registrations.length;
      // Results are ordered by id, so the last row of a page is the cursor for the
      // next one. Advancing by a count instead would reintroduce offset paging.
      cursor = registrations[registrations.length - 1].id;
      writeSourceStamp(config, {
        block,
        cursor,
        totalCount,
        skippedNoLabel,
        complete: false,
      });

      logger.info(
        cyan(`Fetched and wrote ${registrations.length} registrations`) +
          dim(` (total: ${totalCount})`),
      );

      if (config.limit && totalCount >= config.limit) {
        hasMore = false;
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
    } catch (error) {
      logger.error(
        `Failed to fetch registrations after id=${cursor}: ${error}`,
      );
      throw error;
    }
  }

  writeSourceStamp(config, {
    block,
    cursor,
    totalCount,
    skippedNoLabel,
    complete: exhausted && !limitTruncated,
  });

  logger.info(
    `\nTotal registrations exported: ${bold((totalCount - skippedNoLabel).toString())}`,
  );
  if (skippedNoLabel > 0) {
    logger.info(
      `Recorded ${bold(skippedNoLabel.toString())} registration(s) with no decodable labelName in ${cyan(unlabelledFile)}`,
    );
  }
  if (!exhausted || limitTruncated) {
    logger.warning(
      `Stopped at the --limit of ${config.limit}, so this is a prefix of the registration set, not all of it. ` +
        `It is stamped incomplete and pre-migration will refuse it; continue with --start-id ${cursor}.`,
    );
    return;
  }
  logger.success(`Successfully exported to ${config.outputFile}`);
}

export async function main(argv = process.argv): Promise<void> {
  const program = new Command()
    .name("export-registrations")
    .description("Export ENS .eth 2LD registrations from TheGraph to CSV")
    .option(
      "--thegraph-api-key <key>",
      "TheGraph Gateway API key; falls back to THEGRAPH_API_KEY or GRAPH_API_KEY",
    )
    .option(
      "--network <network>",
      "ENS registrations network: mainnet or sepolia",
      "mainnet",
    )
    .option(
      "--batch-size <number>",
      "Number of names to fetch per TheGraph API request",
      "1000",
    )
    .option(
      "--start-id <labelhash>",
      "Resume after this registration id (exclusive); ids are ordered ascending",
      "",
    )
    .option("--limit <number>", "Maximum total number of names to fetch")
    .option(
      "--block <number>",
      "Pin the export to this indexed block; defaults to the subgraph head",
    )
    .option(
      "--output <file>",
      "Output CSV file path",
      `csv-data/ens-registrations-${new Date().toISOString().split("T")[0]}.csv`,
    );

  program.parse(argv);
  const opts = program.opts();

  const config: ExportConfig = {
    thegraphApiKey: requireTheGraphApiKey(opts.thegraphApiKey),
    network: parseENSRegistrationNetwork(opts.network),
    batchSize: parseInt(opts.batchSize) || 1000,
    startId: opts.startId || "",
    limit: opts.limit ? parseInt(opts.limit) : null,
    outputFile: opts.output,
    block: opts.block ? parseInt(opts.block) : null,
  };

  try {
    logger.header("ENS Registration Export");
    logger.divider();

    logger.info(`Configuration:`);
    logger.config(
      "TheGraph API Key",
      `${config.thegraphApiKey.substring(0, 8)}...`,
    );
    logger.config("Network", config.network);
    logger.config("Batch Size", config.batchSize);
    logger.config("Start After Id", config.startId || "none");
    logger.config("Limit", config.limit ?? "none");
    logger.config("Output File", config.outputFile);
    logger.info("");

    await exportRegistrations(config);

    logger.success("\nExport completed successfully!");
  } catch (error) {
    logger.error(`Fatal error: ${error}`);
    console.error(error);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
