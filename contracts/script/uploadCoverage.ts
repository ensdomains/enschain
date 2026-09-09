import { $ } from "bun";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

const SUFFIX = ".lcov";
const PREFIX = "filtered-";
const DIR = "./coverage/";
const CODECOV_PGP_KEY_URL = "https://keybase.io/codecovsecops/pgp_keys.asc";

const rootDir = new URL("../", import.meta.url);
const coverageDir = new URL(DIR, rootDir);

if (!process.env.CC_TOKEN) throw new Error("CC_TOKEN is not set");

let codecovPath = "./codecov";

// check if codecov-cli is installed
const codecov = await $`which codecov`.nothrow().quiet();
if (codecov.exitCode !== 0) {
  // only install on CI
  if (!process.env.CI) throw new Error("Please install codecov-cli");

  // install
  const installUrl = "https://cli.codecov.io/latest/linux/codecov";
  await $`curl -Os ${installUrl}`;

  // integrity check
  await $`curl ${CODECOV_PGP_KEY_URL} | gpg --no-default-keyring --keyring trustedkeys.gpg --import`;
  await $`curl -Os ${installUrl}.SHA256SUM`;
  await $`curl -Os ${installUrl}.SHA256SUM.sig`;

  await $`gpgv codecov.SHA256SUM.sig codecov.SHA256SUM`;
  await $`shasum -a 256 -c codecov.SHA256SUM`;

  await $`chmod +x codecov`;
} else {
  codecovPath = "codecov";
}

const globalOpts = [
  `-t ${process.env.CC_TOKEN}`,
  ...(process.env.CC_GIT_SERVICE
    ? [`--git-service ${process.env.CC_GIT_SERVICE}`]
    : []),
  ...(process.env.CC_SHA ? [`--sha ${process.env.CC_SHA}`] : []),
];

// release the queued reports once every job has finished uploading
if (process.argv.includes("--notify")) {
  await $`bash -c "${[codecovPath, "send-notifications", ...globalOpts].join(" ")}"`;
} else {
  const uploadCmd = [
    codecovPath,
    "upload-coverage",
    ...globalOpts,
    ...(process.env.CC_PR ? [`--pr ${process.env.CC_PR}`] : []),
    // an explicit file is additive to whatever the search finds, so turn the
    // search off to keep each flag scoped to its own report
    "--disable-search",
  ];

  const coverageFiles = readdirSync(coverageDir).filter(
    (file) => file.startsWith(PREFIX) && file.endsWith(SUFFIX),
  );

  for (const file of coverageFiles) {
    const flagName = basename(file, SUFFIX).replace(PREFIX, "");
    const filePath = join(coverageDir.pathname, file);
    await $`bash -c "${uploadCmd.join(" ")} --flag ${flagName} --file ${filePath}"`;
  }
}
