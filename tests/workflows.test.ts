import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const desktop = readFileSync(new URL("../.github/workflows/system-controls.yml", import.meta.url), "utf8");
const web = readFileSync(new URL("../.github/workflows/web.yml", import.meta.url), "utf8");

describe("development and production CI contract", () => {
  it.each([desktop, web])("checks PRs and pushes to both long-lived branches with read-only permissions", (workflow) => {
    expect(workflow).toMatch(/pull_request:\n    branches: \[dev, production\]/);
    expect(workflow).toMatch(/push:\n    branches: \[dev, production\]/);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toMatch(/pull_request_target|secrets\.|id-token: write|contents: write/);
    for (const [, action] of workflow.matchAll(/uses: (\S+)/g)) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("checks all desktop platforms and uploads development executables only on dev pushes", () => {
    expect(desktop).toContain("os: [macos-latest, windows-latest, ubuntu-24.04]");
    expect(desktop.match(/if: github.event_name == 'push' && github.ref == 'refs\/heads\/dev'/g)).toHaveLength(2);
    expect(desktop).toContain("npm run tauri:build -- --debug --no-bundle");
    expect(desktop).toContain("src-tauri/target/debug/deck.exe");
    expect(desktop).toContain("src-tauri/target/debug/deck\n");
    expect(desktop).toContain("if-no-files-found: error");
  });

  it("keeps landing and SDK checks plus the production promotion gate", () => {
    expect(web).toContain("npm run landing:build");
    expect(web).toContain("npm --prefix packages/plugin-sdk test");
    expect(web).toContain("github.base_ref == 'production'");
    expect(web).toContain('"$HEAD_BRANCH" != dev');
    expect(web).toContain('"$HEAD_REPOSITORY" != "$GITHUB_REPOSITORY"');
  });
});
