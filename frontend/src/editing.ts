import type { AnnotationEdit } from "./types";

export type BoxPointerIntent = {
  mode: "draw" | "move" | "resize";
  index: number | null;
  handle: ResizeHandle | null;
  cursor: string;
  offsetX: number;
  offsetY: number;
};

export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export const RESIZE_HANDLE_ORDER: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

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

const resizeCursorByHandle: Record<ResizeHandle, string> = {
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
  nw: "nwse-resize",
};

export const getHandlePoint = (bbox: [number, number, number, number], handle: ResizeHandle) => {
  const [x, y, w, h] = bbox;
  const xMid = x + w / 2;
  const yMid = y + h / 2;
  switch (handle) {
    case "n":
      return { x: xMid, y };
    case "ne":
      return { x: x + w, y };
    case "e":
      return { x: x + w, y: yMid };
    case "se":
      return { x: x + w, y: y + h };
    case "s":
      return { x: xMid, y: y + h };
    case "sw":
      return { x, y: y + h };
    case "w":
      return { x, y: yMid };
    case "nw":
      return { x, y };
  }
};

export const detectPointerIntent = (
  entries: AnnotationEdit[],
  pointer: { x: number; y: number },
  handleRadius = 10
): BoxPointerIntent => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const bbox = entries[index].bbox;
    for (const handle of RESIZE_HANDLE_ORDER) {
      const point = getHandlePoint(bbox, handle);
      const inHandle = Math.abs(pointer.x - point.x) <= handleRadius && Math.abs(pointer.y - point.y) <= handleRadius;
      if (inHandle) {
        return {
          mode: "resize",
          index,
          handle,
          cursor: resizeCursorByHandle[handle],
          offsetX: 0,
          offsetY: 0,
        };
      }
    }

    const [x, y, w, h] = bbox;
    const inBox = pointer.x >= x && pointer.x <= x + w && pointer.y >= y && pointer.y <= y + h;
    if (inBox) {
      return {
        mode: "move",
        index,
        handle: null,
        cursor: "grab",
        offsetX: pointer.x - x,
        offsetY: pointer.y - y,
      };
    }
  }

  return {
    mode: "draw",
    index: null,
    handle: null,
    cursor: "crosshair",
    offsetX: 0,
    offsetY: 0,
  };
};

export const resizeBboxFromHandle = (
  bbox: [number, number, number, number],
  handle: ResizeHandle,
  pointer: { x: number; y: number }
): [number, number, number, number] => {
  const [x, y, w, h] = bbox;
  let left = x;
  let right = x + w;
  let top = y;
  let bottom = y + h;

  if (handle.includes("w")) left = pointer.x;
  if (handle.includes("e")) right = pointer.x;
  if (handle.includes("n")) top = pointer.y;
  if (handle.includes("s")) bottom = pointer.y;

  const normalizedLeft = Math.min(left, right);
  const normalizedRight = Math.max(left, right);
  const normalizedTop = Math.min(top, bottom);
  const normalizedBottom = Math.max(top, bottom);

  return [
    normalizedLeft,
    normalizedTop,
    Math.max(0, normalizedRight - normalizedLeft),
    Math.max(0, normalizedBottom - normalizedTop),
  ];
};

export const clampBboxToBounds = (
  bbox: [number, number, number, number],
  bounds: { width: number; height: number }
): [number, number, number, number] => {
  const maxWidth = Math.max(0, bounds.width);
  const maxHeight = Math.max(0, bounds.height);
  const [x, y, w, h] = bbox;

  const clampedX = Math.max(0, Math.min(maxWidth, x));
  const clampedY = Math.max(0, Math.min(maxHeight, y));
  const clampedW = Math.max(0, Math.min(maxWidth - clampedX, w));
  const clampedH = Math.max(0, Math.min(maxHeight - clampedY, h));

  return [clampedX, clampedY, clampedW, clampedH];
};
