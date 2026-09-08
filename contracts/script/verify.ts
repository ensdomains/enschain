#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes } from "viem";

// Submits every deployed contract of a network for source-code verification.
//
// Etherscan goes through @rocketh/verifier, which rebuilds the solc standard-json
// input from each artifact's recorded metadata. That requires the literal source
// content of every input file: hardhat-compiled artifacts embed it, forge-compiled
// ones record only each source's hash and URLs. To make verification work
// regardless of which compiler produced an artifact, the content is backfilled
// from disk — keyed by the metadata source paths and checked against the recorded
// hash — into a throwaway copy of the deployment set before handing off.
//
// Sourcify is submitted to directly, because its API takes the metadata and the
// sources as separate fields and so needs no such rewriting. That separation
// matters: whether the canonical metadata embeds source content is decided by the
// `useLiteralContent` compiler setting, and altering it either way would change
// the metadata hash the on-chain bytecode commits to.

const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCIFY_SERVER = "https://sourcify.dev/server";
// A submission is queued server-side; the job is polled until it reports
// completion, then bounded so a stuck job fails the run instead of hanging.
const SOURCIFY_POLL_INTERVAL_MS = 2_000;
const SOURCIFY_POLL_TIMEOUT_MS = 300_000;
// Spacing between submissions, and the wait before retrying a throttled one when
// the server names no `Retry-After`.
const SOURCIFY_SUBMIT_SPACING_MS = 500;
const SOURCIFY_THROTTLE_BACKOFF_MS = 15_000;
const SOURCIFY_THROTTLE_RETRIES = 3;

type Backend = "etherscan" | "sourcify";

type Artifact = {
  address: string;
  metadata?: string;
  contractName?: string;
  transaction?: { hash?: string };
};

function parseArgs(argv: string[]) {
  let network: string | undefined;
  let backends: Backend[] = ["etherscan", "sourcify"];
  let skipV1 = false;
  let sourcifyServer = SOURCIFY_SERVER;
  const passthrough: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--network" || arg === "-n" || arg === "-e") {
      network = argv[++i];
    } else if (arg === "--etherscan-only") {
      backends = ["etherscan"];
    } else if (arg === "--sourcify-only") {
      backends = ["sourcify"];
    } else if (arg === "--sourcify-server") {
      sourcifyServer = argv[++i];
    } else if (arg === "--skip-v1") {
      skipV1 = true;
    } else {
      passthrough.push(arg);
    }
  }
  if (!network) {
    throw new Error(
      "usage: bun ./script/verify.ts --network <name> [--etherscan-only|--sourcify-only] [--sourcify-server <url>] [--skip-v1] [<extra rocketh-verify args>] (do not separate extra args with --; they are forwarded as-is)",
    );
  }
  return { network, backends, skipV1, sourcifyServer, passthrough };
}

// The deployed metadata records source paths under solc's source unit prefix
// (e.g. `project/src/...`, `project/lib/...`); the foundry project root maps to
// the contracts directory, so the prefix is stripped to resolve the file.
function diskPathForSource(sourceKey: string) {
  return resolve(contractsDir, sourceKey.replace(/^project\//, ""));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function artifactFiles(dir: string) {
  return readdirSync(dir).filter(
    (file) => file.endsWith(".json") && !file.startsWith("."),
  );
}

function readChainId(dir: string) {
  const chainFile = join(dir, ".chain");
  if (!existsSync(chainFile)) {
    throw new Error(`deployment set has no .chain file: ${dir}`);
  }
  const { chainId } = JSON.parse(readFileSync(chainFile, "utf8"));
  if (!chainId) throw new Error(`no chainId recorded in ${chainFile}`);
  return String(chainId);
}

// A deployment can record no metadata at all, or an empty stub in place of one —
// both occur for contracts adopted from an earlier deployment rather than
// compiled here. Neither carries the compiler settings and source list a
// verification is rebuilt from, so neither can be submitted.
function usableMetadata(raw: unknown) {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const metadata = JSON.parse(raw);
  if (!metadata?.compiler?.version || !metadata.sources) return undefined;
  return metadata;
}

// Every input file's literal content, taken from the metadata where the compiler
// embedded it and read from disk otherwise. A source read from disk is checked
// against the hash the metadata recorded, so a working tree that has moved on
// since the deployment fails loudly instead of verifying against the wrong code.
function sourceContents(metadata: any, label: string): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const [sourceKey, source] of Object.entries<any>(
    metadata.sources ?? {},
  )) {
    if (typeof source.content === "string") {
      contents[sourceKey] = source.content;
      continue;
    }
    const diskPath = diskPathForSource(sourceKey);
    if (!existsSync(diskPath)) {
      throw new Error(
        `cannot resolve source for ${label}: ${sourceKey} not found at ${diskPath}`,
      );
    }
    const content = readFileSync(diskPath, "utf8");
    if (source.keccak256 && keccak256(toBytes(content)) !== source.keccak256) {
      throw new Error(
        `source hash mismatch for ${sourceKey} (file on disk differs from the deployed source)`,
      );
    }
    contents[sourceKey] = content;
  }
  return contents;
}

