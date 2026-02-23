import { describe, expect, it } from "vitest";
import { detectPointerIntent, removeEditAtIndex, resizeBboxFromHandle } from "./editing";
import type { AnnotationEdit } from "./types";

const makeEdit = (seed: number): AnnotationEdit => ({
  bbox: [seed, seed, seed + 1, seed + 2],
  provenance: { source: "seed", updatedAt: "2026-01-01T00:00:00.000Z" },
});

describe("removeEditAtIndex", () => {
  it("retargets active index to next available box", () => {
    const result = removeEditAtIndex([makeEdit(1), makeEdit(2), makeEdit(3)], 1, 1);
    expect(result.edits).toHaveLength(2);
    expect(result.activeBoxIndex).toBe(1);
  });

  it("shifts active index when deleting a lower index", () => {
    const result = removeEditAtIndex([makeEdit(1), makeEdit(2), makeEdit(3)], 0, 2);
    expect(result.activeBoxIndex).toBe(1);
  });
});

describe("detectPointerIntent", () => {
  it("returns move intent with grab cursor in box center", () => {
    const intent = detectPointerIntent([makeEdit(10)], { x: 16, y: 16 }, 0);
    expect(intent.mode).toBe("move");
    expect(intent.cursor).toBe("grab");
  });

  it("returns resize intent for corner handles", () => {
    const intent = detectPointerIntent([makeEdit(10)], { x: 10, y: 10 }, 2);
    expect(intent.mode).toBe("resize");
    expect(intent.handle).toBe("nw");
  });
});

describe("resizeBboxFromHandle", () => {
  it("resizes from top-left handle and normalizes bounds", () => {
    const next = resizeBboxFromHandle([10, 10, 20, 20], "nw", { x: 8, y: 7 });
    expect(next).toEqual([8, 7, 22, 23]);
  });

  it("resizes from west edge", () => {
    const next = resizeBboxFromHandle([10, 10, 20, 20], "w", { x: 4, y: 0 });
    expect(next).toEqual([4, 10, 26, 20]);
  });
});
