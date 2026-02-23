import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  exportCoco,
  startGenerateReviewDataset,
  getGenerationStatus,
  abortGenerationJob,
  getAnnotations,
  listFaces,
  openDataset,
  runImportStage,
  setAnnotations,
  checkRuntimeDependencies,
  stageDroppedInputs,
  getLlmSettings,
  saveLlmSettings,
  clearProviderKey,
  getSuggestions,
  prefetchSuggestions,
  getSuggestionQueueState,
} from "./api";
import type { AnnotationEdit, FaceListItem, LlmSettingsResponse, ReasoningPreset, SaveLlmSettingsRequest, SuggestionBox } from "./types";
import "./styles.css";
import {
  detectPointerIntent,
  getHandlePoint,
  removeEditAtIndex,
  resizeBboxFromHandle,
  type ResizeHandle,
  validateEdits,
  clampBboxToBounds,
  clampBboxMoveToBounds,
} from "./editing";
import { LlmSettingsModal } from "./settings-modal";
import { Button, Card, Field, SectionHeading, inputClassName, modalOverlayClassName } from "./ui-primitives";

const nowIso = () => new Date().toISOString();
const AUTOSAVE_DEBOUNCE_MS = 1000;
const TUTORIAL_STORAGE_KEY = "bdr.editor.tutorialCollapsed";

type ImageViewport = {
  naturalWidth: number;
  naturalHeight: number;
  displayWidth: number;
  displayHeight: number;
};

type PointerMode = "idle" | "draw" | "move" | "resize";
type GenerationStep = "idle" | "validating" | "dependencies" | "extracting" | "generating" | "aborting" | "done";
type AppPage = "home" | "editor" | "export";
type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const resolveFaceImagePath = (datasetRoot: string, imagePath: string) => {
  const normalizedRoot = datasetRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = imagePath.replace(/\\/g, "/");
  if (normalizedPath.startsWith("/") || /^[A-Za-z]:\//.test(normalizedPath)) {
    return normalizedPath;
  }
  return `${normalizedRoot}/${normalizedPath}`;
};

