import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./app";
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
  startEditingSession: vi.fn(),
  getSuggestionsReadiness: vi.fn(),
  topupSuggestions: vi.fn(),
  saveLlmSettings: vi.fn(),
  setLlmApiKey: vi.fn(),
  clearLlmApiKey: vi.fn(),
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
  saveLlmSettings: mocks.saveLlmSettings,
  setLlmApiKey: mocks.setLlmApiKey,
  clearLlmApiKey: mocks.clearLlmApiKey,
  getSuggestions: mocks.getSuggestions,
  startEditingSession: mocks.startEditingSession,
  getSuggestionsReadiness: mocks.getSuggestionsReadiness,
  topupSuggestions: mocks.topupSuggestions,
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
      setLineDash: () => undefined,
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

  mocks.setAnnotations.mockImplementation(async (_datasetRoot: string, faceId: string, edits: AnnotationEdit[]) => {
    annotationStore[faceId] = edits;
    return edits;
  });

  mocks.getLlmSettings.mockResolvedValue({
    llmSuggestionsEnabled: false,
    reasoningPreset: "high",
    prefetchBufferSize: 12,
    editorWarmupThresholdRatio: 0.4,
    editorWarmupTimeoutMs: 300,
    openai: { enabled: true, model: "gpt-5.4", hasKey: false },
    anthropic: { enabled: false, model: "claude-sonnet-4-6", hasKey: false },
  });

  const ready = {
    readyCount: 2,
    queuedCount: 0,
    inProgressCount: 0,
    failedCount: 0,
    targetBufferSize: 12,
    minReadyToStart: 1,
    blocked: false,
    candidateFaceIds: ["face-1", "face-2"],
    readyFaceIds: ["face-1", "face-2"],
  };
  mocks.startEditingSession.mockResolvedValue(ready);
  mocks.getSuggestionsReadiness.mockResolvedValue(ready);
  mocks.topupSuggestions.mockResolvedValue(ready);
  mocks.exportCoco.mockResolvedValue({ outputPath: "/tmp/out.json", imageCount: 2, annotationCount: 2 });

  Object.values(mocks).forEach((fn) => fn.mockClear());
});

const openDatasetToEditor = async (datasetRoot = "/tmp/dataset") => {
  fireEvent.click(screen.getByRole("button", { name: "Open existing" }));
  fireEvent.change(screen.getByLabelText("Existing project directory"), {
    target: { value: datasetRoot },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open dataset" }));
  await waitFor(() => {
    expect(screen.getByText(/Editing face-1/)).toBeTruthy();
  });
};

describe("app workflow smoke", () => {
  it("switches intake modes inside the setup workspace", () => {
    render(<App />);
    expect(screen.getByLabelText("Project directory")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open existing" }));
    expect(screen.getByLabelText("Existing project directory")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create dataset" }));
    expect(screen.getByLabelText("Project directory")).toBeTruthy();
  });

  it("opens dataset and navigates to export step", async () => {
    render(<App />);
    await openDatasetToEditor();
    fireEvent.click(screen.getByRole("button", { name: "Finish and export" }));
    expect(screen.getByRole("heading", { name: "Export final annotations" })).toBeTruthy();
  });

  it("autosaves edited bbox", async () => {
    render(<App />);
    await openDatasetToEditor();
    const xInputs = screen.getAllByLabelText("x") as HTMLInputElement[];
    fireEvent.change(xInputs[0], { target: { value: "9" } });

    await waitFor(() => {
      expect(mocks.setAnnotations).toHaveBeenCalled();
    }, { timeout: 2500 });
  });

  it("keeps inferred paths synced until user override", async () => {
    render(<App />);

    const datasetRootInput = screen.getByLabelText("Project directory");
    const cocoInput = screen.getByLabelText("COCO JSON") as HTMLInputElement;
    const mp4Input = screen.getByLabelText("Source MP4") as HTMLInputElement;

    fireEvent.change(datasetRootInput, { target: { value: "/tmp/dataset-a" } });
    await waitFor(() => {
      expect(cocoInput.value).toBe("/tmp/dataset-a/annotations/instances_default.json");
      expect(mp4Input.value).toBe("/tmp/dataset-a/source.mp4");
    });

    fireEvent.change(cocoInput, { target: { value: "/custom/instances.json" } });
    fireEvent.change(mp4Input, { target: { value: "/custom/source.mp4" } });
    fireEvent.change(datasetRootInput, { target: { value: "/tmp/dataset-c" } });

    await waitFor(() => {
      expect(cocoInput.value).toBe("/custom/instances.json");
      expect(mp4Input.value).toBe("/custom/source.mp4");
    });
  });

  it("deletes active box and persists on save", async () => {
    render(<App />);
    await openDatasetToEditor();

    const boxInputs = screen.getAllByLabelText(/^[xywh]$/);
    fireEvent.mouseEnter(boxInputs[4].closest(".bbox-editor") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete active box" }));
    fireEvent.click(screen.getByRole("button", { name: "Save now" }));

    await waitFor(() => {
      expect(mocks.setAnnotations).toHaveBeenCalled();
    });
  });

  it("opens the diagnostics drawer from the status rail", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Show diagnostics" }));

    await waitFor(() => {
      expect(screen.getByText("Diagnostics Console")).toBeTruthy();
    });
  });
});

describe("settings modal", () => {
  it("disables save when suggestions are enabled and provider is disabled", async () => {
    mocks.getLlmSettings.mockResolvedValueOnce({
      llmSuggestionsEnabled: true,
      reasoningPreset: "high",
      prefetchBufferSize: 12,
      editorWarmupThresholdRatio: 0.4,
      editorWarmupTimeoutMs: 300,
      openai: { enabled: true, model: "gpt-5.4", hasKey: false },
      anthropic: { enabled: false, model: "claude-sonnet-4-6", hasKey: false },
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    const dialog = await screen.findByRole("dialog", { name: "LLM settings" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable provider" }));

    expect(within(dialog).getByText(/select an llm provider or disable suggestions/i)).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("updates the provider key inline", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    const dialog = await screen.findByRole("dialog", { name: "LLM settings" });

    const selectedProviderButton = within(dialog).getByRole("button", { name: "Selected" });
    const selectedProviderHeader =
      selectedProviderButton.parentElement?.querySelector("h4")?.textContent?.trim() ?? "";
    if (selectedProviderHeader !== "OpenAI" && selectedProviderHeader !== "Anthropic") {
      throw new Error("Expected selected provider heading to be OpenAI or Anthropic.");
    }
    const selectedProviderCard = selectedProviderButton.closest(".ring-2");
    if (!(selectedProviderCard instanceof HTMLElement)) {
      throw new Error("Expected selected provider card.");
    }

    const providerKeyField = within(selectedProviderCard).getByPlaceholderText("Paste API key");
    fireEvent.change(providerKeyField, {
      target: { value: "test-key" },
    });
    fireEvent.click(within(selectedProviderCard).getByRole("button", { name: `Update ${selectedProviderHeader} key` }));

    await waitFor(() => {
      expect(mocks.setLlmApiKey).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "test-key",
        })
      );
    });
  });

  it("closes settings modal on Escape", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    await screen.findByRole("dialog", { name: "LLM settings" });
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "LLM settings" })).toBeNull();
    });
  });
});