function backfillSourceContent(artifactPath: string) {
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  if (typeof artifact.metadata !== "string") return false;

  const metadata = JSON.parse(artifact.metadata);
  const label = artifact.contractName ?? artifactPath;
  const contents = sourceContents(metadata, label);
  let patched = 0;
  for (const [sourceKey, source] of Object.entries<any>(
    metadata.sources ?? {},
  )) {
    if (source.content !== undefined) continue;
    source.content = contents[sourceKey];
    patched++;
  }
  if (patched === 0) return false;

  artifact.metadata = JSON.stringify(metadata);
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  return true;
}

async function sourcifyJson(response: Response) {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(
      `sourcify returned a non-JSON response (${response.status}): ${body.slice(0, 200)}`,
    );
  }
}

// Sourcify accepts a submission and completes it asynchronously, so the job is
// polled until it reports completion. A completed job still answers 200 when the
// verification itself failed; the outcome is in the match fields and `error`.
async function awaitSourcifyJob(server: string, verificationId: string) {
  const deadline = Date.now() + SOURCIFY_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(SOURCIFY_POLL_INTERVAL_MS);
    const response = await fetch(`${server}/v2/verify/${verificationId}`);
    const job = await sourcifyJson(response);
    if (!response.ok) {
      throw new Error(job.message ?? `job lookup failed (${response.status})`);
    }
    if (!job.isJobCompleted) continue;
    if (job.error) {
      throw new Error(job.error.message ?? JSON.stringify(job.error));
    }
    const match = job.contract?.match;
    if (!match) throw new Error("verification completed without a match");
    return match as string;
  }
  throw new Error(
    `verification did not complete within ${SOURCIFY_POLL_TIMEOUT_MS / 1000}s`,
  );
}

async function isVerifiedOnSourcify(
  server: string,
  chainId: string,
  address: string,
) {
  // The minimal contract record always carries the match fields, so no field
  // selector is needed — and `match` is not one the selector accepts. An unknown
  // contract answers 404 with the same shape and a null match.
  const response = await fetch(`${server}/v2/contract/${chainId}/${address}`);
  if (response.status === 404) return undefined;
  const body = await sourcifyJson(response);
  if (!response.ok) {
    throw new Error(
      body.message ?? `contract lookup failed (${response.status})`,
    );
  }
  return body.match ?? undefined;
}

