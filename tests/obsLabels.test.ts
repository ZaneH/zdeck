import { expect, it, vi } from "vitest";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Inspector } from "../src/components/Inspector";
import { createControl } from "../src/lib/actions";
import type { Control } from "../src/lib/types";

type Node = ReactElement<Record<string, any>>;
function find(node: ReactNode, predicate: (node: Node) => boolean): Node | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as Node;
  return predicate(element) ? element : find(element.props.children, predicate);
}
function editor(control: Control, connected = false) {
  const onPatch = vi.fn();
  const tree = Inspector({
    control, pageName: "Stream", previewVolume: 50,
    obs: { native: connected, status: connected ? "connected" : "disconnected", pendingScene: null, scenes: ["Camera", "Break"], lastSwitch: null },
    system: { native: false }, plugin: { snapshots: {} },
    onPatch, onRemove: vi.fn(), onPreviewPress: vi.fn(), onPreviewVolume: vi.fn(),
  } as unknown as ComponentProps<typeof Inspector>);
  return { tree, onPatch, input: find(tree, node => node.type === "input" && node.key?.endsWith("-label") === true)!.props };
}

it("shows the scene as a placeholder, not an explicit title, and permits clearing", () => {
  const { input, onPatch } = editor(createControl("obs-scene", { scene: "Camera" }));
  expect(input.defaultValue).toBe("");
  expect(input.placeholder).toBe("Camera");
  const currentTarget = { value: "  My camera  " };
  input.onBlur({ currentTarget });
  expect(onPatch).toHaveBeenLastCalledWith({ label: "My camera" });
  currentTarget.value = "";
  input.onBlur({ currentTarget });
  expect(onPatch).toHaveBeenLastCalledWith({ label: "" });
});

it("Escape keeps automatic labeling instead of turning the scene name into a custom title", () => {
  const { input, onPatch } = editor(createControl("obs-scene", { scene: "Camera" }));
  const currentTarget = { value: "Unwanted edit", blur: () => input.onBlur({ currentTarget }) };
  input.onKeyDown({ key: "Escape", currentTarget, preventDefault: vi.fn() });
  expect(onPatch).toHaveBeenCalledWith({ label: "" });
});

it("keeps explicit titles editable, including a title equal to the scene", () => {
  const { input } = editor(createControl("obs-scene", { scene: "Camera", label: "Camera" }));
  expect(input.defaultValue).toBe("Camera");
});

it.each([false, true])("patches the scene from the %s-connected scene editor", (connected) => {
  const { tree, onPatch } = editor(createControl("obs-scene", { scene: "Camera" }), connected);
  const scene = find(tree, node => connected ? node.type === "select" && node.props.value === "Camera" : node.type === "input" && node.key?.endsWith("-scene") === true)!.props;
  if (connected) scene.onChange({ target: { value: "Break" } });
  else scene.onBlur({ currentTarget: { value: "Break" } });
  expect(onPatch).toHaveBeenCalledWith({ scene: "Break" });
});
