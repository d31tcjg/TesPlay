#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const bundleRoot = fileURLToPath(
  new URL("../vendor/tesplayer/", import.meta.url),
);
const repository = "https://github.com/rdvnit/TesPlayer";
const manifestPath = join(bundleRoot, "UPSTREAM.json");
const packages = ["contracts", "player"];
const metadata = new Set([
  "tsconfig.base.json",
  "packages/player/README.md",
  "packages/player/LICENSES.md",
  ...packages.flatMap((name) =>
    ["package.json", "tsconfig.json", "tsconfig.build.json"].map(
      (file) => `packages/${name}/${file}`,
    ),
  ),
]);
const digest = (value) => createHash("sha256").update(value).digest("hex");

function imported(path) {
  if (
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    path.includes("\\")
  )
    return false;
  return (
    metadata.has(path) ||
    /^packages\/(contracts|player)\/src\/.+\.ts$/u.test(path)
  );
}

function git(source, args, binary = false) {
  const result = spawnSync("git", ["-C", source, ...args], {
    encoding: binary ? null : "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Unable to read upstream Git revision: ${String(result.stderr).trim()}`,
    );
  return result.stdout;
}

function sourceFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Bundled source must not be a symlink: ${path}`);
    return entry.isDirectory()
      ? sourceFiles(join(directory, entry.name), path)
      : [path];
  });
}

function check() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.schema !== 1 ||
    manifest.repository !== repository ||
    !/^[a-f0-9]{40}$/u.test(manifest.revision) ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  )
    throw new Error("Invalid TesPlayer provenance manifest");
  const paths = Object.keys(manifest.files).sort();
  for (const required of [
    ...metadata,
    "packages/player/src/engine.ts",
    "packages/contracts/src/api.ts",
  ]) {
    if (!paths.includes(required))
      throw new Error(`Provenance manifest omits ${required}`);
  }
  for (const path of paths) {
    if (!imported(path) || !/^[a-f0-9]{64}$/u.test(manifest.files[path]))
      throw new Error(`Invalid provenance entry: ${path}`);
    const target = join(bundleRoot, path);
    if (
      !lstatSync(target).isFile() ||
      digest(readFileSync(target)) !== manifest.files[path]
    )
      throw new Error(
        `TesPlayer bundle differs from its pinned revision: ${path}`,
      );
  }
  for (const name of packages) {
    const prefix = `packages/${name}/src/`;
    const actual = sourceFiles(join(bundleRoot, prefix))
      .map((path) => prefix + path)
      .sort();
    const expected = paths.filter((path) => path.startsWith(prefix));
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(`Unrecorded or missing bundled ${name} source files`);
  }
  console.log(
    `TesPlayer bundle verified: ${manifest.revision} (${paths.length} files)`,
  );
}

function sync(source, revision) {
  if (!/^[a-f0-9]{40}$/u.test(revision))
    throw new Error("Use a full 40-character committed Git revision");
  if (git(source, ["cat-file", "-t", revision]).trim() !== "commit")
    throw new Error("Upstream revision must identify a commit");
  const files = new Map();
  for (const record of git(source, ["ls-tree", "-r", "-z", revision])
    .split("\0")
    .filter(Boolean)) {
    const [header, path] = record.split("\t");
    if (!imported(path ?? "")) continue;
    if (!/^100(644|755) blob /u.test(header))
      throw new Error(`Upstream source must be a regular file: ${path}`);
    files.set(path, git(source, ["show", `${revision}:${path}`], true));
  }
  for (const required of [
    ...metadata,
    "packages/player/src/engine.ts",
    "packages/contracts/src/api.ts",
  ]) {
    if (!files.has(required))
      throw new Error(`Upstream commit omits ${required}`);
  }
  // Read every immutable Git blob before replacing the tracked bundle. Generated
  // dist files are rebuilt by build:player; reference apps and tests are excluded.
  for (const name of packages)
    rmSync(join(bundleRoot, `packages/${name}/src`), {
      recursive: true,
      force: true,
    });
  const hashes = {};
  for (const [path, value] of [...files].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const target = join(bundleRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
    hashes[path] = digest(value);
  }
  writeFileSync(
    manifestPath,
    JSON.stringify(
      { schema: 1, repository, revision, files: hashes },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(bundleRoot, "UPSTREAM.md"),
    `TesPlayer engine and contracts vendored from ${repository}\nRevision: ${revision}.\nOnly the engine and contracts are included; reference frontend/API and tests are excluded.\nNo local source patches. UPSTREAM.json records SHA-256 digests for every imported file.\nRun npm run check:player to verify the bundle, and npm run build:player to rebuild dist.\nUpdate using npm run sync:player -- --source /path/to/TesPlayer --revision <full-commit-sha>.\nThe upstream package metadata is preserved unmodified. The owner-authored copy bundled here is distributed under TesPlay's root LICENSE and NOTICE; third-party terms still apply.\nDependency notices: packages/player/LICENSES.md and public/licenses/.\n`,
  );
  check();
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--check") check();
  else if (
    args.length === 4 &&
    args[0] === "--source" &&
    args[2] === "--revision"
  )
    sync(resolve(args[1]), args[3]);
  else
    throw new Error(
      "Usage: sync-tesplayer.mjs --check | --source <repository> --revision <full-commit-sha>",
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