async function submitToSourcify(
  server: string,
  chainId: string,
  artifact: Artifact,
  metadata: any,
  sources: Record<string, string>,
) {
  const body = JSON.stringify({
    metadata,
    sources,
    // The creation transaction lets Sourcify match the creation bytecode as well
    // as the runtime bytecode, which is the stronger of the two verifications.
    ...(artifact.transaction?.hash
      ? { creationTransactionHash: artifact.transaction.hash }
      : {}),
  });

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(
      `${server}/v2/verify/metadata/${chainId}/${artifact.address}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
    );

    if (response.status === 429 && attempt < SOURCIFY_THROTTLE_RETRIES) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : SOURCIFY_THROTTLE_BACKOFF_MS,
      );
      continue;
    }

    const result = await sourcifyJson(response);
    // An already-verified contract is reported as a conflict rather than a
    // success, and is nothing to act on when re-running the command.
    if (response.status === 409) return undefined;
    if (!response.ok) {
      throw new Error(
        result.message ?? `submission failed (${response.status})`,
      );
    }
    return await awaitSourcifyJob(server, result.verificationId);
  }
}

/// Verifies one deployment set on Sourcify, returning the names that failed.
async function verifyOnSourcify({
  srcDir,
  label,
  server,
}: {
  srcDir: string;
  label: string;
  server: string;
}) {
  const chainId = readChainId(srcDir);
  const failures: string[] = [];

  for (const file of artifactFiles(srcDir)) {
    const name = file.replace(/\.json$/, "");
    const artifact: Artifact = JSON.parse(
      readFileSync(join(srcDir, file), "utf8"),
    );
    try {
      const metadata = usableMetadata(artifact.metadata);
      if (!metadata) {
        console.log(`${name}: deployed without usable metadata, skipping`);
        continue;
      }

      const existing = await isVerifiedOnSourcify(
        server,
        chainId,
        artifact.address,
      );
      if (existing) {
        console.log(`${name}: already verified (${existing}), skipping`);
        continue;
      }

      const match = await submitToSourcify(
        server,
        chainId,
        artifact,
        metadata,
        sourceContents(metadata, name),
      );
      console.log(
        match ? `${name}: verified (${match})` : `${name}: already verified`,
      );
    } catch (error) {
      console.error(`${name}: ${(error as Error).message}`);
      failures.push(name);
    } finally {
      await sleep(SOURCIFY_SUBMIT_SPACING_MS);
    }
  }

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} contract(s) failed Sourcify verification for ${label}: ${failures.join(", ")}`,
    );
  }
  return failures;
}

/// Verifies one deployment set on Etherscan through `rocketh-verify`.
///
/// The set is staged under its own throwaway root and handed over as a flat
/// environment name. A v1 stack lives at `deployments/v1/<namespace>`, and passing
/// that path as the environment would put a separator in the name, so the leaf is
/// staged on its own instead.
function verifyOnEtherscan({
  srcDir,
  envName,
  label,
  passthrough,
}: {
  srcDir: string;
  envName: string;
  label: string;
  passthrough: string[];
}) {
  const stagingRoot = mkdtempSync(join(tmpdir(), "rocketh-verify-"));
  const stagingDir = join(stagingRoot, envName);
  cpSync(srcDir, stagingDir, { recursive: true });

  try {
    let backfilled = 0;
    for (const file of artifactFiles(stagingDir)) {
      if (backfillSourceContent(join(stagingDir, file))) {
        console.log(
          `backfilled source content for ${file.replace(/\.json$/, "")}`,
        );
        backfilled++;
      }
    }
    if (backfilled > 0) {
      console.log(
        `backfilled ${backfilled} artifact(s) missing literal sources\n`,
      );
    }

    console.log(`\n=== verifying ${label} on etherscan ===`);
    execFileSync(
      "bun",
      [
        "run",
        "rocketh-verify",
        "--",
        "-d",
        stagingRoot,
        "-e",
        envName,
        "etherscan",
        ...passthrough,
      ],
      { cwd: contractsDir, stdio: "inherit", env: process.env },
    );
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  const { network, backends, skipV1, sourcifyServer, passthrough } = parseArgs(
    process.argv.slice(2),
  );

  const srcDir = join(contractsDir, "deployments", network);
  if (!existsSync(srcDir)) {
    throw new Error(
      `no deployments found for network "${network}" (${srcDir})`,
    );
  }

  const targets = [{ srcDir, envName: network, label: network }];

  // A clean testnet deploys its own ENSv1 stack into `deployments/v1/<ns>`, and
  // those contracts need verifying as much as the v2 ones. Nothing distinguishes
  // that tree from a network's real v1 by inspection, so both are offered and
  // `--skip-v1` opts out; already-verified contracts are skipped by the backend
  // regardless.
  const v1Dir = join(contractsDir, "deployments", "v1", network);
  if (!skipV1 && existsSync(v1Dir)) {
    targets.push({
      srcDir: v1Dir,
      envName: network,
      label: `${network} (ENSv1)`,
    });
  }

  console.log(
    `verifying ${targets.length} deployment set(s): ${targets
      .map((t) => t.label)
      .join(", ")}`,
  );

  let failures = 0;
  for (const target of targets) {
    if (backends.includes("etherscan")) {
      verifyOnEtherscan({ ...target, passthrough });
    }
    if (backends.includes("sourcify")) {
      console.log(`\n=== verifying ${target.label} on sourcify ===`);
      failures += (
        await verifyOnSourcify({ ...target, server: sourcifyServer })
      ).length;
    }
  }

  if (failures > 0) process.exitCode = 1;
}

await main();
