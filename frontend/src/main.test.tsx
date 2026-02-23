import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./main";
import type { AnnotationEdit, FaceListItem } from "./types";
import * as api from "./api";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (value: string) => `http://asset.localhost/${encodeURIComponent(value)}`,
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
  extractFramesFromMp4: vi.fn(),
  generateReviewDataset: vi.fn(),
  runImportStage: vi.fn(),
  stageDroppedInputs: vi.fn(),
  setAnnotations: vi.fn(async (_datasetRoot: string, _faceId: string, edits: AnnotationEdit[]) => edits),
}));

let annotationStore: Record<string, AnnotationEdit[]>;

vi.mock("./api", () => ({
  extractFramesFromMp4: mocks.extractFramesFromMp4,
  exportCoco: vi.fn(),
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
  annotationStore = {
    "face-1": [
      { bbox: [0, 1, 10, 11], provenance: { source: "seed", updatedAt: "2026-01-01T00:00:00.000Z" } },
      { bbox: [2, 3, 12, 13], provenance: { source: "seed", updatedAt: "2026-01-01T00:00:00.000Z" } },
    ],
    "face-2": [],
  };

  mocks.extractFramesFromMp4.mockResolvedValue({
    sourceFramesDir: "derived_frames/frame_sourcing",
    extractedFrameCount: 8,
  });
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

  mocks.extractFramesFromMp4.mockClear();
  mocks.generateReviewDataset.mockClear();
  mocks.runImportStage.mockClear();
  mocks.setAnnotations.mockClear();
  mocks.stageDroppedInputs.mockClear();
});

describe("bbox delete flow", () => {
  it("deletes the active box and persists omission across save + reload", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open dataset" }));

    await waitFor(() => {
      expect(screen.getByText(/Loaded 2 annotation\(s\) for face-1/)).toBeTruthy();
    });

    const boxRowsBeforeDelete = screen.getAllByLabelText(/^[xywh]$/);
    expect(boxRowsBeforeDelete).toHaveLength(8);

    const secondRowXInput = boxRowsBeforeDelete[4];
    fireEvent.mouseEnter(secondRowXInput.closest(".row") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete active box" }));

    expect(screen.getAllByLabelText(/^[xywh]$/)).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Save edits" }));

    await waitFor(() => {
      expect(mocks.setAnnotations).toHaveBeenCalledTimes(1);
    });

    const persistedEdits = mocks.setAnnotations.mock.calls[0][2] as AnnotationEdit[];
    expect(persistedEdits).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /face-2/ }));
    await waitFor(() => {
      expect(screen.getByText(/Loaded 0 annotation\(s\) for face-2/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /face-1/ }));
    await waitFor(() => {
      expect(screen.getByText(/Loaded 1 annotation\(s\) for face-1/)).toBeTruthy();
    });

    expect(screen.getAllByLabelText(/^[xywh]$/)).toHaveLength(4);
  });
});

describe("source frames directory behavior", () => {
  it("shows source frame directory as read-only auto-managed field", () => {
    render(<App />);

    const sourceFramesInput = screen.getByLabelText("Source frames directory (auto-managed)") as HTMLInputElement;
    expect(sourceFramesInput.getAttribute("readonly")).not.toBeNull();
    expect(screen.getByText(/manual overrides are disabled in MVP/i)).toBeTruthy();
  });

  it("runs unified generation pipeline and includes extraction stats in diagnostics", async () => {
    render(<App />);

    fireEvent.change(screen.getByPlaceholderText("Select dataset directory"), {
      target: { value: "/tmp/dataset" },
    });
    fireEvent.change(screen.getByPlaceholderText("Select instances_default.json"), {
      target: { value: "/tmp/dataset/annotations/instances_default.json" },
    });
    fireEvent.change(screen.getByPlaceholderText("Select source .mp4"), {
      target: { value: "/tmp/dataset/source.mp4" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Generate review dataset" }));

    expect(screen.getByText(/Step: validating/i)).toBeTruthy();

    await waitFor(() => {
      expect(mocks.generateReviewDataset).toHaveBeenCalledTimes(1);
    });

    const request = mocks.generateReviewDataset.mock.calls[0][0];
    expect(request.qualityProfile).toBe("balanced");

    const sourceFramesInput = screen.getByLabelText("Source frames directory (auto-managed)") as HTMLInputElement;
    expect(sourceFramesInput.value).toBe("(auto-managed after extraction)");

    expect(api.generateReviewDataset).toBeDefined();
  });
});




describe("face preview path behavior", () => {
  it("normalizes windows dataset root when building face preview src", async () => {
    render(<App />);

    fireEvent.change(screen.getByPlaceholderText("Select dataset directory"), {
      target: { value: String.raw`C:\Users\Kevin\Downloads\bdr-anno-review` },
    });

    fireEvent.click(screen.getByRole("button", { name: "Open dataset" }));

    const preview = await screen.findByAltText("Face preview for face-1") as HTMLImageElement;
    expect(preview.getAttribute("src")).toBe("http://asset.localhost/C%3A%2FUsers%2FKevin%2FDownloads%2Fbdr-anno-review%2Fraw_frames%2Fface-1.png");
  });

  it("shows explicit diagnostics when preview image fails to load", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Open dataset" }));

    const preview = await screen.findByAltText("Face preview for face-1");
    fireEvent.error(preview);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load face preview for face-1 from/)).toBeTruthy();
    });
  });


  it("shows backend diagnostics when listFaces fails with missing preview files", async () => {
    vi.mocked(api.listFaces).mockRejectedValueOnce(
      "dataset preview files are missing: 1 missing `faces[].image_path` target(s) under dataset root `/tmp/dataset`. Sample: face-1 -> `/tmp/dataset/raw_frames/face-1.png`"
    );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open dataset" }));

    await waitFor(() => {
      expect(screen.getByText("Open dataset failed")).toBeTruthy();
      expect(screen.getByText(/dataset preview files are missing/)).toBeTruthy();
      expect(screen.getByText(/face-1 ->/)).toBeTruthy();
    });
  });
});
describe("drop input workflow", () => {
  it("renders drop input button", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Drop input" })).toBeTruthy();
  });
});
