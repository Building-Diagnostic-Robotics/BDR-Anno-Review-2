import type { AnnotationEdit } from "./types";

export const validateEdits = (entries: AnnotationEdit[]) => {
  for (let index = 0; index < entries.length; index += 1) {
    const [x, y, w, h] = entries[index].bbox;
    if (![x, y, w, h].every((value) => Number.isFinite(value))) {
      return `Box ${index + 1} has non-finite values.`;
    }
    if (w < 0 || h < 0) {
      return `Box ${index + 1} has invalid size (width/height must be non-negative).`;
    }
  }
  return "";
};

export const removeEditAtIndex = (
  entries: AnnotationEdit[],
  targetIndex: number,
  activeBoxIndex: number | null
) => {
  if (targetIndex < 0 || targetIndex >= entries.length) {
    return { edits: entries, activeBoxIndex };
  }

  const edits = entries.filter((_, index) => index !== targetIndex);

  let nextActiveBoxIndex = activeBoxIndex;
  if (activeBoxIndex === targetIndex) {
    nextActiveBoxIndex = edits.length === 0 ? null : Math.min(targetIndex, edits.length - 1);
  } else if (activeBoxIndex !== null && activeBoxIndex > targetIndex) {
    nextActiveBoxIndex = activeBoxIndex - 1;
  }

  return { edits, activeBoxIndex: nextActiveBoxIndex };
};
