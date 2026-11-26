import { describe, expect, it } from "vitest";
import { verticalReorderIndex } from "../src/lib/tileNavigation";

const rect = (column: number, row: number, width = 1, height = 1) => ({
  left: column * 110, right: column * 110 + width * 110 - 10,
  top: row * 106, bottom: row * 106 + height * 106 - 10,
});
const grid = (columns: number, count: number) => Array.from({ length: count }, (_, i) => rect(i % columns, Math.floor(i / columns)));

describe("vertical tile reordering", () => {
  it.each([2, 3, 4])("moves a visual row at a time in a %s-column grid", columns => {
    const bounds = grid(columns, columns * 3);
    expect(verticalReorderIndex(bounds, 1, "down")).toBe(1 + columns);
    expect(verticalReorderIndex(bounds, 1 + columns, "up")).toBe(1);
    expect(verticalReorderIndex(bounds, 0, "up")).toBe(0);
    expect(verticalReorderIndex(bounds, bounds.length - 1, "down")).toBe(bounds.length - 1);
  });

  it("uses the closest column in an incomplete last row", () => {
    expect(verticalReorderIndex(grid(4, 6), 3, "down")).toBe(5);
    expect(verticalReorderIndex(grid(4, 6), 5, "up")).toBe(1);
  });

  it("accounts for wide and tall tiles instead of assuming index plus column count", () => {
    const bounds = [rect(0, 0, 2), rect(2, 0, 1, 2), rect(3, 0), rect(0, 1), rect(1, 1), rect(3, 1), rect(0, 2, 2), rect(2, 2)];
    expect(verticalReorderIndex(bounds, 1, "down")).toBe(7);
    expect(verticalReorderIndex(bounds, 7, "up")).toBe(1);
    expect(verticalReorderIndex(bounds, 2, "down")).toBe(5);
    expect(verticalReorderIndex(bounds, 0, "down")).toBe(3);
  });

  it("does not move a lone tile or an invalid source", () => {
    expect(verticalReorderIndex([rect(0, 0)], 0, "down")).toBe(0);
    expect(verticalReorderIndex([], 0, "up")).toBe(0);
  });
});
