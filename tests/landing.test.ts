import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import ts from "typescript";
import { resolve } from "node:path";
import { MiniDeck } from "../src/landing/MiniDeck";
import { SDK_SNIPPET_RAW, SdkSnippet } from "../src/landing/SdkSnippet";
import {
  INITIAL_DECK_STATE,
  INSTALL_OPTIONS,
  LINKS,
  MINI_DECK_CONTROLS,
  SCENES,
  TRACKS,
  applyMiniControl,
} from "../src/landing/data";

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  mounting: true,
  effects: [] as (() => void | (() => void))[],
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (hooks.mounting) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
    }];
  },
  useEffect: (effect: () => void | (() => void)) => {
    if (hooks.mounting) hooks.effects.push(effect);
  },
}));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function send(element: Element, handler: string, event: unknown) {
  (element.props[handler] as (event: unknown) => void)(event);
}
function mountDeck() {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.mounting = true;
  hooks.effects = [];
  const target = new EventTarget();
  const document = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", document);
  const onInteract = vi.fn();
  const render = () => {
    hooks.cursor = 0;
    return elements(MiniDeck({ onInteract }));
  };
  let tree = render();
  const cleanup = hooks.effects.map((effect) => effect());
  hooks.mounting = false;
  const wrapper = (index = 0) => tree.filter((el) => el.props.onPointerDown)[index];
  const pressed = (index = 0) => {
    tree = render();
    return tree.filter((el) => el.props.control)[index].props.pressed;
  };
  const key = (type: string, value: string, repeat = false, targetProps = {}, code = "") => {
    const event = Object.assign(new Event(type), { key: value, code, repeat });
    Object.defineProperty(event, "target", { value: { tagName: "BODY", ...targetProps } });
    target.dispatchEvent(event);
  };
  return { wrapper, pressed, key, target, document, onInteract,
    activate: () => send(tree.find((el) => el.props.onPrimary)!, "onPrimary", undefined),
    cleanup: () => cleanup.forEach((fn) => fn?.()) };
}
afterEach(() => vi.unstubAllGlobals());

