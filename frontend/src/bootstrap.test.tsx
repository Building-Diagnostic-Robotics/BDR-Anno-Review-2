import { beforeEach, describe, expect, it, vi } from "vitest";

const render = vi.fn();
const createRoot = vi.fn(() => ({ render }));

vi.mock("react-dom/client", () => ({
  default: { createRoot },
  createRoot,
}));

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

vi.mock("./api", () => ({
  exportCoco: vi.fn(),
  startGenerateReviewDataset: vi.fn(),
  getGenerationStatus: vi.fn(),
  abortGenerationJob: vi.fn(),
  getAnnotations: vi.fn(),
  listFaces: vi.fn(),
  openDataset: vi.fn(),
  runImportStage: vi.fn(),
  setAnnotations: vi.fn(),
  checkRuntimeDependencies: vi.fn(),
  stageDroppedInputs: vi.fn(),
  getLlmSettings: vi.fn(),
  saveLlmSettings: vi.fn(),
  setLlmApiKey: vi.fn(),
  clearLlmApiKey: vi.fn(),
  getSuggestions: vi.fn(),
  startEditingSession: vi.fn(),
  getSuggestionsReadiness: vi.fn(),
  topupSuggestions: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  createRoot.mockClear();
  render.mockClear();
  document.body.innerHTML = "";
});

describe("frontend bootstrap split", () => {
  it("does not mount React when importing the App module", async () => {
    await import("./app");
    expect(createRoot).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it("mounts React when importing the runtime entrypoint with a root element", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await import("./main");
    expect(createRoot).toHaveBeenCalledTimes(1);
    expect(createRoot).toHaveBeenCalledWith(document.getElementById("root"));
    expect(render).toHaveBeenCalledTimes(1);
  });
});
