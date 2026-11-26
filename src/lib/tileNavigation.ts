type TileBounds = Pick<DOMRect, "top" | "bottom" | "left" | "right">;

/** Find the closest tile in the next visual row, including uneven/spanning tiles. */
export function verticalReorderIndex(bounds: TileBounds[], index: number, direction: "up" | "down"): number {
  const source = bounds[index];
  if (!source) return index;
  const center = (source.left + source.right) / 2;
  let target = index;
  let nearestRow = Infinity;
  let nearestColumn = Infinity;
  bounds.forEach((candidate, candidateIndex) => {
    if (candidateIndex === index) return;
    const rowGap = direction === "down" ? candidate.top - source.bottom : source.top - candidate.bottom;
    if (rowGap < -1) return;
    const columnGap = Math.abs((candidate.left + candidate.right) / 2 - center);
    if (rowGap < nearestRow - 1 || (Math.abs(rowGap - nearestRow) <= 1 && columnGap < nearestColumn)) {
      target = candidateIndex;
      nearestRow = rowGap;
      nearestColumn = columnGap;
    }
  });
  return target;
}
