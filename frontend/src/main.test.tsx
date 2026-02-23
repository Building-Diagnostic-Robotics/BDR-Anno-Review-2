import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./main";
import type { AnnotationEdit, FaceListItem } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (value: string) => value,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn(async () => () => undefined),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

const faces: FaceListItem[] = [
  { faceId: "face-1", face: "front", imagePath: "raw_frames/face-1.png", initialBoxCount: 2 },
  { faceId: "face-2", face: "right", imagePath: "raw_frames/face-2.png", initialBoxCount: 0 },
];

const mocks = vi.hoisted(() => ({
  generateReviewDataset: vi.fn(),
  runImportStage: vi.fn(),
  stageDroppedInputs: vi.fn(),
  setAnnotations: vi.fn(async (_datasetRoot: string, _faceId: string, edits: AnnotationEdit[]) => edits),
  exportCoco: vi.fn(),
}));

let annotationStore: Record<string, AnnotationEdit[]>;

vi.mock("./api", () => ({
  exportCoco: mocks.exportCoco,
  generateReviewDataset: mocks.generateReviewDataset,
  runImportStage: mocks.runImportStage,
  stageDroppedInputs: mocks.stageDroppedInputs,
  checkRuntimeDependencies: vi.fn(async () => ({
    ffmpeg: { name: "ffmpeg", resolvedPath: "ffmpeg" },
    ffprobe: { name: "ffprobe", resolvedPath: "ffprobe" },
  })),
  openDataset: vi.fn(async (datasetRoot: string) => ({
    datasetRoot,
    manifestPath: "annotations/view_manifest.json",
    faceCount: faces.length,
  })),
  listFaces: vi.fn(async (datasetRoot: string) => ({ datasetRoot, faces })),
  getAnnotations: vi.fn(async (_datasetRoot: string, faceId: string) => annotationStore[faceId] ?? []),
  setAnnotations: mocks.setAnnotations,
}));

beforeEach(() => {
  window.localStorage.clear();
  annotationStore = {
    "face-1": [
      { bbox: [0, 1, 10, 11], provenance: { source: "seed", updatedAt: "2026-01-01T00:00:00.000Z" } },
      { bbox: [2, 3, 12, 13], provenance: { source: "seed", updatedAt: "2026-01-01T00:00:00.000Z" } },
    ],
    "face-2": [],
  };

  mocks.generateReviewDataset.mockResolvedValue({
    writtenManifestPath: "annotations/view_manifest.json",
    faceCount: 2,
    filteredBoxCount: 1,
    extractedFrameCount: 8,
    skippedExistingCount: 2,
  });

  mocks.stageDroppedInputs.mockResolvedValue({
    workspaceRoot: "/tmp/bdr-stage",
    stagedDatasetRoot: "/tmp/bdr-stage/dataset",
    stagedCocoJsonPath: "/tmp/bdr-stage/instances_default.json",
    stagedMp4Path: "/tmp/bdr-stage/source.mp4",
    ignoredPaths: [],
  });

  mocks.runImportStage.mockResolvedValue({
    imageCount: 2,
    annotationCount: 2,
    categoryCount: 1,
    referencedImageCount: 2,
  });

  mocks.setAnnotations.mockImplementation(async (_datasetRoot: string, faceId: string, edits: AnnotationEdit[]) => {
    annotationStore[faceId] = edits;
    return edits;
  });

  mocks.exportCoco.mockResolvedValue({ outputPath: "/tmp/out.json", imageCount: 2, annotationCount: 2 });

  mocks.generateReviewDataset.mockClear();
  mocks.runImportStage.mockClear();
  mocks.setAnnotations.mockClear();
  mocks.stageDroppedInputs.mockClear();
  mocks.exportCoco.mockClear();
});

describe("workflow pages", () => {
  it("opens from home to editor and can navigate to export page", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Create new dataset" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Resume dataset directory"), {
      target: { value: "/tmp/dataset" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Open dataset" }));

    await waitFor(() => {
      expect(screen.getByText(/Editing: face-1/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Finish & export" }));
    expect(screen.getByRole("heading", { name: "Export final annotations" })).toBeTruthy();
  });
});

describe("autosave", () => {
  it("autosaves after bbox edits without manual save", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("Resume dataset directory"), {
      target: { value: "/tmp/dataset" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open dataset" }));

    await waitFor(() => {
      expect(screen.getByText(/Editing: face-1/)).toBeTruthy();
    });

    const xInputs = screen.getAllByLabelText("x") as HTMLInputElement[];
    fireEvent.change(xInputs[0], { target: { value: "9" } });

    await new Promise((resolve) => setTimeout(resolve, 1300));

    await waitFor(() => {
      expect(mocks.setAnnotations).toHaveBeenCalled();
    });
  });
});

describe("tutorial preferences", () => {
  it("toggles tutorial and persists collapse state", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("Resume dataset directory"), {
      target: { value: "/tmp/dataset" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open dataset" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Hide quick tutorial" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Hide quick tutorial" }));
    expect(window.localStorage.getItem("bdr.editor.tutorialCollapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "Show quick tutorial" })).toBeTruthy();
  });
});

describe("delete flow", () => {
  it("deletes active box and persists through manual save", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("Resume dataset directory"), {
      target: { value: "/tmp/dataset" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open dataset" }));

    await waitFor(() => {
      expect(screen.getByText(/Editing: face-1/)).toBeTruthy();
    });

    const boxRowsBeforeDelete = screen.getAllByLabelText(/^[xywh]$/);
    expect(boxRowsBeforeDelete).toHaveLength(8);

    const secondRowXInput = boxRowsBeforeDelete[4];
    fireEvent.mouseEnter(secondRowXInput.closest(".row") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete active box" }));
    fireEvent.click(screen.getByRole("button", { name: "Save now" }));

    await waitFor(() => {
      expect(mocks.setAnnotations).toHaveBeenCalled();
    });
  });
});
