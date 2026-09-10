import { readdir, writeFile, mkdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const V1_PREFIX = "lib/ens-contracts/";
const GENERATED_DIR = new URL("../generated/", import.meta.url).pathname;
const OUT_DIR = new URL("../lib/ens-contracts/generated/", import.meta.url)
  .pathname;

/**
 * Create re-export files in lib/ens-contracts/generated/ so that
 * ens-contracts deploy scripts can resolve `generated/artifacts/X.js`
 * and `generated/abis/X.js` via their own tsconfig paths.
 *
 * For contracts compiled from lib/ens-contracts/ sources, prefer the
 * path-qualified version (which is guaranteed to be the ens-contracts
 * build) over the short-named version (which may be a v2 contract
 * with the same name).
 */
export async function patchArtifactsV1() {
  for (const subdir of ["artifacts", "abis"] as const) {
    await patchDir(subdir);
  }
  await writeArtifactIndexShim();
}

async function patchDir(subdir: "artifacts" | "abis") {
  const srcDir = join(GENERATED_DIR, subdir);
  const outDir = join(OUT_DIR, subdir);
  await mkdir(outDir, { recursive: true });

  // Collect all path-qualified ens-contracts files
  // e.g. generated/artifacts/lib/ens-contracts/.../ContractName.ts
  const v1Dir = join(srcDir, V1_PREFIX);
  const v1Files = await collectFiles(v1Dir).catch(() => []);

  // Map short name -> path-qualified relative import path
  const reexports = new Map<string, string>();

  for (const absPath of v1Files) {
    if (!absPath.endsWith(".ts")) continue;
    const name = basename(absPath, ".ts");
    // relative path from outDir to the path-qualified file
    const relPath = relative(outDir, absPath);
    reexports.set(name, relPath);
  }

  // For any short-named file NOT already covered by a path-qualified
  // ens-contracts file, check if it's an ens-contracts contract by
  // looking at its sourceName. If so, re-export the short name version.
  const topFiles = await readdir(srcDir).catch(() => []);
  for (const file of topFiles) {
    if (!file.endsWith(".ts") || file === "index.ts") continue;
    const name = basename(file, ".ts");
    if (reexports.has(name)) continue; // path-qualified version takes priority
    const relPath = relative(outDir, join(srcDir, file));
    reexports.set(name, relPath);
  }

  // Write re-export files
  for (const [name, relPath] of reexports) {
    const exportName =
      subdir === "artifacts" ? `Artifact_${name}` : `Abi_${name}`;
    const importPath = relPath.startsWith(".") ? relPath : `./${relPath}`;
    const content = `export { ${exportName} } from "${importPath}";\n`;
    await writeFile(join(outDir, `${name}.ts`), content);
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function writeArtifactIndexShim() {
  const content = `import artifacts from "../../../script/artifacts.js";

const v1Artifacts = new Proxy(artifacts, {
  get(target, prop, receiver) {
    if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
    const suffix = \`_\${prop}\`;
    const key = Object.keys(target).find(
      (name) => name.startsWith("lib_ens_contracts_") && name.endsWith(suffix),
    );
    if (key) return target[key];
    return Reflect.get(target, prop, receiver);
  },
});

export default v1Artifacts;
`;
  await writeFile(join(OUT_DIR, "artifacts.js"), content);
}
