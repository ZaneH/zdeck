# Theme development

Status: the four built-in appearances only — Dark, Light, Glass and Wasteland Terminal. There is no theme
package format, download or install yet; see [theme store](theme-store.md) for that proposal. Nothing here
adds one, and a screenshot is not an installable theme.

## How an appearance is built today

An appearance is source code in the app, not data:

- `THEMES` in `src/lib/types.ts` is a closed enum. `applyTheme(theme, accent)` in `src/lib/theme.ts` writes
  `data-theme` on `<html>` and the `--accent` custom property; the app persists the chosen value.
- `src/styles.css` defines each appearance as a token block, `[data-theme="glass"], [data-appearance="glass"] { … }`:
  colors, borders, radii, shadows, backgrounds and material filters. The same block is reachable through
  `data-theme` (a scoped section or deck) and `data-appearance` (the resolved appearance of a section or tile).
- Presentation rules are per appearance: `[data-appearance="terminal"] .control-tile { … }` changes geometry,
  label placement, slider orientation and material. These are opt-in selectors, not inherited from the deck theme.
- The app owns the controls, DOM, input handling, hit areas, focus, accessible names and the disabled/unknown/reading-failed semantics. Theme authors do not reimplement sliders, dials or switches. An appearance may restyle and rearrange the stable presentation slots listed in `src/styles.css` while preserving their behavior and accessibility. New integration functionality belongs to plugins, not themes.

To add an appearance: add the token block and its presentation rules, add the id to `THEMES`, add the Storybook
toolbar item in `.storybook/preview.tsx`, and add it to the standard fixture and exporter below so its stories and screenshots
exist. Also update the Rust `Theme` enum in `crates/zdeck-schema/src/deck.rs`, global and per-section Appearance menus, theme-color mapping, and schema/persistence/remote tests. This is an app-source change, not a supported custom-theme installation workflow. Keep new effects within what the existing tests already check (contrast, focus, reduced motion, forced
colors).

## Glass material direction

Glass uses a graphite `#15171B` canvas with broad, low-contrast neutral illumination. Only the functional
control layer carries silver-gray material: a crisp upper specular rim, weaker opposing edge and short
contact shadow. Editor chrome and reading surfaces stay quiet; labels are monochromatic, on toggles
switch to dark ink on luminous silver, and the user's accent still owns focus/selection. System UI type
is scoped to Glass; nested Dark/Light/Terminal sections retain their own type and controls. Geometry,
input semantics and semantic warning/execution colors are unchanged.

The base control paint is opaque. Translucency and blur are opt-in through `@supports backdrop-filter`;
reduced transparency or increased contrast restores opaque paint and explicit boundaries. Forced colors
uses system colors, visible focus and an explicitly preserved two-color slider value fill. No shaders,
refraction engine, dependency, or new motion is involved. This is a CSS approximation, **not native
optical parity**; browser checks do not verify macOS, Windows or Linux webview rendering.

