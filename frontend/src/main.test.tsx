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
  startGenerateReviewDataset: vi.fn(),
  getGenerationStatus: vi.fn(),
  runImportStage: vi.fn(),
  stageDroppedInputs: vi.fn(),
  getLlmSettings: vi.fn(),
  getSuggestions: vi.fn(),
  getSuggestionQueueState: vi.fn(),
  prefetchSuggestions: vi.fn(),
  setAnnotations: vi.fn(async (_datasetRoot: string, _faceId: string, edits: AnnotationEdit[]) => edits),
  exportCoco: vi.fn(),
}));

let annotationStore: Record<string, AnnotationEdit[]>;

vi.mock("./api", () => ({
  exportCoco: mocks.exportCoco,
  startGenerateReviewDataset: mocks.startGenerateReviewDataset,
  getGenerationStatus: mocks.getGenerationStatus,
  runImportStage: mocks.runImportStage,
  stageDroppedInputs: mocks.stageDroppedInputs,
  getLlmSettings: mocks.getLlmSettings,
  saveLlmSettings: vi.fn(),
  clearProviderKey: vi.fn(),
  getSuggestions: mocks.getSuggestions,
  prefetchSuggestions: mocks.prefetchSuggestions,
  getSuggestionQueueState: mocks.getSuggestionQueueState,
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
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
    return {
      clearRect: () => undefined,
      fillRect: () => undefined,
      strokeRect: () => undefined,
      fillText: () => undefined,
      set lineWidth(_value: number) {},
      set fillStyle(_value: string) {},
      set strokeStyle(_value: string) {},
    } as unknown as CanvasRenderingContext2D;
  });
  (Element.prototype as unknown as { setPointerCapture?: (pointerId: number) => void }).setPointerCapture = () => undefined;

  window.localStorage.clear();
  annotationStore = {
    "face-1": [
      { bbox: [0, 1, 10, 11], provenance: { source: "seed", updatedAt: "2026-01-01T00:00:00.000Z" } },
      { bbox: [2, 3, 12, 13], provenance: { source: "seed", updatedAt: "2026-01-01T00:00:00.000Z" } },
    ],
    "face-2": [],
  };

  mocks.startGenerateReviewDataset.mockResolvedValue({ jobId: "job-1" });
  mocks.getGenerationStatus.mockResolvedValue({
    jobId: "job-1",
    state: "done",
    message: "Generation complete",
    result: {
    writtenManifestPath: "annotations/view_manifest.json",
    faceCount: 2,
    filteredBoxCount: 1,
    extractedFrameCount: 8,
    skippedExistingCount: 2,
  },
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

  mocks.getLlmSettings.mockResolvedValue({
    llmSuggestionsEnabled: true,
    reasoningPreset: "high",
    prefetchBufferSize: 12,
    openai: { enabled: true, model: "gpt-5.2", apiKeyConfigured: false },
    anthropic: { enabled: false, model: "claude-sonnet-4-6", apiKeyConfigured: false },
  });

  mocks.exportCoco.mockResolvedValue({ outputPath: "/tmp/out.json", imageCount: 2, annotationCount: 2 });
  mocks.getSuggestions.mockResolvedValue({ faceId: "face-1", provider: "openai", model: "gpt-5.2", suggestions: [], attempts: 1 });
  mocks.prefetchSuggestions.mockResolvedValue({ items: [] });
  mocks.getSuggestionQueueState.mockResolvedValue({ items: [] });

  mocks.startGenerateReviewDataset.mockClear();
  mocks.getGenerationStatus.mockClear();
  mocks.runImportStage.mockClear();
  mocks.setAnnotations.mockClear();
  mocks.stageDroppedInputs.mockClear();
  mocks.exportCoco.mockClear();
  mocks.getSuggestions.mockClear();
  mocks.prefetchSuggestions.mockClear();
  mocks.getSuggestionQueueState.mockClear();
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


describe("home path inputs and editor chrome", () => {
  it("always shows file path fields and does not render focus mode", async () => {
    render(<App />);

    expect(screen.getByLabelText("COCO JSON")).toBeTruthy();
    expect(screen.getByLabelText("Source MP4")).toBeTruthy();
    expect(screen.getByLabelText("Source frames directory (auto-managed)")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Resume dataset directory"), {
      target: { value: "/tmp/dataset" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open dataset" }));

    await waitFor(() => {
      expect(screen.getByText(/Editing: face-1/)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Focus mode" })).toBeNull();
  });

  it("keeps inferred paths synced with dataset root until user overrides them", async () => {
    render(<App />);

    const datasetRootInput = screen.getByLabelText("Resume dataset directory");
    const cocoInput = screen.getByLabelText("COCO JSON") as HTMLInputElement;
    const mp4Input = screen.getByLabelText("Source MP4") as HTMLInputElement;

    fireEvent.change(datasetRootInput, { target: { value: "/tmp/dataset-a" } });
    await waitFor(() => {
      expect(cocoInput.value).toBe("/tmp/dataset-a/annotations/instances_default.json");
      expect(mp4Input.value).toBe("/tmp/dataset-a/source.mp4");
    });

    fireEvent.change(datasetRootInput, { target: { value: "/tmp/dataset-b" } });
    await waitFor(() => {
      expect(cocoInput.value).toBe("/tmp/dataset-b/annotations/instances_default.json");
      expect(mp4Input.value).toBe("/tmp/dataset-b/source.mp4");
    });

    fireEvent.change(cocoInput, { target: { value: "/custom/instances.json" } });
    fireEvent.change(mp4Input, { target: { value: "/custom/source.mp4" } });
    fireEvent.change(datasetRootInput, { target: { value: "/tmp/dataset-c" } });

    await waitFor(() => {
      expect(cocoInput.value).toBe("/custom/instances.json");
      expect(mp4Input.value).toBe("/custom/source.mp4");
    });
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
    fireEvent.mouseEnter(secondRowXInput.closest(".bbox-editor") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete active box" }));
    fireEvent.click(screen.getByRole("button", { name: "Save now" }));

    await waitFor(() => {
      expect(mocks.setAnnotations).toHaveBeenCalled();
    });
  });
});

describe("face switching and save concurrency", () => {
  it("does not navigate faces with arrow keys while typing in bbox inputs", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("Resume dataset directory"), {
      target: { value: "/tmp/dataset" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open dataset" }));

    await waitFor(() => {
      expect(screen.getByText(/Editing: face-1/)).toBeTruthy();
    });

    const xInput = screen.getAllByLabelText("x")[0];
    fireEvent.keyDown(xInput, { key: "ArrowRight" });

    await waitFor(() => {
      expect(screen.getByText(/Editing: face-1/)).toBeTruthy();
    });
    expect(screen.queryByText(/Editing: face-2/)).toBeNull();
  });

  it("does not autosave stale edits for the next face while annotations are loading", async () => {
    let resolveFace2Load: (value: AnnotationEdit[]) => void = () => {
      throw new Error("Expected face-2 annotation loader to be initialized");
    };
    const delayedFace2 = new Promise<AnnotationEdit[]>((resolve) => {
      resolveFace2Load = resolve;
    });

    mocks.setAnnotations.mockClear();

    const api = await import("./api");
    const getAnnotationsMock = vi.mocked(api.getAnnotations);
    getAnnotationsMock.mockImplementation(async (_datasetRoot: string, faceId: string) => {
      if (faceId === "face-2") {
        return delayedFace2;
      }
      return annotationStore[faceId] ?? [];
    });

    render(<App />);

    fireEvent.change(screen.getByLabelText("Resume dataset directory"), {
      target: { value: "/tmp/dataset" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open dataset" }));

    await waitFor(() => {
      expect(screen.getByText(/Editing: face-1/)).toBeTruthy();
    });

    fireEvent.change(screen.getAllByLabelText("x")[0], { target: { value: "41" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect(
      mocks.setAnnotations.mock.calls.some(([, faceId]) => faceId === "face-2")
    ).toBe(false);

    resolveFace2Load([]);

    await waitFor(() => {
      expect(screen.getByText(/Editing: face-2/)).toBeTruthy();
    });
  });

  it("keeps newer local edits when an older save response returns", async () => {
    let resolveSave: (value: AnnotationEdit[]) => void = () => {
      throw new Error("Expected save resolver to be initialized");
    };
    mocks.setAnnotations.mockImplementation(
      (_datasetRoot: string, _faceId: string, edits: AnnotationEdit[]) =>
        new Promise<AnnotationEdit[]>((resolve) => {
          resolveSave = () => resolve(edits);
        })
    );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Resume dataset directory"), {
      target: { value: "/tmp/dataset" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open dataset" }));

    await waitFor(() => {
      expect(screen.getByText(/Editing: face-1/)).toBeTruthy();
    });

    const firstXInput = screen.getAllByLabelText("x")[0] as HTMLInputElement;
    fireEvent.change(firstXInput, { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Save now" }));

    fireEvent.change(firstXInput, { target: { value: "15" } });
    resolveSave(annotationStore["face-1"]);

    await waitFor(() => {
      expect(firstXInput.value).toBe("15");
    });
  });
});
