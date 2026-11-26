import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { once } from "node:events";
const script = new URL("../scripts/package-spotify.mjs", import.meta.url).href;
const { packageHomeAssistant, packageSpotify } = await import(script) as {
  packageHomeAssistant(path: string): Promise<string>; packageSpotify(path: string): Promise<string>;
};
const fixtures: string[] = [];
afterEach(async () => { for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true }); });
it("packages Home Assistant offline with a regular bundled SDK and no installation or connection", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zdeck-ha-package-"))); fixtures.push(root);
  const output = join(root, "home-assistant");
  expect(await packageHomeAssistant(output)).toBe(output);
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  expect(manifest.id).toBe("home-assistant");
  const metadata = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
  expect(metadata.scripts).toBeUndefined();
  expect(JSON.stringify(metadata)).not.toContain("file:");
  const described = spawnSync(process.execPath, ["main.js"], { cwd: output, encoding: "utf8", timeout: 5000,
    input: '{"protocolVersion":1,"id":"r1","type":"describe"}\n' });
  expect(described.status, described.stderr).toBe(0);
  expect(described.stderr).toBe("");
  expect(JSON.parse(described.stdout)).toEqual({ protocolVersion: 1, id: "r1", type: "result", manifest });
  await packageHomeAssistant(output);
  await expect(packageSpotify(output)).rejects.toThrow("not owned");
  await writeFile(join(output, "keep.txt"), "unrelated");
  await expect(packageHomeAssistant(output)).rejects.toThrow("unexpected");
  expect(await readFile(join(output, "keep.txt"), "utf8")).toBe("unrelated");
});

it("runs the packaged SDK through owned local HTTP discovery, explicit power, readback and uncertainty without retries", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zdeck-ha-http-"))); fixtures.push(root);
  const output = await packageHomeAssistant(join(root, "home-assistant"));
  let power = "off", apply = true;
  const calls: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  const entity = () => ({ entity_id: "switch.fixture", state: power, attributes: { friendly_name: "Owned test fixture" } });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method!, url: request.url!, auth: request.headers.authorization, body });
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/states") response.end(JSON.stringify([entity()]));
    else if (request.method === "GET" && request.url === "/api/states/switch.fixture") response.end(JSON.stringify(entity()));
    else if (request.method === "POST" && request.url === "/api/services/switch/turn_on") {
      if (apply) power = "on";
      response.end("[]");
    } else { response.statusCode = 404; response.end("{}"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing owned fixture address");
  const child = spawn(process.execPath, ["main.js"], { cwd: output, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let serial = 0, stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const request = async (fields: Record<string, unknown>) => {
    child.stdin.write(JSON.stringify({ protocolVersion: 1, id: `r${++serial}`, ...fields }) + "\n");
    const line = await lines.next();
    expect(line.done).toBe(false);
    expect(line.value).not.toContain("fixture-token");
    return JSON.parse(line.value!);
  };
  try {
    expect((await request({ type: "describe" })).manifest.id).toBe("home-assistant");
    expect((await request({ type: "configure", settings: { url: `http://127.0.0.1:${address.port}`, token: "fixture-token" } })).state).toEqual({});
    expect(calls).toHaveLength(0);
    expect((await request({ type: "execute", action: "power", args: { entity: 1, enabled: true } })).error.code).toBe("state_required");
    expect(calls).toHaveLength(0);
    const binding = (await request({ type: "state" })).state.entities[0].value;
    const success = await request({ type: "execute", action: "power", args: { entity: binding, enabled: true } });
    expect(success.state.entities[0].label).toBe("Owned test fixture");
    expect(success.state.entities[0].description).toBe("switch.fixture");
    expect(success.state.entities[0].observation.value).toBe(true);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(JSON.parse(calls.find((call) => call.method === "POST")!.body)).toEqual({ entity_id: "switch.fixture" });
    expect(calls.every((call) => call.auth === "Bearer fixture-token")).toBe(true);
    power = "off"; apply = false;
    const failed = await request({ type: "execute", action: "power", args: { entity: binding, enabled: true } });
    expect(failed.error).toMatchObject({ code: "outcome_unknown", outcome: "unknown" });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
    const count = calls.length;
    expect((await request({ type: "execute", action: "power", args: { entity: binding, enabled: true } })).error.code).toBe("outcome_unknown");
    expect(calls).toHaveLength(count);
    child.stdin.end(); await once(child, "exit");
    expect(stderr).toBe("");
  } finally {
    if (child.exitCode === null) child.kill();
    lines.return?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15000);
