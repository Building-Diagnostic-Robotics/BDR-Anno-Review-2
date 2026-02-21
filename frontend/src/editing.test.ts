import { describe, expect, it } from "vitest";
import { removeEditAtIndex } from "./editing";
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