Design references: Apple's [Materials](https://developer.apple.com/design/human-interface-guidelines/materials),
[Liquid Glass color](https://developer.apple.com/design/human-interface-guidelines/color#Liquid-Glass-color),
and [WWDC25 material guidance](https://developer.apple.com/videos/play/wwdc2025/219/) distinguish the
functional control/navigation layer from quieter content and do not prescribe an inherent glass color.
Community implementations inspected for ideas only:
[liquid-glass-recipes](https://github.com/wave2234/liquid-glass-recipes),
[hyalite--liquid-glass](https://github.com/VII-Cae/hyalite--liquid-glass), and
[nikdelvin/liquid-glass](https://github.com/nikdelvin/liquid-glass) (MIT). No source was copied.

## The standard fixture is the developer workspace

`src/components/ThemePreview.stories.tsx` (`Themes/Theme preview`) renders one fixed sample deck for every
appearance, as `Desktop` and `Phone` stories per built-in id:

- one control for each presentation: button, slider, dial, toggle switch, toggle button and a numeric reading;
- normal active/inactive states, plus a toggle whose state is unknown and a reading that failed;
- desktop shows the five normal controls and the three reading/state examples in two side-by-side sections;
  phone keeps all eight controls in its single scrolling section;
- the same controls, labels and captions in every appearance — only the appearance changes, so a preview shows
  the theme and not different content;
- local preview semantics: nothing is executed or sent, and the controls stay keyboard reachable;
- the fixture scopes the appearance with `data-theme`/`data-appearance`, so the story's `theme` arg wins over the
  Storybook toolbar theme on the preview surface.

Each story's interaction test asserts that all six presentations render, that desktop has two sections while phone
has one, that the appearance tokens resolve at the fixture boundary (the page outside keeps its own appearance),
that appearance-specific presentation applies (Glass material, Terminal geometry and mono face) and that no tile
overflows the viewport or its section. Glass additionally measures the icon, label, switch track/state, dial, reading
and the 44px target inside each tile at desktop, 390px and a resized 320px shell, so the curved capsule inset and
label/body spacing are checked on the content, not only on the tile box.

```bash
npm run storybook                                    # browse Themes/Theme preview
CHROME_BIN="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  npx vitest run --project=storybook ThemePreview     # the same checks, headless
```

`npm run storybook:test` runs every story, including these.

## Screenshots for a registry or a review

The exporter drives the standard stories in an already running local Storybook. It never fetches a remote site,
adds no dependency and writes outside the app; commit nothing it produces.

```bash
# In one terminal: npm run storybook (stop it when finished).
# In another terminal:
npm run theme:previews -- --url http://127.0.0.1:6006 --out /tmp/zdeck-theme-previews --themes glass,terminal
```

- `--url` is required and must be a local Storybook (`localhost`, `127.0.0.1` or `::1`); other hosts are refused.
  `--out` is required; `--themes` takes built-in ids and defaults to all four.
- Playwright launches your installed Chromium-based browser through `CHROME_BIN`. On macOS the Brave path
  (`/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`) is the default; elsewhere `CHROME_BIN` is required.
- Fixed viewports: desktop 1200×800, phone 390×844, device scale factor 1. The run asks for reduced motion, `en-US`
  and UTC so the reading caption is stable, waits for fonts and two rendered frames, and disables CSS animations
  while capturing.
- The desktop capture measures `[data-testid="theme-preview-content"]`, then uniformly scales and centers it to
  fit a 28px margin inside 1200×800. It does not crop: the tightest of width and height decides the scale, so the
  narrow tall Glass group and the widescreen Dark group both stay whole. Phone keeps its natural layout.
- Before writing a file it checks that the requested appearance is the one rendered, that all six presentations are
  present and that neither a tile nor the scaled content group overflows the viewport. A failed check aborts
  instead of shipping a wrong picture.
- Output: `zdeck-theme-<theme>-<viewport>.png` for each requested id, plus `manifest.json` listing the story id,
  viewport, pixel dimensions, the desktop `contentScale`, byte size and SHA-256 of every file, so a consumer can
  pair exact bytes with a release.

Quote the dimensions and hashes with the files. They describe these PNGs, not the app on a phone or in the
Tauri webview.

## Validation limits

- These stories and screenshots cover the browser at two sizes. They are not accessibility, performance or native
  parity evidence; check keyboard and screen-reader behaviour, forced colors, reduced motion, long labels, large
  decks and the desktop/phone shells separately.
- Only the four built-in ids load in the app. There is no custom theme package, import or install. The registry's source-preview workflow documents source changes and screenshots for review; it does not make them installable. Do not present an exported PNG as an installable theme or infer package support from it.
- A future appearance format still needs a validated, bounded data parser and the platform evidence described in
  [theme store](theme-store.md); a picture of a theme is not that evidence.
