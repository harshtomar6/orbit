import { readFileSync } from "node:fs";

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error("Release tags must use semantic versioning, for example v0.2.0 or v0.2.0-beta.1.");
}

const expected = tag.slice(1);
const jsonVersion = (path) => JSON.parse(readFileSync(path, "utf8")).version;
const cargo = readFileSync("apps/client/src-tauri/Cargo.toml", "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = [
  ["package.json", jsonVersion("package.json")],
  ["apps/client/package.json", jsonVersion("apps/client/package.json")],
  ["apps/client/src-tauri/tauri.conf.json", jsonVersion("apps/client/src-tauri/tauri.conf.json")],
  ["apps/client/src-tauri/Cargo.toml", cargoVersion],
];
const mismatches = versions.filter(([, version]) => version !== expected);

if (mismatches.length) {
  throw new Error(`Tag ${tag} does not match:\n${mismatches.map(([path, version]) => `- ${path}: ${version ?? "missing"}`).join("\n")}`);
}

console.log(`Release ${tag} matches every desktop package version.`);