describe("landing data and mini deck", () => {
  it("holds pointers until release/cancel/capture loss without firing early", () => {
    const deck = mountDeck();
    const capture = vi.fn();
    const pointer = (id: number, button = 0) => ({ pointerId: id, button,
      target: { closest: () => ({ setPointerCapture: capture }) } });
    send(deck.wrapper(), "onPointerDown", pointer(1, 2));
    expect(deck.pressed()).toBe(false);
    send(deck.wrapper(), "onPointerDown", pointer(1));
    send(deck.wrapper(1), "onPointerDown", pointer(2));
    expect(deck.pressed()).toBe(true);
    expect(deck.pressed(1)).toBe(true);
    expect(deck.onInteract).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith(1);
    send(deck.wrapper(), "onPointerUp", pointer(1));
    expect(deck.pressed()).toBe(false);
    expect(deck.pressed(1)).toBe(true);
    send(deck.wrapper(1), "onPointerCancel", pointer(2));
    expect(deck.pressed(1)).toBe(false);
    send(deck.wrapper(), "onPointerDown", pointer(3));
    send(deck.wrapper(), "onLostPointerCapture", pointer(3));
    expect(deck.pressed()).toBe(false);
    deck.activate();
    expect(deck.onInteract).toHaveBeenCalledOnce();
    expect(deck.pressed()).toBe(false);
    expect((hooks.values[0] as typeof INITIAL_DECK_STATE).sceneIndex).toBe(1);
    deck.cleanup();
  });

  it("holds numeric shortcuts without repeat activation and resets on lost focus", () => {
    const deck = mountDeck();
    deck.key("keydown", "1");
    deck.key("keydown", "1", true);
    expect(deck.pressed()).toBe(true);
    expect(deck.onInteract).toHaveBeenCalledTimes(1);
    deck.key("keyup", "1");
    expect(deck.pressed()).toBe(false);
    deck.key("keydown", "1", false, {}, "Digit1");
    deck.key("keyup", "!", false, {}, "Digit1");
    expect(deck.pressed()).toBe(false);
    deck.key("keydown", "2", false, { tagName: "INPUT" });
    deck.key("keydown", "2", false, { closest: () => ({}) });
    expect(deck.pressed(1)).toBe(false);
    deck.key("keydown", "2");
    deck.target.dispatchEvent(new Event("blur"));
    expect(deck.pressed(1)).toBe(false);
    deck.key("keydown", "1");
    deck.document.hidden = true;
    deck.document.dispatchEvent(new Event("visibilitychange"));
    expect(deck.pressed()).toBe(false);
    deck.cleanup();
    deck.key("keydown", "1");
    expect(deck.pressed()).toBe(false);
  });

  it("tracks native Space/Enter holds, suppresses repeats and clears on blur", () => {
    const deck = mountDeck();
    const preventDefault = vi.fn();
    const event = (key: string, repeat = false) => ({ key, repeat, preventDefault,
      target: { closest: () => ({}) } });
    send(deck.wrapper(), "onKeyDown", event(" "));
    expect(deck.pressed()).toBe(true);
    send(deck.wrapper(), "onKeyUp", event(" "));
    expect(deck.pressed()).toBe(false);
    send(deck.wrapper(), "onKeyDown", event("Enter"));
    send(deck.wrapper(), "onKeyDown", event("Enter", true));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(deck.onInteract).not.toHaveBeenCalled();
    send(deck.wrapper(), "onBlur", {});
    expect(deck.pressed()).toBe(false);
    deck.cleanup();
  });

  it("displays the same TypeScript it copies and typechecks against the real SDK", async () => {
    hooks.cursor = 0;
    hooks.mounting = true;
    const tree = elements(SdkSnippet());
    expect(tree.find((el) => el.type === "code")?.props.children).toBe(SDK_SNIPPET_RAW);
    expect(tree.some((el) => el.props.children === "plugins/counter/main.ts")).toBe(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await (tree.find((el) => el.type === "button")!.props.onClick as () => Promise<void>)();
    expect(writeText).toHaveBeenCalledWith(SDK_SNIPPET_RAW);
    const filename = resolve("tests/__landing_snippet.ts");
    const source = SDK_SNIPPET_RAW.replace('"@zdeck/plugin-sdk"', '"../packages/plugin-sdk/index.js"');
    const options: ts.CompilerOptions = { noEmit: true, strict: true, skipLibCheck: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, language, onError, createNew) => file === filename
      ? ts.createSourceFile(file, source, options.target!, true)
      : getSourceFile(file, language, onError, createNew);
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host));
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });
  it("points GitHub link at ZaneH/zdeck and defines all three OS install tabs", () => {
    expect(LINKS.github).toBe("https://github.com/ZaneH/zdeck");
    expect(INSTALL_OPTIONS.map((o) => o.id)).toEqual(["macos", "linux", "windows"]);
  });

  it("cycles scene, toggles mic and playback, clamps volume, and advances track", () => {
    const byId = (id: string) => MINI_DECK_CONTROLS.find((c) => c.id === id)!;

    let state = applyMiniControl(INITIAL_DECK_STATE, byId("mini-scene"));
    expect(SCENES[state.sceneIndex]).toBe("Desktop");
    expect(state.status).toBe("Scene: Desktop");

    state = applyMiniControl(state, byId("mini-mic"));
    expect(state.micMuted).toBe(true);
    expect(state.status).toBe("Mic muted");

    state = applyMiniControl(state, byId("mini-play"));
    expect(state.playing).toBe(false);

    state = applyMiniControl(state, byId("mini-vol"), 150);
    expect(state.volume).toBe(100);

    state = applyMiniControl(state, byId("mini-spotify"));
    expect(state.playing).toBe(true);
    expect(TRACKS[state.trackIndex]).toBe("Lo-Fi Loop 04");
  });
});
