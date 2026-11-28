# Midnight Maze (Storybook visual prototype)

Status: prototype only. This is **not** a built-in appearance, not in `THEMES`, and not the
installable sample package. It is one Storybook story with its own fixture icons. The production
bundle does not include these pixel icons.

A separate data-only sample package (`packages/themes/midnight-maze.zdeck-theme.json`) maps the
same palette to safe host tokens and can be imported through the external-theme flow. It uses the
shared host renderer and no prototype CSS or icons.

Browse `Themes / Midnight Maze (prototype)`:

- `Desktop` — two real `deck-section` panels, real `control-grid` and shared `ControlTile`.
- `Phone` — a 390px `phone-shell`, real `phone-main`, `phone-section` and `phone-grid`.
- `Icons On Surfaces` — the same pixel icon data URLs on the production Dark and Light surfaces,
  with no Midnight Maze CSS applied.

The stories cover button, slider, dial, toggle switch, toggle button, numeric value, a long label,
disabled, unknown and failed-reading states. Controls use local preview semantics; no native or
plugin action is sent.

## Files

- `src/components/MidnightMaze.stories.tsx` — stories, fixtures and play checks.
- `src/components/midnight-maze.css` — story-only token block, maze/pellet background and tile
  accents. Imported by that story file only.
- `src/components/fixtures/midnightMazeIcons.ts` — original 16×16 pixel icon set as bounded
  `data:image/svg+xml;base64` sources in the existing `ControlIcon` shape (`play`, `pause`, `next`,
  `volume`, `microphone`, `camera`, `power`, `light`, `star`). Independent of any theme CSS.
- `docs/midnight-maze.md` — this note.

Palette: ink `#05060c`, maze blue `#3158ff`, yellow `#ffe34b`, cyan `#66e2ef`, coral `#ff777f`,
pink `#ffa9df`. Text is light on deep-blue panels. Decoration is static; no new motion is added.

## Checks

```bash
npm run typecheck
CHROME_BIN="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  npx vitest run --project=storybook MidnightMaze
```

The play checks cover containment at the desktop layout and at 390px/320px phone widths, icon
data-URL validity and decoded dimensions, visible labels, focus and 44px touch targets, dial
spacing, and that the production theme list and the page outside the fixture are unchanged.
