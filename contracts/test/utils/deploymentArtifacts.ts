import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/// Writing the deployment artifacts the migration commands read.
///
/// The commands resolve addresses from files on disk rather than from a live
/// environment, so a test that drives one has to lay out a namespace for it. Three
/// suites had grown their own copy of this, and the copies differed in ways that
/// matter: one dropped the bigint replacer, so an artifact carrying a bigint threw
/// during serialisation rather than being written.

type DeploymentLike = {
  address: `0x${string}`;
  abi: readonly unknown[];
};

/// Whatever record the test wants, under `<root>/<namespace>/<name>.json`.
///
/// Serialised with a bigint replacer: an ABI or a recorded constructor argument can
/// carry one, and `JSON.stringify` throws on it by default.
export function writeDeploymentRecord(
  root: string,
  namespace: string,
  name: string,
  record: unknown,
): void {
  const dir = join(root, namespace);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify(record, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
}

/// The address and ABI, which is all most callers read back.
export function writeDeploymentArtifact(
  root: string,
  namespace: string,
  name: string,
  deployment: DeploymentLike,
): void {
  writeDeploymentRecord(root, namespace, name, {
    address: deployment.address,
    abi: deployment.abi,
  });
}

/// The `.chain` sidecar that tells the loader which chain a namespace describes.
export function writeNamespaceMetadata(
  root: string,
  namespace: string,
  chainId = "1",
): void {
  mkdirSync(join(root, namespace), { recursive: true });
  writeFileSync(
    join(root, namespace, ".chain"),
    JSON.stringify({ environment: namespace, chainId }),
  );
}

/// A whole namespace: every named deployment, plus its `.chain` sidecar.
export function writeDeploymentNamespace(
  root: string,
  namespace: string,
  deployments: Iterable<readonly [string, DeploymentLike]>,
  chainId = "1",
): void {
  for (const [name, deployment] of deployments) {
    writeDeploymentArtifact(root, namespace, name, deployment);
  }
  writeNamespaceMetadata(root, namespace, chainId);
}
