import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
interface Manifest {
  name: string;
  files: string[];
  pi: { extensions: string[] };
  devDependencies: Record<string, string>;
}
function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")) as Manifest;
}
const rootManifest = readManifest(root);
const packages = readdirSync(resolve(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name);

describe("package manifests", () => {
  it("loads every local package exactly once from the root", () => {
    const expected = packages.flatMap((name) => {
      const directory = resolve(root, "packages", name);
      return readManifest(directory).pi.extensions.map((entry) => resolve(directory, entry));
    }).sort();
    expect(rootManifest.pi.extensions.map((entry) => resolve(root, entry)).sort()).toEqual(expected);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it.each(packages)("keeps %s standalone and aligned with the root toolchain", (name) => {
    const directory = resolve(root, "packages", name);
    const manifest = readManifest(directory);
    expect(manifest.name).toBe(name);
    expect(manifest.devDependencies).toEqual(rootManifest.devDependencies);
    for (const path of [...manifest.files, ...manifest.pi.extensions]) {
      expect(existsSync(resolve(directory, path)), `${name}: missing ${path}`).toBe(true);
    }
    for (const entry of manifest.pi.extensions) {
      expect(manifest.files.some((path) => resolve(directory, entry).startsWith(`${resolve(directory, path)}/`)
        || resolve(directory, entry) === resolve(directory, path))).toBe(true);
    }
  });
});
