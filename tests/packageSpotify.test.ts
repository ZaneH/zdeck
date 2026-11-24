import { afterEach, describe, expect, it } from "vitest";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const scriptUrl = new URL("../scripts/package-spotify.mjs", import.meta.url).href;
const { packageSpotify } = await import(scriptUrl) as { packageSpotify: (directory: string) => Promise<string> };
const fixtures: string[] = [];
async function fixture() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "zdeck-spotify-package-")));
  fixtures.push(temp);
  return temp;
}
afterEach(async () => { for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true }); });
async function files(path: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = prefix + entry.name;
    expect(entry.isSymbolicLink(), `Unexpected symlink: ${name}`).toBe(false);
    if (entry.isDirectory()) result.push(...await files(join(path, entry.name), name + "/"));
    else result.push(name);
  }
  return result.sort();
}

describe("self-contained Spotify folder packaging", () => {
  it("copies only runtime files and licenses, installs as catalog ID spotify, and describes using the bundled public SDK", async () => {
    const temp = await fixture();
    const output = join(temp, "build/spotify");
    expect(await packageSpotify(output)).toBe(output);
    expect(await files(output)).toEqual([
      ".zdeck-generated", "LICENSE", "README.md", "main.js", "manifest.json",
      "node_modules/@zdeck/plugin-sdk/LICENSE", "node_modules/@zdeck/plugin-sdk/index.d.ts",
      "node_modules/@zdeck/plugin-sdk/index.js", "node_modules/@zdeck/plugin-sdk/package.json", "package.json", "spotify.js",
    ]);
    for (const name of ["main.js", "spotify.js", "manifest.json"]) {
      expect(await readFile(join(output, name), "utf8")).toBe(await readFile(new URL(`../plugins/spotify/${name}`, import.meta.url), "utf8"));
    }
    expect(await readFile(join(output, "spotify.js"), "utf8")).toContain("from '@zdeck/plugin-sdk'");
    const metadata = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
    expect(metadata.scripts).toBeUndefined();
    expect(metadata.dependencies).toEqual({ "@zdeck/plugin-sdk": "0.1.0" });
    expect(JSON.stringify(metadata)).not.toContain("file:");
    const installed = join(temp, "home/.config/zdeck/plugins/spotify");
    await mkdir(dirname(installed), { recursive: true });
    await cp(output, installed, { recursive: true });
    const manifest = JSON.parse(await readFile(join(installed, "manifest.json"), "utf8"));
    expect(manifest.id).toBe("spotify");
    const describe = spawnSync(process.execPath, ["main.js"], { cwd: installed, encoding: "utf8", timeout: 5000,
      input: '{"protocolVersion":1,"id":"package-check","type":"describe"}\n' });
    expect(describe.status, describe.stderr).toBe(0);
    expect(describe.stderr).toBe("");
    expect(JSON.parse(describe.stdout)).toEqual({ protocolVersion: 1, id: "package-check", type: "result", manifest });
    const resolution = spawnSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@zdeck/plugin-sdk'))"],
      { cwd: installed, encoding: "utf8", timeout: 5000 });
    expect(resolution.status, resolution.stderr).toBe(0);
    expect(new URL(resolution.stdout.trim()).pathname).toBe(join(installed, "node_modules/@zdeck/plugin-sdk/index.js"));
  });

  it("reproduces an installed source-only folder failure and fixes the isolated copy only with the complete artifact, without PATH or global SDKs", async () => {
    const temp = await fixture();
    const sourceCopy = join(temp, "source-home/.config/zdeck/plugins/spotify");
    await mkdir(dirname(sourceCopy), { recursive: true });
    await mkdir(sourceCopy);
    for (const name of ["package.json", "manifest.json", "main.js", "spotify.js"]) {
      await cp(new URL(`../plugins/spotify/${name}`, import.meta.url), join(sourceCopy, name));
    }
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: "" };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const node = await realpath(process.execPath);
    const describe = (folder: string) => spawnSync(node, [join(folder, "main.js")], {
      cwd: folder, env, encoding: "utf8", timeout: 5000, maxBuffer: 65536,
      input: '{"protocolVersion":1,"id":"source-regression","type":"describe"}\n',
    });
    const missing = describe(sourceCopy);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(missing.stderr).toContain("@zdeck/plugin-sdk");
    const artifact = join(temp, "build/spotify");
    await packageSpotify(artifact);
    const installed = join(temp, "complete-home/.config/zdeck/plugins/spotify");
    await mkdir(dirname(installed), { recursive: true });
    await cp(artifact, installed, { recursive: true });
    const complete = describe(installed);
    expect(complete.status, complete.stderr).toBe(0);
    expect(complete.stderr).toBe("");
    expect(JSON.parse(complete.stdout)).toEqual({ protocolVersion: 1, id: "source-regression", type: "result",
      manifest: JSON.parse(await readFile(join(installed, "manifest.json"), "utf8")) });
    expect((await files(sourceCopy)).some((name) => name.startsWith("node_modules/"))).toBe(false);
  });

  it("installs the source SDK offline from a clean repository layout and describes without any registry dependency", async () => {
    const temp = await fixture();
    const plugin = join(temp, "repo/plugins/spotify");
    const sdk = join(temp, "repo/packages/plugin-sdk");
    await mkdir(plugin, { recursive: true });
    await mkdir(sdk, { recursive: true });
    for (const name of ["package.json", "package-lock.json", "manifest.json", "main.js", "spotify.js"]) {
      await cp(new URL(`../plugins/spotify/${name}`, import.meta.url), join(plugin, name));
    }
    for (const name of ["package.json", "index.js", "index.d.ts", "LICENSE"]) {
      await cp(new URL(`../packages/plugin-sdk/${name}`, import.meta.url), join(sdk, name));
    }
    const metadata = JSON.parse(await readFile(join(plugin, "package.json"), "utf8"));
    expect(metadata.dependencies).toEqual({ "@zdeck/plugin-sdk": "file:../../packages/plugin-sdk" });
    const install = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", [
      "install", "--prefix", plugin, "--ignore-scripts", "--offline", "--no-audit", "--no-fund",
      "--cache", join(temp, "empty-cache"), "--registry", "http://127.0.0.1:1",
    ], { cwd: temp, encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
    expect(install.status, install.stderr).toBe(0);
    const lock = JSON.parse(await readFile(join(plugin, "package-lock.json"), "utf8"));
    expect(Object.keys(lock.packages).sort()).toEqual(["", "../../packages/plugin-sdk", "node_modules/@zdeck/plugin-sdk"]);
    expect(lock.packages["node_modules/@zdeck/plugin-sdk"]).toEqual({ resolved: "../../packages/plugin-sdk", link: true });
    expect(JSON.stringify(lock)).not.toMatch(/https?:/);
    expect(await realpath(join(plugin, "node_modules/@zdeck/plugin-sdk"))).toBe(sdk);
    expect((await lstat(join(plugin, "node_modules/@zdeck/plugin-sdk"))).isSymbolicLink()).toBe(true);
    const describe = spawnSync(process.execPath, [join(plugin, "main.js")], {
      cwd: plugin, encoding: "utf8", timeout: 5000, maxBuffer: 65536,
      input: '{"protocolVersion":1,"id":"local-install","type":"describe"}\n',
    });
    expect(describe.status, describe.stderr).toBe(0);
    expect(describe.stderr).toBe("");
    expect(JSON.parse(describe.stdout)).toEqual({ protocolVersion: 1, id: "local-install", type: "result",
      manifest: JSON.parse(await readFile(join(plugin, "manifest.json"), "utf8")) });
  });

  it("can replace its own known files atomically without modifying hardlink targets", async () => {
    const temp = await fixture(), output = join(temp, "spotify");
    await packageSpotify(output);
    const outside = join(temp, "original-main.js");
    await link(join(output, "main.js"), outside);
    await writeFile(outside, "user data\n");
    await packageSpotify(output);
    expect(await readFile(outside, "utf8")).toBe("user data\n");
    expect(await readFile(join(output, "main.js"), "utf8")).not.toBe("user data\n");
  });

  it("refuses unowned, unexpected or symlinked output without removing user files", async () => {
    const temp = await fixture(), unowned = join(temp, "unowned");
    await mkdir(unowned);
    await writeFile(join(unowned, "main.js"), "keep me");
    await expect(packageSpotify(unowned)).rejects.toThrow("not owned");
    expect(await readFile(join(unowned, "main.js"), "utf8")).toBe("keep me");
    const owned = join(temp, "owned");
    await packageSpotify(owned);
    await writeFile(join(owned, "unexpected.txt"), "keep this too");
    const before = await readFile(join(owned, "main.js"), "utf8");
    await expect(packageSpotify(owned)).rejects.toThrow("unexpected");
    expect(await readFile(join(owned, "main.js"), "utf8")).toBe(before);
    expect(await readFile(join(owned, "unexpected.txt"), "utf8")).toBe("keep this too");
    const alias = join(temp, "alias");
    await symlink(owned, alias, "dir");
    await expect(packageSpotify(alias)).rejects.toThrow("Unsafe");
    const empty = join(temp, "empty");
    await mkdir(empty);
    const parentLink = join(temp, "parent-link");
    await symlink(empty, parentLink, "dir");
    await expect(packageSpotify(join(parentLink, "spotify"))).rejects.toThrow("symlink");
    expect(await readdir(empty)).toEqual([]);
    const internal = join(temp, "internal");
    await packageSpotify(internal);
    await rm(join(internal, "node_modules"), { recursive: true });
    await symlink(empty, join(internal, "node_modules"), "dir");
    await expect(packageSpotify(internal)).rejects.toThrow("symlink");
    await expect(packageSpotify("relative/output")).rejects.toThrow("absolute");
  });
});
