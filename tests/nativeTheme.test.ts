import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/theme-packages/midnight-maze.json";
import {
  installNativeTheme,
  listNativeThemes,
  nativeThemeAvailable,
  parseInstalledThemes,
  pickNativeTheme,
  removeNativeTheme,
} from "../src/lib/nativeTheme";
import { validateThemePackage } from "../src/lib/themePackage";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), native: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/lib/native", () => ({ nativeAvailable: mocks.native }));

const packageValue = validateThemePackage(fixture)!;
const source = JSON.stringify(packageValue);
const reference = { id: packageValue.id, version: packageValue.version, digest: "a".repeat(64) };
const installed = { package: packageValue, reference, source };

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.native.mockReturnValue(true);
});

describe("native external theme bridge", () => {
  it("reports desktop availability and lists only strictly parsed installed themes", async () => {
    expect(nativeThemeAvailable()).toBe(true);
    mocks.native.mockReturnValue(false);
    expect(nativeThemeAvailable()).toBe(false);

    mocks.native.mockReturnValue(true);
    mocks.invoke.mockResolvedValue([installed]);
    expect(await listNativeThemes()).toEqual([installed]);
    expect(mocks.invoke).toHaveBeenCalledWith("theme_list", {});

    for (const bad of [null, {}, [installed, { ...installed, extra: true }],
      [{ ...installed, reference: { ...reference, digest: "A".repeat(64) } }],
      [{ ...installed, reference: { ...reference, id: "other" } }],
      [{ ...installed, package: { ...packageValue, name: 1 } }],
      [{ ...installed, source: "{}" }],
      Array.from({ length: 17 }, () => installed)]) {
      mocks.invoke.mockResolvedValue(bad);
      await expect(listNativeThemes()).rejects.toMatchObject({ kind: "protocol" });
    }
  });

  it("returns exact picked source, treats a cancelled picker as null, and rejects invalid text", async () => {
    mocks.invoke.mockResolvedValue(source);
    expect(await pickNativeTheme()).toBe(source);
    expect(mocks.invoke).toHaveBeenCalledWith("theme_pick", {});

    mocks.invoke.mockResolvedValue(null);
    expect(await pickNativeTheme()).toBeNull();

    for (const bad of ["", "{}", 42]) {
      mocks.invoke.mockResolvedValue(bad);
      await expect(pickNativeTheme()).rejects.toMatchObject({ kind: "protocol" });
    }
  });

  it("installs the exact source after validation and rejects inconsistent replies", async () => {
    mocks.invoke.mockResolvedValue(installed);
    expect(await installNativeTheme(source)).toEqual(installed);
    expect(mocks.invoke).toHaveBeenCalledWith("theme_install", { source });

    mocks.invoke.mockReset();
    for (const bad of ["", "{}", "x".repeat(16 * 1024 + 1)]) {
      await expect(installNativeTheme(bad)).rejects.toMatchObject({ kind: "invalid_package" });
    }
    expect(mocks.invoke).not.toHaveBeenCalled();

    mocks.invoke.mockResolvedValue({ ...installed, reference: { ...reference, version: "9.9.9" } });
    await expect(installNativeTheme(source)).rejects.toMatchObject({ kind: "protocol" });
  });

  it("removes only a valid exact reference and rejects a non-null acknowledgement", async () => {
    mocks.invoke.mockResolvedValue(null);
    await removeNativeTheme(reference);
    expect(mocks.invoke).toHaveBeenCalledWith("theme_remove", { reference });

    mocks.invoke.mockReset();
    for (const bad of [null, {}, { ...reference, digest: "z".repeat(64) }, { ...reference, extra: true }]) {
      await expect(removeNativeTheme(bad as never)).rejects.toMatchObject({ kind: "invalid_arguments" });
    }
    expect(mocks.invoke).not.toHaveBeenCalled();

    mocks.invoke.mockResolvedValue("ok");
    await expect(removeNativeTheme(reference)).rejects.toMatchObject({ kind: "protocol" });
  });

  it("normalizes known native errors and never reflects raw text", async () => {
    mocks.invoke.mockRejectedValue({ kind: "in_use", message: "This theme version is still used." });
    await expect(removeNativeTheme(reference)).rejects.toMatchObject({
      kind: "in_use", message: "This theme version is still used.",
    });

    for (const error of ["secret", new Error("secret"), { kind: "other", message: "secret" }]) {
      mocks.invoke.mockRejectedValue(error);
      await expect(listNativeThemes()).rejects.toMatchObject({ kind: "io" });
      await expect(listNativeThemes()).rejects.not.toHaveProperty("message", expect.stringContaining("secret"));
    }

    mocks.native.mockReturnValue(false);
    await expect(listNativeThemes()).rejects.toMatchObject({ kind: "unavailable" });
    await expect(pickNativeTheme()).rejects.toMatchObject({ kind: "unavailable" });
    await expect(installNativeTheme(source)).rejects.toMatchObject({ kind: "unavailable" });
    await expect(removeNativeTheme(reference)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("rejects malformed parsed lists directly", () => {
    expect(parseInstalledThemes([installed])).toEqual([installed]);
    expect(parseInstalledThemes("themes")).toBeNull();
    expect(parseInstalledThemes([{ ...installed, source: "{}" }])).toBeNull();
  });
});