export function App() {
  const [page, setPage] = useState<AppPage>("home");

  const [datasetRoot, setDatasetRoot] = useState("");
  const [cocoJsonPath, setCocoJsonPath] = useState("");
  const [mp4Path, setMp4Path] = useState("");
  const [sourceFramesDir] = useState("(auto-managed after extraction)");
  const [outputPath, setOutputPath] = useState("");
  const [dropModalOpen, setDropModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [llmSettings, setLlmSettings] = useState<LlmSettingsResponse | null>(null);
  const [suggestionsByFace, setSuggestionsByFace] = useState<Record<string, SuggestionBox[]>>({});

  const [faces, setFaces] = useState<FaceListItem[]>([]);
  const [selectedFaceId, setSelectedFaceId] = useState<string>("");
  const [edits, setEdits] = useState<AnnotationEdit[]>([]);
  const [activeBoxIndex, setActiveBoxIndex] = useState<number | null>(null);
  const [editValidationError, setEditValidationError] = useState("");
  const [imageViewport, setImageViewport] = useState<ImageViewport | null>(null);
  const [previewError, setPreviewError] = useState("");

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveStateMessage, setSaveStateMessage] = useState("No changes yet.");
  const [lastSavedAt, setLastSavedAt] = useState("");
  const [isFaceLoading, setIsFaceLoading] = useState(false);
  const [showGenerationSpinner, setShowGenerationSpinner] = useState(false);
  const [noticeMessage, setNoticeMessage] = useState("");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const [tutorialCollapsed, setTutorialCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(TUTORIAL_STORAGE_KEY) === "true";
  });

  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragState = useRef({
    mode: "idle" as PointerMode,
    index: null as number | null,
    handle: null as ResizeHandle | null,
    originBbox: null as [number, number, number, number] | null,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0,
  });

  const lastSavedSnapshotRef = useRef<Record<string, string>>({});
  const autosaveTimerRef = useRef<number | undefined>(undefined);
  const pendingSaveRef = useRef<Promise<void> | null>(null);
  const editsRef = useRef<AnnotationEdit[]>([]);
  const selectedFaceIdRef = useRef("");
  const inferredCocoPathRef = useRef("");
  const inferredMp4PathRef = useRef("");

  useEffect(() => {
    editsRef.current = edits;
  }, [edits]);

  useEffect(() => {
    selectedFaceIdRef.current = selectedFaceId;
  }, [selectedFaceId]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [canvasCursor, setCanvasCursor] = useState("crosshair");
  const [status, setStatus] = useState("Ready.");
  const [error, setError] = useState("");
  const [generationStep, setGenerationStep] = useState<GenerationStep>("idle");
  const [generationPercent, setGenerationPercent] = useState(0);
  const [generationDetail, setGenerationDetail] = useState("Idle.");
  const [generationHeartbeat, setGenerationHeartbeat] = useState("Idle");
  const [generationJobId, setGenerationJobId] = useState("");

  const isFaceBusy = isFaceLoading;
  const isEditorBusy = isImporting || isExporting;
  const isHomeBusy = isGenerating || isImporting;
  const isExportBusy = isExporting;


  const selectedIndex = useMemo(
    () => faces.findIndex((face) => face.faceId === selectedFaceId),
    [faces, selectedFaceId]
  );
  const selectedFace = selectedIndex < 0 ? undefined : faces[selectedIndex];
  const selectedFaceImagePath = selectedFace ? resolveFaceImagePath(datasetRoot, selectedFace.imagePath) : "";
  const imageSrc = selectedFace ? convertFileSrc(selectedFaceImagePath) : "";

  const progress = faces.length === 0 ? 0 : ((selectedIndex + 1) / faces.length) * 100;

  const refreshLlmSettings = useCallback(async () => {
    try {
      const response = await getLlmSettings();
      setLlmSettings(response);
    } catch (cause) {
      updateDiagnostics("Settings load failed", String(cause));
    }
  }, []);

  useEffect(() => {
    void refreshLlmSettings();
  }, [refreshLlmSettings]);

  const prefetchLinearSuggestions = useCallback(async () => {
    if (!llmSettings?.llmSuggestionsEnabled || !datasetRoot || faces.length === 0 || selectedIndex < 0) {
      return;
    }
    const bufferStart = selectedIndex + 1;
    const bufferEnd = Math.min(faces.length, bufferStart + llmSettings.prefetchBufferSize);
    const faceIds = faces.slice(bufferStart, bufferEnd).map((face) => face.faceId);
    if (faceIds.length === 0) return;
    try {
      const queued = await prefetchSuggestions(datasetRoot, faceIds);
      updateDiagnostics(`Suggestion prefetch queued ${queued.items.length} face(s).`);
    } catch (cause) {
      updateDiagnostics("Suggestion prefetch failed", String(cause));
    }
  }, [llmSettings?.llmSuggestionsEnabled, llmSettings?.prefetchBufferSize, datasetRoot, faces, selectedIndex]);

  useEffect(() => {
    void prefetchLinearSuggestions();
  }, [prefetchLinearSuggestions]);


  useEffect(() => {
    if (!datasetRoot.trim()) {
      return;
    }
    const root = datasetRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    const nextInferredCocoPath = `${root}/annotations/instances_default.json`;
    const nextInferredMp4Path = `${root}/source.mp4`;

    if (!cocoJsonPath.trim() || cocoJsonPath === inferredCocoPathRef.current) {
      setCocoJsonPath(nextInferredCocoPath);
    }

    if (!mp4Path.trim() || mp4Path === inferredMp4PathRef.current) {
      setMp4Path(nextInferredMp4Path);
    }

    inferredCocoPathRef.current = nextInferredCocoPath;
    inferredMp4PathRef.current = nextInferredMp4Path;
  }, [datasetRoot, cocoJsonPath, mp4Path]);

  const datasetRootError = datasetRoot.trim() ? "" : "Dataset root is required.";
  const cocoPathError = cocoJsonPath.trim() ? "" : "COCO JSON path is required.";
  const mp4PathError = mp4Path.trim() ? (mp4Path.toLowerCase().endsWith(".mp4") ? "" : "MP4 path must end with .mp4") : "MP4 path is required.";
  const outputPathError = outputPath.trim() ? (outputPath.toLowerCase().endsWith(".json") ? "" : "Export path must end with .json") : "Export output path is required.";

  const importInputError = datasetRootError || cocoPathError || mp4PathError;
  const exportInputError = datasetRootError || outputPathError;

  const updateDiagnostics = (nextStatus: string, nextError = "") => {
    setStatus(nextStatus);
    setError(nextError);
  };

  const clearDiagnostics = (nextStatus = "Ready.") => {
    setStatus(nextStatus);
    setError("");
  };

  const formatDialogError = (scope: "folder" | "file" | "save", cause: unknown): string => {
    const message = String(cause);
    if (message.includes("plugin:dialog|open not allowed by ACL")) {
      return "Could not open picker: dialog permission missing (`plugin:dialog|open`). Update Tauri capabilities for the active window and rebuild.";
    }

    if (message.includes("plugin:dialog|save not allowed by ACL")) {
      return "Could not open save dialog: dialog permission missing (`plugin:dialog|save`). Update Tauri capabilities for the active window and rebuild.";
    }

    if (scope === "folder") {
      return `Could not open folder picker: ${message}`;
    }

    if (scope === "save") {
      return `Could not open save dialog: ${message}`;
    }

    return `Could not open file picker: ${message}`;
  };

  const pickDirectory = async (setter: (value: string) => void) => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        setter(selected);
      }
    } catch (cause) {
      updateDiagnostics("Browse failed", formatDialogError("folder", cause));
    }
  };

  const pickFile = async (setter: (value: string) => void, filters: { name: string; extensions: string[] }[]) => {
    try {
      const selected = await open({ directory: false, multiple: false, filters });
      if (typeof selected === "string") {
        setter(selected);
      }
    } catch (cause) {
      updateDiagnostics("Browse failed", formatDialogError("file", cause));
    }
  };

  const pickSaveFile = async () => {
    try {
      const selected = await save({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: outputPath || "instances_default.json",
      });
      if (selected) {
        setOutputPath(selected);
      }
    } catch (cause) {
      updateDiagnostics("Browse failed", formatDialogError("save", cause));
    }
  };

  const ensureRuntimeDependencies = async () => {
    const report = await checkRuntimeDependencies();
    return `ffmpeg: ${report.ffmpeg.resolvedPath}\nffprobe: ${report.ffprobe.resolvedPath}`;
  };

  const applyDroppedPaths = async (paths: string[]) => {
    if (paths.length === 0) {
      updateDiagnostics("Drop ignored", "No paths were provided.");
      return;
    }

    try {
      const report = await stageDroppedInputs(paths);
      if (report.stagedDatasetRoot) {
        setDatasetRoot(report.stagedDatasetRoot);
      }
      if (report.stagedCocoJsonPath) {
        setCocoJsonPath(report.stagedCocoJsonPath);
      }
      if (report.stagedMp4Path) {
        setMp4Path(report.stagedMp4Path);
      }

      const ignored = report.ignoredPaths.length > 0 ? `\nIgnored paths: ${report.ignoredPaths.join(", ")}` : "";
      updateDiagnostics("Drop imported", `Staged under: ${report.workspaceRoot}${ignored}`);
    } catch (cause) {
      updateDiagnostics("Drop import failed", String(cause));
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const attach = async () => {
      unlisten = await getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") {
          return;
        }

        void applyDroppedPaths(event.payload.paths);
      });
    };

    void attach();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenProgress: (() => void) | undefined;

    const attach = async () => {
      unlistenProgress = await listen("generation-progress", (event) => {
        if (disposed) return;
        const payload = event.payload as {
          phase: string;
          detail: string;
          percent: number;
          elapsedMs: number;
        };
        const phase = payload.phase ?? "idle";
        const nextStep: GenerationStep =
          phase === "rendering"
            ? "generating"
            : (["idle", "validating", "dependencies", "extracting", "generating", "aborting", "done"].includes(phase)
              ? (phase as GenerationStep)
              : "generating");
        setGenerationStep(nextStep);
        setGenerationPercent(payload.percent ?? 0);
        setGenerationDetail(payload.detail ?? "Working...");
        setGenerationHeartbeat(`Last update ${Math.round((payload.elapsedMs ?? 0) / 1000)}s`);
      });
    };

    void attach();
    return () => {
      disposed = true;
      if (unlistenProgress) {
        unlistenProgress();
      }
    };
  }, []);

  const refreshFaces = async () => {
    const openReport = await openDataset(datasetRoot);
    const faceReport = await listFaces(datasetRoot);
    setFaces(faceReport.faces);

    const nextSelectedFaceId = faceReport.faces.some((face) => face.faceId === selectedFaceId)
      ? selectedFaceId
      : faceReport.faces[0]?.faceId ?? "";
    setSelectedFaceId(nextSelectedFaceId);

    return { openReport, faceReport };
  };

  const handleOpen = async () => {
    if (datasetRootError) {
      updateDiagnostics("Open dataset blocked", datasetRootError);
      return;
    }

    setIsImporting(true);
    try {
      const { openReport } = await refreshFaces();
      setPage("editor");
      updateDiagnostics(`Dataset opened\nmanifest: ${openReport.manifestPath}\nfaces: ${openReport.faceCount}`);
    } catch (cause) {
      updateDiagnostics("Open dataset failed", String(cause));
    } finally {
      setIsImporting(false);
    }
  };

  const handleGenerate = async () => {
    if (importInputError) {
      updateDiagnostics("Review dataset generation blocked", importInputError);
      setNoticeMessage(importInputError);
      return;
    }

    setIsGenerating(true);
    setShowGenerationSpinner(true);
    setGenerationStep("validating");
    setGenerationPercent(0);
    setGenerationDetail("Starting generation pipeline...");
    setGenerationHeartbeat("Live");

    try {
      const runtimeReport = await ensureRuntimeDependencies();
      const start = await startGenerateReviewDataset({
        datasetRoot,
        cocoJsonPath,
        mp4Path,
        generatedAt: nowIso(),
        faces: ["front", "right", "back", "left"],
        renderSize: 1024,
        horizontalFovDegrees: 90,
        minProjectedBoxArea: 1,
        qualityProfile: "balanced",
      });

      setGenerationJobId(start.jobId);
      setGenerationHeartbeat(`Job ${start.jobId} running`);
      let report;
      while (!report) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        const status = await getGenerationStatus(start.jobId);
        if (status.state === "done" && status.result) {
          report = status.result;
          break;
        }
        if (status.state === "cancelled") {
          throw new Error(status.message || "Generation job cancelled.");
        }
        if (status.state === "error") {
          throw new Error(status.message || "Generation job failed.");
        }
        setGenerationDetail(status.message || "Running...");
      }

      await refreshFaces();
      setPage("editor");
      setGenerationStep("done");
      setGenerationPercent(100);
      setGenerationDetail("Done: review dataset is ready.");
      setGenerationHeartbeat("Complete");
      updateDiagnostics(
        `Review dataset generation complete\n${runtimeReport}\nsourceFramesDir (auto-generated): ${sourceFramesDir}\nextractedFrames: ${report.extractedFrameCount}\nskippedCachedFrames: ${report.skippedExistingCount}\nmanifest: ${report.writtenManifestPath}\nfaces: ${report.faceCount}\nfilteredBoxes: ${report.filteredBoxCount}`
      );
    } catch (cause) {
      setGenerationStep("idle");
      setGenerationPercent(0);
      setGenerationDetail("Idle.");
      setGenerationHeartbeat("Idle");
      const message = String(cause);
      updateDiagnostics("Review dataset generation failed", message);
      setNoticeMessage(message);
    } finally {
      setIsGenerating(false);
      setShowGenerationSpinner(false);
      setGenerationJobId("");
    }
  };


  const handleAbortGeneration = async () => {
    if (!generationJobId) {
      return;
    }
    try {
      setGenerationStep("aborting");
      setGenerationDetail("Abort requested. Waiting for cleanup...");
      setGenerationHeartbeat(`Job ${generationJobId} aborting`);
      await abortGenerationJob(generationJobId);
      updateDiagnostics("Generation abort requested", "Waiting for background cleanup to finish.");
    } catch (cause) {
      updateDiagnostics("Generation abort failed", String(cause));
    }
  };

  const loadAnnotations = useCallback(async (faceId: string) => {
    if (!faceId) {
      setIsFaceLoading(false);
      setEdits([]);
      setActiveBoxIndex(null);
      setEditValidationError("");
      return;
    }

    setIsFaceLoading(true);
    try {
      const current = await getAnnotations(datasetRoot, faceId);
      if (selectedFaceIdRef.current !== faceId) {
        return;
      }
      setEdits(current);
      lastSavedSnapshotRef.current[faceId] = JSON.stringify(current);
      setSaveState("saved");
      setSaveStateMessage("Saved.");
      setLastSavedAt(new Date().toLocaleTimeString());
      setActiveBoxIndex(null);
      setEditValidationError("");
      updateDiagnostics(`Loaded ${current.length} annotation(s) for ${faceId}`);
    } catch (cause) {
      updateDiagnostics("Load annotations failed", String(cause));
    } finally {
      setIsFaceLoading(false);
    }
  }, [datasetRoot]);

  const commitSave = useCallback(async (origin: "manual" | "autosave") => {
    const saveFaceId = selectedFaceIdRef.current;
    if (!saveFaceId) {
      return;
    }
    const editsSnapshot = editsRef.current;
    const saveRequestSnapshot = JSON.stringify(editsSnapshot);

    const validationError = validateEdits(editsSnapshot);
    if (validationError) {
      setEditValidationError(validationError);
      setSaveState("error");
      setSaveStateMessage(`Save blocked: ${validationError}`);
      if (origin === "manual") {
        updateDiagnostics("Save blocked due to invalid edits", validationError);
      }
      return;
    }

    if (pendingSaveRef.current) {
      await pendingSaveRef.current;
      return;
    }

    setSaveState("saving");
    setSaveStateMessage(origin === "manual" ? "Saving…" : "Autosaving…");

    const run = (async () => {
      try {
        const saved = await setAnnotations(datasetRoot, saveFaceId, editsSnapshot);
        const savedSnapshot = JSON.stringify(saved);
        lastSavedSnapshotRef.current[saveFaceId] = savedSnapshot;

        const activeFaceId = selectedFaceIdRef.current;
        const currentSnapshot = JSON.stringify(editsRef.current);
        const shouldApplySavedEdits = activeFaceId === saveFaceId && currentSnapshot === saveRequestSnapshot;

        if (shouldApplySavedEdits) {
          setEdits(saved);
          setEditValidationError("");
          setSaveState("saved");
          setSaveStateMessage(origin === "manual" ? "Saved." : "Autosaved.");
          setLastSavedAt(new Date().toLocaleTimeString());
          if (origin === "manual") {
            updateDiagnostics(`Saved ${saved.length} annotation(s) for ${saveFaceId}`);
          }
          return;
        }

        if (activeFaceId === saveFaceId) {
          setSaveState("dirty");
          setSaveStateMessage("Unsaved changes.");
        }
      } catch (cause) {
        setSaveState("error");
        setSaveStateMessage("Autosave failed. Please retry.");
        if (origin === "manual") {
          updateDiagnostics("Save edits failed", String(cause));
        }
      }
    })().finally(() => {
      pendingSaveRef.current = null;
    });

    pendingSaveRef.current = run;
    await run;
  }, [datasetRoot]);

  const flushAutosave = useCallback(async () => {
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = undefined;
    }

    const snapshot = selectedFaceId ? JSON.stringify(editsRef.current) : "";
    const baseline = selectedFaceId ? lastSavedSnapshotRef.current[selectedFaceId] ?? "" : "";
    if (selectedFaceId && snapshot !== baseline) {
      await commitSave("autosave");
    }
  }, [commitSave, selectedFaceId]);

  useEffect(() => {
    void loadAnnotations(selectedFaceId);
  }, [selectedFaceId, loadAnnotations]);

  useEffect(() => {
    const faceId = selectedFaceId;
    if (!faceId || !datasetRoot || !llmSettings?.llmSuggestionsEnabled) {
      return;
    }
    if (suggestionsByFace[faceId]) {
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        const response = await getSuggestions(datasetRoot, faceId, 30000);
        if (cancelled) return;
        setSuggestionsByFace((prev) => ({ ...prev, [faceId]: response.suggestions }));
      } catch (cause) {
        if (cancelled) return;
        updateDiagnostics("Suggestion fetch failed", String(cause));
      }

      void getSuggestionQueueState(datasetRoot, faces.map((f) => f.faceId)).catch(() => undefined);
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedFaceId, datasetRoot, llmSettings?.llmSuggestionsEnabled, suggestionsByFace, faces]);

  useEffect(() => {
    const onResize = () => {
      const img = imageRef.current;
      if (!img || !img.naturalWidth || !img.naturalHeight) {
        return;
      }
      setImageViewport({
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        displayWidth: img.clientWidth,
        displayHeight: img.clientHeight,
      });
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageViewport) {
      return;
    }

    canvas.width = Math.max(1, Math.floor(imageViewport.displayWidth));
    canvas.height = Math.max(1, Math.floor(imageViewport.displayHeight));
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const scaleX = imageViewport.displayWidth / imageViewport.naturalWidth;
    const scaleY = imageViewport.displayHeight / imageViewport.naturalHeight;
    context.clearRect(0, 0, canvas.width, canvas.height);

    edits.forEach((entry, index) => {
      const [x, y, w, h] = entry.bbox;
      const isActive = activeBoxIndex === index;
      context.strokeStyle = isActive ? "#dc2626" : "#2563eb";
      context.fillStyle = isActive ? "rgba(220,38,38,0.15)" : "rgba(37,99,235,0.12)";
      context.lineWidth = isActive ? 2.5 : 2;
      context.fillRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);
      context.strokeRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);
      context.fillStyle = "#111827";
      context.fillText(String(index + 1), x * scaleX + 4, y * scaleY + 14);

      if (isActive) {
        context.fillStyle = "#dc2626";
        (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as ResizeHandle[]).forEach((handle) => {
          const point = getHandlePoint([x, y, w, h], handle);
          context.fillRect(point.x * scaleX - 4, point.y * scaleY - 4, 8, 8);
        });
      }
    });
  }, [edits, imageViewport, activeBoxIndex]);

  useEffect(() => {
    if (!selectedFaceId || isFaceLoading) {
      return;
    }

    const validationError = validateEdits(edits);
    if (validationError) {
      setSaveState("error");
      setSaveStateMessage(`Fix invalid edits: ${validationError}`);
      return;
    }

    if (!hasUnsavedChanges(selectedFaceId, edits)) {
      return;
    }

    setSaveState("dirty");
    setSaveStateMessage("Unsaved changes.");

    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
    }

    autosaveTimerRef.current = window.setTimeout(() => {
      void commitSave("autosave");
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
      }
    };
  }, [edits, selectedFaceId, isFaceLoading, commitSave, hasUnsavedChanges]);

  const navigateToFace = async (faceId: string) => {
    if (faceId === selectedFaceId) {
      return;
    }
    await flushAutosave();
    setSelectedFaceId(faceId);
  };

  const handleEditChange = (index: number, axis: number, rawValue: string) => {
    const value = Number(rawValue);
    if (Number.isNaN(value)) {
      return;
    }

    setEdits((previous) =>
      previous.map((entry, itemIndex) => {
        if (itemIndex !== index) {
          return entry;
        }

        const bbox: [number, number, number, number] = [...entry.bbox] as [number, number, number, number];
        bbox[axis] = value;
        const boundedBbox = imageViewport
          ? clampBboxToBounds(bbox, { width: imageViewport.naturalWidth, height: imageViewport.naturalHeight })
          : bbox;

        return {
          ...entry,
          bbox: boundedBbox,
          provenance: {
            ...entry.provenance,
            source: "ui_manual",
            updatedAt: nowIso(),
          },
        };
      })
    );
    setEditValidationError("");
  };

  const updateBoxFromPointer = (index: number, nextBbox: [number, number, number, number]) => {
    setEdits((previous) =>
      previous.map((entry, entryIndex) => {
        if (entryIndex !== index) {
          return entry;
        }
        return {
          ...entry,
          bbox: nextBbox,
          provenance: {
            ...entry.provenance,
            source: "ui_manual",
            updatedAt: nowIso(),
          },
        };
      })
    );
    setEditValidationError("");
  };

  function hasUnsavedChanges(faceId: string, nextEdits: AnnotationEdit[]) {
    if (!faceId) {
      return false;
    }
    const snapshot = JSON.stringify(nextEdits);
    const baseline = lastSavedSnapshotRef.current[faceId] ?? "";
    return snapshot !== baseline;
  }

  const handleAddBox = () => {
    setEdits((previous) => [
      ...previous,
      {
        bbox: [0, 0, 32, 32],
        provenance: { source: "ui_manual", updatedAt: nowIso() },
      },
    ]);
    setEditValidationError("");
  };

  const handleDeleteActiveBox = useCallback(() => {
    if (activeBoxIndex === null) {
      return;
    }

    setEdits((previous) => {
      const next = removeEditAtIndex(previous, activeBoxIndex, activeBoxIndex);
      setActiveBoxIndex(next.activeBoxIndex);
      if (dragState.current.index !== null) {
        if (dragState.current.index === activeBoxIndex) {
          dragState.current = { mode: "idle", index: null, handle: null, originBbox: null, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
        } else if (dragState.current.index > activeBoxIndex) {
          dragState.current = {
            ...dragState.current,
            index: dragState.current.index - 1,
          };
        }
      }

      const validationError = validateEdits(next.edits);
      setEditValidationError(validationError);
      return next.edits;
    });
  }, [activeBoxIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isFaceBusy || isEditorBusy || faces.length === 0 || page !== "editor") {
        return;
      }

      const target = event.target as HTMLElement | null;
      const isTypingTarget = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if (!isTypingTarget && event.key === "ArrowRight") {
        event.preventDefault();
        const next = Math.min(selectedIndex + 1, faces.length - 1);
        void navigateToFace(faces[next].faceId);
      }

      if (!isTypingTarget && event.key === "ArrowLeft") {
        event.preventDefault();
        const next = Math.max(selectedIndex - 1, 0);
        void navigateToFace(faces[next].faceId);
      }

      if (!isTypingTarget && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        handleDeleteActiveBox();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFaceBusy, isEditorBusy, faces, selectedIndex, handleDeleteActiveBox, page]);

  const getPointerInImageSpace = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !imageViewport) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(imageViewport.naturalWidth, ((event.clientX - rect.left) / rect.width) * imageViewport.naturalWidth)),
      y: Math.max(0, Math.min(imageViewport.naturalHeight, ((event.clientY - rect.top) / rect.height) * imageViewport.naturalHeight)),
    };
  };

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pointer = getPointerInImageSpace(event);
    if (!pointer || isFaceBusy || isEditorBusy) {
      return;
    }

    const intent = detectPointerIntent(edits, pointer, 12);
    let mode: PointerMode = intent.mode;
    let targetIndex: number | null = intent.index;
    let offsetX = intent.offsetX;
    let offsetY = intent.offsetY;

    if (targetIndex === null) {
      targetIndex = edits.length;
      setEdits((previous) => [
        ...previous,
        {
          bbox: [pointer.x, pointer.y, 0, 0],
          provenance: { source: "ui_manual", updatedAt: nowIso() },
        },
      ]);
    }

    dragState.current = {
      mode,
      index: targetIndex,
      handle: intent.handle,
      originBbox: edits[targetIndex]?.bbox ?? null,
      startX: pointer.x,
      startY: pointer.y,
      offsetX,
      offsetY,
    };
    setActiveBoxIndex(targetIndex);
    setEditValidationError("");
    setCanvasCursor(mode === "move" ? "grabbing" : intent.cursor);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pointer = getPointerInImageSpace(event);
    const state = dragState.current;
    const viewport = imageViewport;
    if (!pointer || !viewport) {
      return;
    }

    if (state.mode === "idle") {
      const intent = detectPointerIntent(edits, pointer, 12);
      setCanvasCursor(intent.cursor);
      return;
    }

    if (state.index === null) {
      return;
    }

    const box = edits[state.index];
    if (!box) {
      return;
    }

    const [x, y, w, h] = box.bbox;
    if (state.mode === "move") {
      const boundedMove = clampBboxMoveToBounds(
        [pointer.x - state.offsetX, pointer.y - state.offsetY, w, h],
        { width: viewport.naturalWidth, height: viewport.naturalHeight }
      );
      updateBoxFromPointer(state.index, boundedMove);
      return;
    }

    if (state.mode === "resize") {
      if (!state.handle) {
        return;
      }
      const resizeBase = state.originBbox ?? [x, y, w, h];
      const resizedBbox = resizeBboxFromHandle(resizeBase, state.handle, pointer);
      updateBoxFromPointer(
        state.index,
        clampBboxToBounds(resizedBbox, { width: viewport.naturalWidth, height: viewport.naturalHeight })
      );
      return;
    }

    const drawnBbox: [number, number, number, number] = [
      Math.min(state.startX, pointer.x),
      Math.min(state.startY, pointer.y),
      Math.max(0, Math.abs(pointer.x - state.startX)),
      Math.max(0, Math.abs(pointer.y - state.startY)),
    ];
    updateBoxFromPointer(
      state.index,
      clampBboxToBounds(drawnBbox, { width: viewport.naturalWidth, height: viewport.naturalHeight })
    );
  };

  const handleCanvasPointerUp = () => {
    dragState.current = { mode: "idle", index: null, handle: null, originBbox: null, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
    setCanvasCursor("crosshair");
    const currentFaceId = selectedFaceIdRef.current;
    if (hasUnsavedChanges(currentFaceId, editsRef.current)) {
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
      }
      autosaveTimerRef.current = window.setTimeout(() => {
        void commitSave("autosave");
      }, AUTOSAVE_DEBOUNCE_MS);
    }
  };

  const handleSave = async () => {
    await commitSave("manual");
  };

  const handleExport = async () => {
    if (exportInputError) {
      updateDiagnostics("Export blocked", exportInputError);
      return;
    }

    setIsExporting(true);
    try {
      const report = await exportCoco({ datasetRoot, outputPath });
      updateDiagnostics(`Export finished\noutput: ${report.outputPath}\nimages=${report.imageCount}\nannotations=${report.annotationCount}`);
    } catch (cause) {
      updateDiagnostics("Export failed", String(cause));
    } finally {
      setIsExporting(false);
    }
  };

  const toggleTutorial = () => {
    setTutorialCollapsed((previous) => {
      const next = !previous;
      window.localStorage.setItem(TUTORIAL_STORAGE_KEY, String(next));
      return next;
    });
  };

  const goHome = async () => {
    await flushAutosave();
    setPage("home");
  };

  const diagnosticsText = "$ bdr-anno-review\n" + status + (error ? `\n\n[error] ${error}` : "\n\n[ok] No active errors.");
  const saveStateClassName: Record<SaveState, string> = {
    idle: "bg-anno-surface-high text-anno-text-muted",
    dirty: "bg-amber-500/20 text-amber-200",
    saving: "bg-sky-500/20 text-sky-200",
    saved: "bg-emerald-500/20 text-emerald-200",
    error: "bg-rose-500/20 text-rose-200",
  };

  const coord = (value: number) => (Number.isFinite(value) ? Number(value.toFixed(2)) : value);

  return (
    <main className="relative min-h-screen bg-anno-bg px-4 pb-28 pt-6 text-anno-text-main md:px-8">
      <div className="mx-auto flex w-full max-w-[1480px] items-center justify-between gap-3 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Anno Review Workspace</h1>
          <p className="text-sm text-anno-text-muted">Refined annotation tooling with layered surfaces and focused flow.</p>
        </div>
        <Button aria-label="Open settings" variant="tonal" onClick={() => setSettingsOpen(true)} disabled={isHomeBusy || isFaceBusy || isExportBusy}>⚙ Settings</Button>
      </div>

      {page === "home" ? (
        <section className="mx-auto grid w-full max-w-[1200px] gap-5 lg:grid-cols-[1.45fr_1fr]">
          <Card elevated className="bg-anno-surface-low">
            <SectionHeading title="Create new dataset" subtitle="Create a new review-ready dataset through a unified import wizard." />
            <Field label="Project directory" hint="Where Anno stores project metadata and generated assets.">
              <div className="flex gap-2">
                <input className={inputClassName} aria-label="Dataset root" value={datasetRoot} placeholder="Choose project directory" onChange={(event) => setDatasetRoot(event.target.value)} />
                <Button onClick={() => void pickDirectory(setDatasetRoot)} disabled={isHomeBusy}>Browse</Button>
              </div>
            </Field>

            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Import COCO" hint="Select your instances JSON file.">
                <div className="flex gap-2">
                  <input className={inputClassName} aria-label="COCO JSON" value={cocoJsonPath} placeholder="Choose COCO annotations (.json)" onChange={(event) => setCocoJsonPath(event.target.value)} />
                  <Button variant="outlined" onClick={() => void pickFile(setCocoJsonPath, [{ name: "JSON", extensions: ["json"] }])} disabled={isHomeBusy}>Browse</Button>
                </div>
              </Field>

              <Field label="Import MP4/frames" hint="Pick the source video (.mp4) used for frame generation.">
                <div className="flex gap-2">
                  <input className={inputClassName} aria-label="Source MP4" value={mp4Path} placeholder="Choose source video (.mp4)" onChange={(event) => setMp4Path(event.target.value)} />
                  <Button variant="outlined" onClick={() => void pickFile(setMp4Path, [{ name: "MP4", extensions: ["mp4"] }])} disabled={isHomeBusy}>Browse</Button>
                </div>
              </Field>
            </div>

            <Field label="Source frames directory (auto-managed)">
              <input className={inputClassName} aria-label="Source frames directory (auto-managed)" value={sourceFramesDir} readOnly />
            </Field>

            {importInputError ? <p className="mb-3 text-sm text-rose-300">{importInputError}</p> : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={handleGenerate} disabled={isHomeBusy || !!importInputError}>{isGenerating ? "Generating…" : "Generate"}</Button>
              {showGenerationSpinner ? <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-anno-primary border-t-transparent" aria-label="Generation in progress" /> : null}
              <Button variant="outlined" onClick={() => void handleAbortGeneration()} disabled={!isGenerating || !generationJobId}>Abort</Button>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-anno-surface-high" aria-label="generation progress">
              <span className="block h-full rounded-full bg-anno-primary transition-all duration-300" style={{ width: `${generationPercent}%` }} />
            </div>
            <p className="mt-2 text-xs text-anno-text-muted">Step: {generationStep} • {generationDetail} • {generationHeartbeat}</p>
          </Card>

          <Card className="bg-anno-surface-low">
            <SectionHeading title="Resume existing dataset" subtitle="Jump straight into annotation review." />
            <Field label="Open project directory" hint="Resume from an existing dataset root.">
              <div className="flex gap-2">
                <input className={inputClassName} aria-label="Resume dataset directory" value={datasetRoot} placeholder="Choose existing project directory" onChange={(event) => setDatasetRoot(event.target.value)} />
                <Button variant="outlined" onClick={() => void pickDirectory(setDatasetRoot)} disabled={isHomeBusy}>Browse</Button>
              </div>
            </Field>
            {datasetRootError ? <p className="mb-3 text-sm text-rose-300">{datasetRootError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleOpen} disabled={isHomeBusy || !!datasetRootError}>Open dataset</Button>
              <Button variant="tonal" onClick={() => setDropModalOpen(true)} disabled={isHomeBusy}>Drop input</Button>
            </div>
          </Card>
        </section>
      ) : null}

      {page === "editor" ? (
        <section className="mx-auto grid w-full max-w-[1480px] gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <Card elevated className="bg-anno-surface-low">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold">Editing: {selectedFace?.faceId ?? "(none)"}</h2>
                  <p className="text-sm text-anno-text-muted">Progress {Math.max(0, selectedIndex + 1)}/{faces.length} ({Math.round(progress)}%)</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${saveStateClassName[saveState]}`}>{saveStateMessage}{lastSavedAt ? ` (${lastSavedAt})` : ""}</span>
                  <Button variant="tonal" onClick={handleSave} disabled={isFaceBusy || isEditorBusy || !selectedFaceId}>Save now</Button>
                  <Button onClick={() => setPage("export")} disabled={isFaceBusy || isEditorBusy || !selectedFaceId}>Finish & export</Button>
                </div>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-anno-surface-high" aria-label="review progress">
                <span className="block h-full rounded-full bg-anno-primary transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outlined" onClick={() => void navigateToFace(faces[Math.max(selectedIndex - 1, 0)]?.faceId ?? "")} disabled={isFaceBusy || isEditorBusy || selectedIndex <= 0}>Previous</Button>
                <Button variant="outlined" onClick={() => void navigateToFace(faces[Math.min(selectedIndex + 1, faces.length - 1)]?.faceId ?? "")} disabled={isFaceBusy || isEditorBusy || selectedIndex < 0 || selectedIndex >= faces.length - 1}>Next</Button>
                <Button variant="text" onClick={() => void goHome()} disabled={isFaceBusy || isEditorBusy}>Return home</Button>
              </div>
            </Card>

            <Card className="bg-anno-surface-med">
              <div className="relative rounded-3xl bg-anno-surface-low p-3 ring-1 ring-white/5">
                {selectedFace ? (
                  <>
                    <img
                      ref={imageRef}
                      className="face-preview"
                      src={imageSrc}
                      alt={`Face preview for ${selectedFace.faceId}`}
                      onLoad={(event) => {
                        setPreviewError("");
                        setImageViewport({
                          naturalWidth: event.currentTarget.naturalWidth,
                          naturalHeight: event.currentTarget.naturalHeight,
                          displayWidth: event.currentTarget.clientWidth,
                          displayHeight: event.currentTarget.clientHeight,
                        });
                      }}
                      onError={() => {
                        setPreviewError(`Failed to load face preview for ${selectedFace.faceId} from ${selectedFaceImagePath}. Resolved src: ${imageSrc}. Dataset root: ${datasetRoot || "(empty)"}.`);
                      }}
                    />
                    <canvas
                      ref={canvasRef}
                      className="bbox-canvas"
                      aria-label="Bounding box canvas"
                      onPointerDown={handleCanvasPointerDown}
                      onPointerMove={handleCanvasPointerMove}
                      onPointerUp={handleCanvasPointerUp}
                      onPointerLeave={handleCanvasPointerUp}
                      style={{ cursor: canvasCursor }}
                    />
                  </>
                ) : (
                  <p className="py-16 text-center text-sm text-anno-text-muted">Open a dataset and select a face to start reviewing.</p>
                )}
              </div>
              {previewError ? <p className="mt-2 text-sm text-rose-300">{previewError}</p> : null}
            </Card>
          </div>

          <Card className="bg-anno-surface-low">
            <div className="mb-4 rounded-2xl bg-anno-surface-med p-3 ring-1 ring-white/5">
              <button className="text-sm font-medium text-anno-secondary transition hover:text-purple-300" onClick={toggleTutorial} aria-expanded={!tutorialCollapsed}>
                {tutorialCollapsed ? "Show quick tutorial" : "Hide quick tutorial"}
              </button>
              {!tutorialCollapsed ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-anno-text-muted">
                  <li>Click and drag to draw a box.</li>
                  <li>Drag center to move the active box.</li>
                  <li>Drag corners/edges to resize from any handle.</li>
                  <li>Use Delete/Backspace to remove the active box.</li>
                  <li>Use ←/→ keys or Previous/Next buttons to move between faces.</li>
                </ul>
              ) : null}
            </div>

            <h3 className="text-lg font-semibold">Bounding boxes</h3>
            <p className="mb-3 text-xs text-anno-text-muted">Suggestion count: {selectedFaceId ? (suggestionsByFace[selectedFaceId]?.length ?? 0) : 0}</p>
            <div className="max-h-[52vh] space-y-2 overflow-auto pr-1">
              {edits.map((edit, index) => (
                <div className={`bbox-editor rounded-2xl p-3 ring-1 transition ${activeBoxIndex === index ? "bg-anno-surface-high ring-anno-primary/40" : "bg-anno-surface-med ring-white/5"}`} key={`${selectedFaceId}-${index}`} onMouseEnter={() => setActiveBoxIndex(index)}>
                  <div className="mb-2 text-xs text-anno-text-muted">Box {index + 1}: {edit.bbox.map(coord).join(", ")}</div>
                  <div className="grid grid-cols-2 gap-2">
                    {(["x", "y", "w", "h"] as const).map((axis, axisIndex) => (
                      <label key={axis} className="text-xs text-anno-text-muted">
                        {axis}
                        <input className={inputClassName} aria-label={axis} value={edit.bbox[axisIndex]} onChange={(event) => handleEditChange(index, axisIndex, event.target.value)} />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {editValidationError ? <p className="mt-2 text-sm text-rose-300">Invalid edits: {editValidationError}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="tonal" onClick={handleAddBox} disabled={isFaceBusy || isEditorBusy || !selectedFaceId}>Add box</Button>
              <Button variant="outlined" onClick={handleDeleteActiveBox} disabled={isFaceBusy || isEditorBusy || !selectedFaceId || activeBoxIndex === null}>Delete active box</Button>
            </div>
          </Card>
        </section>
      ) : null}

      {page === "export" ? (
        <section className="mx-auto flex min-h-[62vh] w-full max-w-[900px] items-center justify-center">
          <Card elevated className="w-full bg-anno-surface-low">
            <SectionHeading title="Export final annotations" subtitle="Export reviewed annotations to COCO JSON." />
            <div className="rounded-3xl bg-gradient-to-br from-anno-surface-med via-anno-surface-low to-anno-surface-med p-5 ring-1 ring-white/5">
              <div className="mb-3 flex gap-2">
                <input className={inputClassName} value={outputPath} placeholder="Select export .json output" onChange={(event) => setOutputPath(event.target.value)} />
                <Button onClick={() => void pickSaveFile()} disabled={isExportBusy}>Browse</Button>
              </div>
              {outputPathError ? <p className="mb-3 text-sm text-rose-300">{outputPathError}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleExport} disabled={isExportBusy}>Export COCO</Button>
                <Button variant="outlined" onClick={() => setPage("editor")} disabled={isExportBusy}>Continue editing</Button>
                <Button variant="text" onClick={() => void goHome()} disabled={isExportBusy}>Return home</Button>
              </div>
            </div>
          </Card>
        </section>
      ) : null}

      <section className="fixed bottom-0 left-0 right-0 z-30 border-t border-anno-surface-high bg-black/40" aria-live="polite" aria-label="Application diagnostics terminal">
        <div className="mx-auto flex w-full max-w-[1480px] items-center justify-between px-4 py-2 text-xs md:px-8">
          <button className="font-medium text-anno-text-main transition hover:text-anno-primary" onClick={() => setDiagnosticsOpen((value) => !value)}>
            Diagnostics terminal {diagnosticsOpen ? "▾" : "▸"}
          </button>
          <span className={`rounded-full px-2 py-0.5 font-semibold ${error ? "bg-rose-500/20 text-rose-200" : "bg-emerald-500/20 text-emerald-200"}`}>{error ? "ERROR" : "READY"}</span>
        </div>
        {diagnosticsOpen ? <pre className={`terminal-scrollbar max-h-48 overflow-auto px-4 pb-3 text-xs text-anno-text-muted md:px-8 ${error ? "text-rose-200" : ""}`}>{diagnosticsText}</pre> : null}
      </section>

      {noticeMessage ? (
        <div className={modalOverlayClassName} role="alertdialog" aria-modal="true" aria-label="Generation notice">
          <div className="w-full max-w-xl rounded-3xl bg-anno-surface-med p-5 ring-1 ring-white/5 shadow-2xl shadow-black/60">
            <h3 className="text-lg font-semibold">Generation notice</h3>
            <p className="mt-1 text-sm text-anno-text-muted">Generation could not continue. See diagnostics for details.</p>
            <pre className="mt-3 max-h-44 overflow-auto rounded-2xl bg-anno-surface-low p-3 text-xs text-anno-text-muted">{noticeMessage}</pre>
            <div className="mt-3 flex gap-2">
              <Button variant="outlined" onClick={() => { setNoticeMessage(""); if (error) { clearDiagnostics("Ready."); } }}>Dismiss</Button>
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <LlmSettingsModal
          initial={llmSettings}
          onClose={() => setSettingsOpen(false)}
          onSave={async (request: SaveLlmSettingsRequest) => {
            const response = await saveLlmSettings(request);
            setLlmSettings(response);
            setSettingsOpen(false);
            updateDiagnostics("Settings saved", "");
          }}
          onClearProviderKey={async (provider) => {
            await clearProviderKey(provider);
            await refreshLlmSettings();
          }}
        />
      ) : null}
      {dropModalOpen ? (
        <div className={modalOverlayClassName} role="dialog" aria-modal="true" aria-label="Drop input files">
          <div className="w-full max-w-lg rounded-3xl bg-anno-surface-med p-5 ring-1 ring-white/5 shadow-2xl shadow-black/60">
            <h3 className="text-lg font-semibold">Drop input files</h3>
            <p className="mt-1 text-sm text-anno-text-muted">Drop dataset directory, COCO JSON, and MP4 anywhere on this window.</p>
            <div className="mt-3 flex gap-2">
              <Button variant="outlined" onClick={() => setDropModalOpen(false)}>Close</Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
