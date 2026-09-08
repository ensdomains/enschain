#!/usr/bin/env bun
import { existsSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// The ENSv1 migration fixture corpus ships compressed because it expands to
// ~54MB of scenario JSONL. It is extracted next to the other operator-supplied
// CSV input, which is gitignored, so the working copy stays out of git while the
// archive itself is tracked.
const contractsDir = resolve(dirname(import.meta.dir));
const archive = join(contractsDir, "fixtures", "migration-fixture.tgz");
const destination = join(contractsDir, "csv-data");
const extracted = join(destination, "migration-fixture");

// `tar` restores each entry's archived timestamp, so the extracted directory
// would always look older than the archive. The directory is stamped with the
// current time after a successful extraction instead, which also re-extracts
// correctly after a checkout: git writes the archive with the checkout time, so
// a newly fetched corpus is always newer than whatever was unpacked before.
function isCurrent(): boolean {
  if (!existsSync(extracted)) return false;
  return statSync(extracted).mtimeMs >= statSync(archive).mtimeMs;
}

// A missing or unreadable archive leaves the corpus absent rather than failing
// the install: it is optional test scaffolding, and the `fixture` commands that
// need it already fail with the path they could not find.
if (!existsSync(archive)) {
  console.warn(`migration fixture archive not found: ${archive}`);
  process.exit(0);
}

if (isCurrent()) process.exit(0);

// The extraction root is gitignored, so a fresh checkout does not have it and
// `tar` refuses to change into a directory it will not create itself.
mkdirSync(destination, { recursive: true });

const result = spawnSync("tar", ["xzf", archive, "-C", destination], {
  stdio: ["ignore", "inherit", "inherit"],
});

if (result.status !== 0) {
  console.warn(
    `could not extract ${archive} (tar exited ${result.status ?? "abnormally"}); ` +
      "run `bun run fixtures:extract` once the cause is fixed",
  );
  process.exit(0);
}

const now = new Date();
utimesSync(extracted, now, now);

console.log(`extracted migration fixture corpus to ${extracted}`);
