import type { ControlIcon } from "../../lib/icons";

/**
 * Original data-only pixel icons for the Storybook "Midnight Maze" prototype.
 * They are image icons, not a theme: the same data URLs render on any appearance.
 */
const SIZE = 16;
const OUTLINE = "#0b1020";
const COLORS: Record<string, string> = {
  y: "#ffe34b", // yellow
  c: "#66e2ef", // cyan
  r: "#ff777f", // coral
  p: "#ffa9df", // pink
  b: "#3158ff", // maze blue
};

const ART = {
  play: {
    title: "Play",
    rows: [
      "................",
      "................",
      ".....y..........",
      ".....yy.........",
      ".....yyy........",
      ".....yyyy.......",
      ".....yyyyy......",
      ".....yyyyyy.....",
      ".....yyyyyy.....",
      ".....yyyyy......",
      ".....yyyy.......",
      ".....yyy........",
      ".....yy.........",
      ".....y..........",
      "................",
      "................",
    ],
  },
  pause: {
    title: "Pause",
    rows: [
      "................",
      "................",
      "...yy...yy......",
      "...yy...yy......",
      "...yy...yy......",
      "...yy...yy......",
      "...yy...yy......",
      "...yy...yy......",
      "...yy...yy......",
      "...yy...yy......",
      "...yy...yy......",
      "...yy...yy......",
      "...yy...yy......",
      "................",
      "................",
      "................",
    ],
  },
  next: {
    title: "Next",
    rows: [
      "................",
      "................",
      ".....y.....y....",
      ".....yy....y....",
      ".....yyy...y....",
      ".....yyyy..y....",
      ".....yyyyy.y....",
      ".....yyyyyyy....",
      ".....yyyyyyy....",
      ".....yyyyy.y....",
      ".....yyyy..y....",
      ".....yyy...y....",
      ".....yy....y....",
      ".....y.....y....",
      "................",
      "................",
    ],
  },
  volume: {
    title: "Volume",
    rows: [
      "................",
      ".......c........",
      "......cc...y....",
      ".....ccc....y...",
      "..cccccc.....y..",
      "..cccccc.....y..",
      "..cccccc.....y..",
      ".....ccc....y...",
      "......cc...y....",
      ".......c........",
      "................",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },
  microphone: {
    title: "Microphone",
    rows: [
      "................",
      ".....rr.........",
      "....rrrr........",
      "....rrrr........",
      "....rrrr........",
      "....rrrr........",
      ".....rr.........",
      "......c.........",
      "..c...c...c.....",
      "...c..c..c......",
      "......c.........",
      ".....ccc........",
      "......c.........",
      "................",
      "................",
      "................",
    ],
  },
  camera: {
    title: "Camera",
    rows: [
      "................",
      "................",
      ".....cccc.......",
      "..cccccccccccc..",
      "..cccccccccccc..",
      "..cccppppppccc..",
      "..cccppppppccc..",
      "..cccppppppccc..",
      "..cccccccccccc..",
      "..cccccccccccc..",
      "..cccccccccccc..",
      "................",
      "................",
      "................",
      "................",
      "................",
    ],
  },
  power: {
    title: "Power",
    rows: [
      "................",
      "................",
      "........y.......",
      "........y.......",
      "........y.......",
      ".....y.....y....",
      "....y.......y...",
      "...y.........y..",
      "...y.........y..",
      "...y.........y..",
      "....y.......y...",
      ".....y.....y....",
      "......yyyyy.....",
      "................",
      "................",
      "................",
    ],
  },
  light: {
    title: "Light",
    rows: [
      "................",
      "......yyyy......",
      ".....yyyyyy.....",
      "....yyyyyyyy....",
      "....yyy..yyy....",
      "....yy....yy....",
      "....yy....yy....",
      "....yyy..yyy....",
      ".....yyyyyy.....",
      "......yyyy......",
      ".......yy.......",
      ".......yy.......",
      "......cccc......",
      "......cccc......",
      "................",
      "................",
    ],
  },
  star: {
    title: "Star",
    rows: [
      "................",
      ".......pp.......",
      ".......pp.......",
      "......pppp......",
      "......pppp......",
      ".pppppppppppppp.",
      "..pppppppppppp..",
      "...pppppppppp...",
      "....pppppppp....",
      ".....pppppp.....",
      "....ppp..ppp....",
      "...ppp....ppp...",
      "..pp........pp..",
      "................",
      "................",
      "................",
    ],
  },
} as const;

type Art = { title: string; rows: readonly string[] };
type Point = { x: number; y: number; color: string };

// Run-length paths keep each bounded data URL small: one subpath per same-colour span.
function paths(points: Point[]): string {
  const byColor = new Map<string, Map<number, number[]>>();
  for (const { x, y, color } of points) {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
    const rows = byColor.get(color) ?? new Map<number, number[]>();
    const xs = rows.get(y) ?? [];
    xs.push(x);
    rows.set(y, xs);
    byColor.set(color, rows);
  }
  return [...byColor].map(([color, rows]) => {
    let d = "";
    for (const [y, xs] of rows) {
      xs.sort((a, b) => a - b);
      for (let start = 0; start < xs.length;) {
        let end = start + 1;
        while (xs[end] === xs[end - 1] + 1) end++;
        const length = xs[end - 1] - xs[start] + 1;
        d += `M${xs[start]} ${y}h${length}v1h-${length}z`;
        start = end;
      }
    }
    return `<path fill="${color}" d="${d}"/>`;
  }).join("");
}

function svg(art: Art): string {
  if (art.rows.length !== SIZE || art.rows.some(row => row.length !== SIZE)) {
    throw new Error("Midnight Maze icons must be 16x16 pixels.");
  }
  const cells: Point[] = [];
  art.rows.forEach((row, y) => [...row].forEach((char, x) => {
    if (char !== ".") cells.push({ x, y, color: COLORS[char] ?? OUTLINE });
  }));
  // A one-pixel dark edge keeps the coloured pixels readable on the production light surface.
  const outline: Point[] = [];
  for (const { x, y } of cells) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!cells.some(cell => cell.x === x + dx && cell.y === y + dy)) {
        outline.push({ x: x + dx, y: y + dy, color: OUTLINE });
      }
    }
  }
  const body = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE * 2}" height="${SIZE * 2}" shape-rendering="crispEdges">${paths([...outline, ...cells])}</svg>`;
  return `data:image/svg+xml;base64,${btoa(body)}`;
}

export type MidnightMazeIconName = keyof typeof ART;

export const MIDNIGHT_MAZE_ICONS = Object.fromEntries(
  Object.entries(ART).map(([name, art]) => [name, { title: art.title, icon: { type: "image", src: svg(art) } satisfies ControlIcon }]),
) as Record<MidnightMazeIconName, { title: string; icon: ControlIcon }>;
