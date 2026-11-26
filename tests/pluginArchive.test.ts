import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveCancel, archiveInstall, archiveListen, archivePick, archiveView, EMPTY_ARCHIVE, parseArchiveView } from "../src/lib/nativePluginArchive";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), native: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../src/lib/native", () => ({ nativeAvailable: mocks.native }));
const review = { reviewId: "a".repeat(32), id: "fixture", version: "1.2.3", protocolVersion: 1, runtime: "node", identity: "b".repeat(64), archiveSha256: "c".repeat(64), files: 2, bytes: 300, collision: false, runtimeStatus: "detected", runtimeVersion: "22.18.0" };
beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue(null); mocks.listen.mockReset().mockResolvedValue(() => {}); mocks.native.mockReturnValue(true); });
describe("local archive bridge", () => {
  it("uses only native selection and opaque review authorization, never renderer paths or targets", async () => {
    await archivePick(); await archiveInstall(review.reviewId); await archiveCancel(review.reviewId); await archiveCancel(null);
    mocks.invoke.mockResolvedValue({ ...EMPTY_ARCHIVE, review });
    expect((await archiveView()).review).toEqual(review);
    expect(mocks.invoke.mock.calls).toEqual([["plugin_archive_pick", {}], ["plugin_archive_install", { reviewId: review.reviewId }], ["plugin_archive_cancel", { reviewId: review.reviewId }], ["plugin_archive_cancel", { reviewId: null }], ["plugin_archive_view", {}]]);
    const callback = vi.fn(); await archiveListen(callback);
    expect(mocks.listen).toHaveBeenCalledWith("plugin-archive-changed", callback);
  });
  it("rejects malformed review identities and frontend replies", async () => {
    for (const token of ["../path", "", "c".repeat(64)]) { await expect(archiveInstall(token)).rejects.toThrow(); await expect(archiveCancel(token)).rejects.toThrow(); }
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(parseArchiveView({ ...EMPTY_ARCHIVE, review })).not.toBeNull();
    for (const replacement of [{ id: "../file" }, { version: "bad" }, { protocolVersion: 9 }, { runtime: "shell" }, { reviewId: "bad" }, { identity: "bad" }, { files: 4097 }, { bytes: 2 ** 30 }, { runtimeStatus: "verified" }, { collision: 1 }, { exec: "shell" }]) {
      expect(parseArchiveView({ ...EMPTY_ARCHIVE, review: { ...review, ...replacement } })).toBeNull();
    }
    for (const reply of [null, { ...EMPTY_ARCHIVE, busy: 1 }, { ...EMPTY_ARCHIVE, error: "\nsecret" }, { ...EMPTY_ARCHIVE, installedEpoch: -1 }, { ...EMPTY_ARCHIVE, extra: 1 }]) {
      mocks.invoke.mockResolvedValue(reply); await expect(archiveView()).rejects.toThrow();
    }
    mocks.invoke.mockResolvedValue({ path: "untrusted" }); await expect(archivePick()).rejects.toThrow();
  });
  it("never invokes native install or selection in a browser", async () => {
    mocks.native.mockReturnValue(false);
    for (const operation of [archivePick, archiveView, () => archiveCancel(null), () => archiveInstall(review.reviewId)]) await expect(operation()).rejects.toThrow("preview-only");
    await archiveListen(() => {}); expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.listen).not.toHaveBeenCalled();
  });
});
