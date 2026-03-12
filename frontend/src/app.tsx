import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  setLlmApiKey,
  clearLlmApiKey,
  getSuggestions,
  startEditingSession,
  getSuggestionsReadiness,
  topupSuggestions,
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
import { defaultScheduler, sleep } from "./orchestration";

const nowIso = () => new Date().toISOString();
const AUTOSAVE_DEBOUNCE_MS = 1000;
const TUTORIAL_STORAGE_KEY = "bdr.editor.tutorialCollapsed";
const EDITOR_WARMUP_THRESHOLD_RATIO = 0.4;
const EDITOR_WARMUP_TIMEOUT_MS = 15000;
const EDITOR_WARMUP_POLL_MS = 300;
const EDITOR_WARMUP_TIMEOUT_REFRESH_MS = 2500;
const BACKGROUND_PREFETCH_POLL_MS = 1400;

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
type DiagnosticLevel = "info" | "warn" | "error";
type DiagnosticScope = "general" | "warmup" | "prefetch" | "suggestion-fetch" | "save" | "generation";

type DiagnosticLogEntry = {
  timestamp: string;
  level: DiagnosticLevel;
  scope: DiagnosticScope;
  message: string;
  metadata?: string;
};

type QueueStatusSummary = {
  unseen: number;
  queued: number;
  inFlight: number;
  ready: number;
  failed: number;
};

const resolveFaceImagePath = (datasetRoot: string, imagePath: string) => {
  const normalizedRoot = datasetRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = imagePath.replace(/\\/g, "/");
  if (normalizedPath.startsWith("/") || /^[A-Za-z]:\//.test(normalizedPath)) {
    return normalizedPath;
  }
  return `${normalizedRoot}/${normalizedPath}`;
};

const emptyQueueSummary = (): QueueStatusSummary => ({ unseen: 0, queued: 0, inFlight: 0, ready: 0, failed: 0 });


const queueSummaryText = (summary: QueueStatusSummary) => `ready=${summary.ready}, queued=${summary.queued}, in_flight=${summary.inFlight}, failed=${summary.failed}, unseen=${summary.unseen}`;

const suggestionEntryKey = (scopeKey: string, faceId: string) => `${scopeKey}::${faceId}`;

const summaryFromReadiness = (readiness: { readyCount: number; queuedCount: number; inProgressCount: number; failedCount: number }): QueueStatusSummary => ({
  unseen: 0,
  queued: readiness.queuedCount,
  inFlight: readiness.inProgressCount,
  ready: readiness.readyCount,
  failed: readiness.failedCount,
});

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
  const [isEnteringEditor, setIsEnteringEditor] = useState(false);
  const [editorWarmupFaceIds, setEditorWarmupFaceIds] = useState<string[]>([]);
  const [editorWarmupReadyCount, setEditorWarmupReadyCount] = useState(0);
  const [editorWarmupMessage, setEditorWarmupMessage] = useState("");
  const [skipWarmupRequested, setSkipWarmupRequested] = useState(false);
  const [warmupTimedOut, setWarmupTimedOut] = useState(false);
  const [warmupQueueSummary, setWarmupQueueSummary] = useState<QueueStatusSummary>({ unseen: 0, queued: 0, inFlight: 0, ready: 0, failed: 0 });
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState<number | null>(null);

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
  const [diagnosticsLog, setDiagnosticsLog] = useState<DiagnosticLogEntry[]>([
    {
      timestamp: nowIso(),
      level: "info",
      scope: "general",
      message: "Application started.",
    },
  ]);

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
  const skipWarmupRequestedRef = useRef(false);
  const warmupInFlightRef = useRef(false);
  const isDisposedRef = useRef(false);
  const lifetimeAbortRef = useRef<AbortController | null>(null);

  if (!lifetimeAbortRef.current) {
    lifetimeAbortRef.current = new AbortController();
  }

  useEffect(() => {
    return () => {
      isDisposedRef.current = true;
      lifetimeAbortRef.current?.abort();
    };
  }, []);

  const isAlive = useCallback(() => !isDisposedRef.current, []);

  useEffect(() => {
    editsRef.current = edits;
  }, [edits]);

  useEffect(() => {
    selectedFaceIdRef.current = selectedFaceId;
  }, [selectedFaceId]);

  useEffect(() => {
    skipWarmupRequestedRef.current = skipWarmupRequested;
  }, [skipWarmupRequested]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [canvasCursor, setCanvasCursor] = useState("crosshair");
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
  const suggestionScopeKey = useMemo(
    () =>
      JSON.stringify({
        datasetRoot: datasetRoot.replace(/\\/g, "/").replace(/\/+$/, ""),
        provider: llmSettings?.openai.enabled ? "openai" : llmSettings?.anthropic.enabled ? "anthropic" : "none",
        openaiModel: llmSettings?.openai.model ?? "",
        anthropicModel: llmSettings?.anthropic.model ?? "",
        reasoningPreset: llmSettings?.reasoningPreset ?? "",
        prefetchBufferSize: llmSettings?.prefetchBufferSize ?? 0,
        editorWarmupThresholdRatio: llmSettings?.editorWarmupThresholdRatio ?? 0,
      }),
    [
      datasetRoot,
      llmSettings?.openai.enabled,
      llmSettings?.anthropic.enabled,
      llmSettings?.openai.model,
      llmSettings?.anthropic.model,
      llmSettings?.reasoningPreset,
      llmSettings?.prefetchBufferSize,
      llmSettings?.editorWarmupThresholdRatio,
    ]
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

  useEffect(() => {
    setSuggestionsByFace({});
  }, [suggestionScopeKey]);

  const prefetchLinearSuggestions = useCallback(async () => {
    if (!llmSettings?.llmSuggestionsEnabled || !datasetRoot || faces.length === 0 || selectedIndex < 0) {
      return;
    }
    const currentFaceId = faces[selectedIndex]?.faceId;
    if (!currentFaceId) {
      return;
    }
    try {
      const readiness = await topupSuggestions({
        datasetRoot,
        currentFaceId,
        lookaheadWindow: Math.max(0, llmSettings.prefetchBufferSize - 1),
        targetBufferSize: llmSettings.prefetchBufferSize,
      });
      const summary = summaryFromReadiness(readiness);
      updateDiagnostics("Suggestion prefetch queued", "", { scope: "prefetch", metadata: `faces=${readiness.candidateFaceIds.length}, readyFaces=${readiness.readyFaceIds.length}, ${queueSummaryText(summary)}` });
      for (const readyFaceId of readiness.readyFaceIds) {
        const readyKey = suggestionEntryKey(suggestionScopeKey, readyFaceId);
        if (suggestionsByFace[readyKey]) {
          continue;
        }
        try {
          const response = await getSuggestions(datasetRoot, readyFaceId);
          setSuggestionsByFace((prev) => (prev[readyKey] ? prev : { ...prev, [readyKey]: response.suggestions }));
        } catch {
          // queue will retry/fail; diagnostics logged in focused fetch path
        }
      }
    } catch (cause) {
      updateDiagnostics("Suggestion prefetch failed", String(cause), { scope: "prefetch" });
    }
  }, [llmSettings?.llmSuggestionsEnabled, llmSettings?.prefetchBufferSize, datasetRoot, faces, selectedIndex, suggestionScopeKey, suggestionsByFace]);

  useEffect(() => {
    void prefetchLinearSuggestions();
    if (!llmSettings?.llmSuggestionsEnabled) {
      return;
    }
    const timer = window.setInterval(() => {
      void prefetchLinearSuggestions();
    }, BACKGROUND_PREFETCH_POLL_MS);
    return () => window.clearInterval(timer);
  }, [prefetchLinearSuggestions, llmSettings?.llmSuggestionsEnabled]);


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

  const pushDiagnostic = useCallback((entry: Omit<DiagnosticLogEntry, "timestamp">) => {
    const timestamp = nowIso();
    setDiagnosticsLog((prev) => [...prev, { ...entry, timestamp }]);
  }, []);

  const updateDiagnostics = useCallback((nextStatus: string, nextError = "", options?: { scope?: DiagnosticScope; level?: DiagnosticLevel; metadata?: string }) => {
    const level = options?.level ?? (nextError ? "error" : "info");
    const scope = options?.scope ?? "general";
    pushDiagnostic({ level, scope, message: nextStatus, metadata: nextError || options?.metadata });
  }, [pushDiagnostic]);

  const clearDiagnostics = useCallback((nextStatus = "Ready.") => {
    pushDiagnostic({ level: "info", scope: "general", message: nextStatus });
  }, [pushDiagnostic]);

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
    let disposed = false;

    const attach = async () => {
      const attached = await getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") {
          return;
        }

        void applyDroppedPaths(event.payload.paths);
      });
      if (disposed) {
        attached();
        return;
      }
      unlisten = attached;
    };

    void attach();

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenProgress: (() => void) | undefined;

    const attach = async () => {
      const attached = await listen("generation-progress", (event) => {
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
            : (phase === "probing_video" || phase === "planning_frames")
              ? "extracting"
              : (["idle", "validating", "dependencies", "extracting", "generating", "aborting", "done"].includes(phase)
                ? (phase as GenerationStep)
                : "generating");
        setGenerationStep(nextStep);
        setGenerationPercent(payload.percent ?? 0);
        setGenerationDetail(payload.detail ?? "Working...");
        setGenerationHeartbeat(`Last update ${Math.round((payload.elapsedMs ?? 0) / 1000)}s`);
      });
      if (disposed) {
        attached();
        return;
      }
      unlistenProgress = attached;
    };

    void attach();
    return () => {
      disposed = true;
      if (unlistenProgress) {
        unlistenProgress();
      }
    };
  }, []);


  useEffect(() => {
    const timer = window.setInterval(() => {
      setGenerationHeartbeat((current) => {
        const match = /Last update (\d+)s/.exec(current);
        if (!match) return current;
        const next = Number(match[1]) + 1;
        return `Last update ${next}s`;
      });
    }, 1000);

    return () => window.clearInterval(timer);
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

  const enterEditorWithWarmup = useCallback(async (nextFaces: FaceListItem[]) => {
    if (warmupInFlightRef.current) {
      updateDiagnostics("Editor warmup already in progress", "", { scope: "warmup", level: "warn" });
      return;
    }

    if (!llmSettings?.llmSuggestionsEnabled || nextFaces.length === 0 || !datasetRoot) {
      setPage("editor");
      return;
    }

    const maxFaces = Math.max(1, llmSettings.prefetchBufferSize);
    const targetFaceIds = nextFaces.slice(0, maxFaces).map((face) => face.faceId);
    const uncachedFaceIds = targetFaceIds.filter((faceId) => !suggestionsByFace[suggestionEntryKey(suggestionScopeKey, faceId)]);
    if (uncachedFaceIds.length === 0) {
      setPage("editor");
      return;
    }

    const thresholdRatio = llmSettings.editorWarmupThresholdRatio ?? EDITOR_WARMUP_THRESHOLD_RATIO;
    const timeoutMs = llmSettings.editorWarmupTimeoutMs ?? EDITOR_WARMUP_TIMEOUT_MS;
    const requiredReady = Math.max(1, Math.ceil(uncachedFaceIds.length * thresholdRatio));
    warmupInFlightRef.current = true;
    setIsEnteringEditor(true);
    setWarmupTimedOut(false);
    setEditorWarmupFaceIds(uncachedFaceIds);
    setEditorWarmupReadyCount(0);
    setSkipWarmupRequested(false);
    setWarmupQueueSummary(emptyQueueSummary());
    setEditorWarmupMessage(`Preparing suggestions for ${uncachedFaceIds.length} face(s). Need ${requiredReady} ready before entering editor.`);

    const startedAt = Date.now();
    let dynamicDeadline = startedAt + timeoutMs;
    let lastReadyCount = 0;
    try {
      const start = await startEditingSession({
        datasetRoot,
        currentFaceId: uncachedFaceIds[0],
        lookaheadWindow: Math.max(0, llmSettings.prefetchBufferSize - 1),
        targetBufferSize: llmSettings.prefetchBufferSize,
        minReadyToStart: requiredReady,
      });
      updateDiagnostics("Editor warmup started", "", { scope: "warmup", metadata: `targets=${uncachedFaceIds.length}, required=${requiredReady}, ${queueSummaryText(summaryFromReadiness(start))}` });
      while (Date.now() < dynamicDeadline) {
        if (!isAlive() || lifetimeAbortRef.current?.signal.aborted) {
          return;
        }
        const readiness = await getSuggestionsReadiness({
          datasetRoot,
          currentFaceId: uncachedFaceIds[0],
          lookaheadWindow: Math.max(0, llmSettings.prefetchBufferSize - 1),
        });
        const summary = summaryFromReadiness(readiness);
        setWarmupQueueSummary(summary);
        const readyCount = summary.ready;
        setEditorWarmupReadyCount(readyCount);
        setEditorWarmupMessage(`Preparing suggestions: targets=${uncachedFaceIds.length}, required=${requiredReady}; ${queueSummaryText(summary)}`);
        updateDiagnostics("Editor warmup poll", "", { scope: "warmup", metadata: `targets=${uncachedFaceIds.length}, required=${requiredReady}, ${queueSummaryText(summary)}` });
        if (readyCount > lastReadyCount) {
          dynamicDeadline = Math.max(dynamicDeadline, Date.now() + EDITOR_WARMUP_TIMEOUT_REFRESH_MS);
          lastReadyCount = readyCount;
        }
        if (readyCount >= requiredReady) {
          break;
        }
        if (skipWarmupRequestedRef.current) {
          updateDiagnostics("Editor warmup skipped", "", { scope: "warmup", level: "warn", metadata: `Entered editor early. targets=${uncachedFaceIds.length}, required=${requiredReady}, ${queueSummaryText(summary)}` });
          break;
        }
        await topupSuggestions({
          datasetRoot,
          currentFaceId: uncachedFaceIds[0],
          lookaheadWindow: Math.max(0, llmSettings.prefetchBufferSize - 1),
          targetBufferSize: llmSettings.prefetchBufferSize,
        });
        await sleep(EDITOR_WARMUP_POLL_MS, lifetimeAbortRef.current?.signal, defaultScheduler);
      }
      if (!skipWarmupRequestedRef.current && Date.now() >= dynamicDeadline) {
        const readiness = await getSuggestionsReadiness({
          datasetRoot,
          currentFaceId: uncachedFaceIds[0],
          lookaheadWindow: Math.max(0, llmSettings.prefetchBufferSize - 1),
        });
        const summary = summaryFromReadiness(readiness);
        setWarmupQueueSummary(summary);
        setWarmupTimedOut(true);
        updateDiagnostics("Editor warmup timed out", "", { scope: "warmup", level: "warn", metadata: `Entered editor after timeout. targets=${uncachedFaceIds.length}, required=${requiredReady}, ${queueSummaryText(summary)}` });
      }
    } catch (cause) {
      if (!isAlive() || lifetimeAbortRef.current?.signal.aborted) {
        return;
      }
      updateDiagnostics("Editor warmup failed", String(cause), { scope: "warmup" });
    } finally {
      if (!isAlive()) {
        return;
      }
      warmupInFlightRef.current = false;
      setIsEnteringEditor(false);
      setEditorWarmupReadyCount(0);
      setEditorWarmupMessage("");
      setSkipWarmupRequested(false);
      setPage("editor");
    }
  }, [datasetRoot, llmSettings?.llmSuggestionsEnabled, llmSettings?.prefetchBufferSize, llmSettings?.editorWarmupThresholdRatio, llmSettings?.editorWarmupTimeoutMs, suggestionScopeKey, suggestionsByFace]);

  const retryWarmupForCurrentBuffer = async () => {
    if (!datasetRoot || !llmSettings?.llmSuggestionsEnabled || faces.length === 0) {
      return;
    }
    const bufferStart = Math.max(0, selectedIndex);
    const bufferEnd = Math.min(faces.length, bufferStart + Math.max(1, llmSettings.prefetchBufferSize));
    await enterEditorWithWarmup(faces.slice(bufferStart, bufferEnd));
  };

  const handleOpen = async () => {
    if (datasetRootError) {
      updateDiagnostics("Open dataset blocked", datasetRootError);
      return;
    }

    setIsImporting(true);
    try {
      const { openReport, faceReport } = await refreshFaces();
      updateDiagnostics(`Dataset opened\nmanifest: ${openReport.manifestPath}\nfaces: ${openReport.faceCount}`);
      await enterEditorWithWarmup(faceReport.faces);
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
        gpuAcceleration: "auto",
      });

      setGenerationJobId(start.jobId);
      setGenerationHeartbeat(`Job ${start.jobId} running`);
      let report;
      while (!report) {
        if (!isAlive() || lifetimeAbortRef.current?.signal.aborted) {
          return;
        }
        await sleep(350, lifetimeAbortRef.current?.signal, defaultScheduler);
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

      const { faceReport } = await refreshFaces();
      await enterEditorWithWarmup(faceReport.faces);
      setGenerationStep("done");
      setGenerationPercent(100);
      setGenerationDetail("Done: review dataset is ready.");
      setGenerationHeartbeat("Complete");
      updateDiagnostics(
        `Review dataset generation complete\n${runtimeReport}\nsourceFramesDir (auto-generated): ${sourceFramesDir}\nextractedFrames: ${report.extractedFrameCount}\nskippedCachedFrames: ${report.skippedExistingCount}\nmanifest: ${report.writtenManifestPath}\nfaces: ${report.faceCount}\nfilteredBoxes: ${report.filteredBoxCount}`
      );
    } catch (cause) {
      if (!isAlive() || lifetimeAbortRef.current?.signal.aborted) {
        return;
      }
      setGenerationStep("idle");
      setGenerationPercent(0);
      setGenerationDetail("Idle.");
      setGenerationHeartbeat("Idle");
      const message = String(cause);
      updateDiagnostics("Review dataset generation failed", message, { scope: "generation" });
      setNoticeMessage(message);
    } finally {
      if (!isAlive()) {
        return;
      }
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
      updateDiagnostics("Generation abort requested", "Waiting for background cleanup to finish.", { scope: "generation", level: "warn" });
    } catch (cause) {
      updateDiagnostics("Generation abort failed", String(cause), { scope: "generation" });
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
        updateDiagnostics("Save blocked due to invalid edits", validationError, { scope: "save" });
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
            updateDiagnostics(`Saved ${saved.length} annotation(s) for ${saveFaceId}`, "", { scope: "save" });
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
          updateDiagnostics("Save edits failed", String(cause), { scope: "save" });
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
    setSelectedSuggestionIndex(null);
  }, [selectedFaceId]);

  useEffect(() => {
    const faceId = selectedFaceId;
    if (!faceId || !datasetRoot || !llmSettings?.llmSuggestionsEnabled) {
      return;
    }
    const cacheKey = suggestionEntryKey(suggestionScopeKey, faceId);
    if (suggestionsByFace[cacheKey]) {
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        const response = await getSuggestions(datasetRoot, faceId);
        if (cancelled) return;
        setSuggestionsByFace((prev) => ({ ...prev, [cacheKey]: response.suggestions }));
        const diagnosticsMetadata = response.diagnostics
          ? `, tools=${response.diagnostics.toolEnabled}, outputMode=${response.diagnostics.outputMode}, providerStatus=${response.diagnostics.providerStatus}`
          : "";
        updateDiagnostics("Suggestion fetch complete", "", {
          scope: "suggestion-fetch",
          metadata: `faceId=${faceId}, provider=${response.provider}, model=${response.model}, attempts=${response.attempts}, suggestions=${response.suggestions.length}${diagnosticsMetadata}`,
        });
      } catch (cause) {
        if (cancelled) return;
        updateDiagnostics("Suggestion fetch failed", String(cause), { scope: "suggestion-fetch", metadata: `faceId=${faceId}` });
      }

    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedFaceId, datasetRoot, llmSettings?.llmSuggestionsEnabled, suggestionScopeKey, suggestionsByFace, faces, updateDiagnostics]);

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

    const selectedSuggestions = selectedFaceId ? (suggestionsByFace[suggestionEntryKey(suggestionScopeKey, selectedFaceId)] ?? []) : [];
    selectedSuggestions.forEach((entry, index) => {
      const [x, y, w, h] = entry.bbox;
      const isSelectedSuggestion = selectedSuggestionIndex === index;
      context.strokeStyle = isSelectedSuggestion ? "#a855f7" : "#14b8a6";
      context.setLineDash([4, 4]);
      context.lineWidth = isSelectedSuggestion ? 2.5 : 1.5;
      context.strokeRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);
      context.setLineDash([]);
      context.fillStyle = isSelectedSuggestion ? "rgba(168,85,247,0.16)" : "rgba(20,184,166,0.08)";
      context.fillRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);
      context.fillStyle = "#a7f3d0";
      context.fillText(`S${index + 1}`, x * scaleX + 4, y * scaleY + 28);
    });
  }, [edits, imageViewport, activeBoxIndex, selectedFaceId, suggestionScopeKey, suggestionsByFace, selectedSuggestionIndex]);

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


  const suggestionToEdit = useCallback((suggestion: SuggestionBox): AnnotationEdit => ({
    bbox: suggestion.bbox,
    provenance: { source: suggestion.source || "llm_suggestion", updatedAt: nowIso() },
  }), []);

  const addSuggestionToEdits = useCallback((suggestion: SuggestionBox) => {
    setEdits((previous) => [...previous, suggestionToEdit(suggestion)]);
    setEditValidationError("");
  }, [suggestionToEdit]);

  const applyAllSuggestionsToEdits = useCallback(() => {
    const suggestions = selectedFaceId ? (suggestionsByFace[suggestionEntryKey(suggestionScopeKey, selectedFaceId)] ?? []) : [];
    if (suggestions.length === 0) {
      return;
    }
    setEdits((previous) => [...previous, ...suggestions.map((suggestion) => suggestionToEdit(suggestion))]);
    setEditValidationError("");
  }, [selectedFaceId, suggestionScopeKey, suggestionsByFace, suggestionToEdit]);

  const replaceEditsWithSuggestions = useCallback(() => {
    const suggestions = selectedFaceId ? (suggestionsByFace[suggestionEntryKey(suggestionScopeKey, selectedFaceId)] ?? []) : [];
    if (suggestions.length === 0) {
      return;
    }
    const confirmed = window.confirm("Replace current editable annotations with LLM suggestions?");
    if (!confirmed) {
      return;
    }
    setEdits(suggestions.map((suggestion) => suggestionToEdit(suggestion)));
    setActiveBoxIndex(null);
    setEditValidationError("");
  }, [selectedFaceId, suggestionScopeKey, suggestionsByFace, suggestionToEdit]);

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

  const latestDiagnosticEntry = diagnosticsLog[diagnosticsLog.length - 1] ?? null;
  const hasDiagnosticError = latestDiagnosticEntry?.level === "error";
  const diagnosticsText = ["$ bdr-anno-review", ...diagnosticsLog.map((entry) => {
    const scope = `[${entry.scope}]`;
    const level = `[${entry.level}]`;
    const metadata = entry.metadata ? `\n  ${entry.metadata}` : "";
    return `${entry.timestamp} ${level} ${scope} ${entry.message}${metadata}`;
  })].join("\n");
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
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(99,102,241,0.10),transparent_42%)]" />
      <div className="relative mx-auto flex w-full max-w-[1480px] items-center justify-between gap-3 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Anno Review Workspace</h1>
          <p className="text-xs text-zinc-500">Refined annotation tooling with layered surfaces and focused flow.</p>
        </div>
        <Button aria-label="Open settings" variant="tonal" onClick={() => setSettingsOpen(true)} disabled={isHomeBusy || isFaceBusy || isExportBusy}>⚙ Settings</Button>
      </div>

      {page === "home" ? (
        <section className="relative mx-auto grid w-full max-w-[1200px] gap-5 lg:grid-cols-[1.45fr_1fr]">
          <Card elevated className="min-h-[540px] rounded-2xl bg-anno-surface-low">
            <SectionHeading title="Create new dataset" subtitle="Create a new review-ready dataset through a unified import wizard." />
            <Field label="Project directory" hint="Where Anno stores project metadata and generated assets.">
              <div className="flex gap-2">
                <input className={inputClassName} aria-label="Dataset root" value={datasetRoot} placeholder="Choose project directory" onChange={(event) => setDatasetRoot(event.target.value)} />
                <Button variant="ghost" onClick={() => void pickDirectory(setDatasetRoot)} disabled={isHomeBusy}>Browse</Button>
              </div>
            </Field>

            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Import COCO" hint="Select your instances JSON file.">
                <div className="flex gap-2">
                  <input className={inputClassName} aria-label="COCO JSON" value={cocoJsonPath} placeholder="Choose COCO annotations (.json)" onChange={(event) => setCocoJsonPath(event.target.value)} />
                  <Button variant="ghost" onClick={() => void pickFile(setCocoJsonPath, [{ name: "JSON", extensions: ["json"] }])} disabled={isHomeBusy}>Browse</Button>
                </div>
              </Field>

              <Field label="Import MP4/frames" hint="Pick the source video (.mp4) used for frame generation.">
                <div className="flex gap-2">
                  <input className={inputClassName} aria-label="Source MP4" value={mp4Path} placeholder="Choose source video (.mp4)" onChange={(event) => setMp4Path(event.target.value)} />
                  <Button variant="ghost" onClick={() => void pickFile(setMp4Path, [{ name: "MP4", extensions: ["mp4"] }])} disabled={isHomeBusy}>Browse</Button>
                </div>
              </Field>
            </div>

            <Field label="Source frames directory (auto-managed)">
              <input className={inputClassName} aria-label="Source frames directory (auto-managed)" value={sourceFramesDir} readOnly />
            </Field>

            {importInputError ? (
              <div className="mb-3 inline-flex items-center gap-1.5 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-200">
                <span aria-hidden="true" className="text-rose-300">ⓘ</span>
                <span>{importInputError}</span>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button className="shadow-indigo-500/20 shadow-lg hover:scale-[1.02]" onClick={handleGenerate} disabled={isHomeBusy || !!importInputError}>{isGenerating ? "Generating…" : "Generate"}</Button>
              {showGenerationSpinner ? <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-anno-primary border-t-transparent" aria-label="Generation in progress" /> : null}
              <Button variant="outlined" onClick={() => void handleAbortGeneration()} disabled={!isGenerating || !generationJobId}>Abort</Button>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-anno-surface-high" aria-label="generation progress">
              <span className="block h-full rounded-full bg-anno-primary transition-all duration-300" style={{ width: `${generationPercent}%` }} />
            </div>
            <p className="mt-2 text-xs text-anno-text-muted">Step: {generationStep} • {generationDetail} • {generationHeartbeat}</p>
          </Card>

          <Card className="min-h-[540px] rounded-2xl bg-anno-surface-low p-6">
            <SectionHeading title="Resume existing dataset" subtitle="Jump straight into annotation review." />
            <Field label="Open project directory" hint="Resume from an existing dataset root.">
              <div className="flex gap-2">
                <input className={inputClassName} aria-label="Resume dataset directory" value={datasetRoot} placeholder="Choose existing project directory" onChange={(event) => setDatasetRoot(event.target.value)} />
                <Button variant="ghost" onClick={() => void pickDirectory(setDatasetRoot)} disabled={isHomeBusy}>Browse</Button>
              </div>
            </Field>
            {datasetRootError ? <div className="mb-3 inline-flex items-center gap-1.5 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-200"><span aria-hidden="true" className="text-rose-300">ⓘ</span><span>{datasetRootError}</span></div> : null}
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

            {warmupTimedOut ? (
              <Card className="bg-anno-surface-med">
                <div className="rounded-2xl border border-amber-300/30 bg-amber-400/10 p-3 text-sm text-amber-100">
                  <p className="font-medium">Suggestions still loading in background.</p>
                  <p className="mt-1 text-xs text-amber-200">{queueSummaryText(warmupQueueSummary)}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="outlined" onClick={() => void retryWarmupForCurrentBuffer()}>Retry warmup for current buffer</Button>
                    <Button variant="text" onClick={() => setWarmupTimedOut(false)}>Continue immediately</Button>
                  </div>
                </div>
              </Card>
            ) : null}

            <Card className="bg-anno-surface-med">
              <div className="relative rounded-2xl bg-anno-surface-low p-3 ring-1 ring-white/5">
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
            <p className="mb-1 text-xs text-anno-text-muted">Editable boxes: {edits.length}</p>
            <p className="mb-3 text-xs text-anno-text-muted">LLM suggestion count: {selectedFaceId ? (suggestionsByFace[suggestionEntryKey(suggestionScopeKey, selectedFaceId)]?.length ?? 0) : 0}</p>

            <div className="mb-3 rounded-2xl bg-anno-surface-med p-3 ring-1 ring-white/5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">LLM suggestions</h4>
                <div className="flex gap-2">
                  <Button variant="tonal" onClick={applyAllSuggestionsToEdits} disabled={isFaceBusy || isEditorBusy || !selectedFaceId || (suggestionsByFace[suggestionEntryKey(suggestionScopeKey, selectedFaceId)]?.length ?? 0) === 0}>Apply all suggestions to edits</Button>
                  <Button variant="outlined" onClick={replaceEditsWithSuggestions} disabled={isFaceBusy || isEditorBusy || !selectedFaceId || (suggestionsByFace[suggestionEntryKey(suggestionScopeKey, selectedFaceId)]?.length ?? 0) === 0}>Replace edits with suggestions</Button>
                </div>
              </div>
              <div className="max-h-40 space-y-2 overflow-auto pr-1">
                {(selectedFaceId ? (suggestionsByFace[suggestionEntryKey(suggestionScopeKey, selectedFaceId)] ?? []) : []).map((suggestion, index) => (
                  <div key={`suggestion-${selectedFaceId}-${index}`} className={`rounded-xl p-2 ring-1 ${selectedSuggestionIndex === index ? "bg-anno-surface-high ring-purple-400/60" : "bg-anno-surface-low ring-teal-300/30"}`} onMouseEnter={() => setSelectedSuggestionIndex(index)}>
                    <div className="text-xs text-anno-text-muted">Suggestion {index + 1}: {suggestion.bbox.map(coord).join(", ")}</div>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-[11px] text-anno-text-muted">source: {suggestion.source}{typeof suggestion.confidence === "number" ? ` • conf=${coord(suggestion.confidence)}` : ""}</span>
                      <Button variant="text" onClick={() => addSuggestionToEdits(suggestion)} disabled={isFaceBusy || isEditorBusy}>Add suggestion as new box</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="max-h-[38vh] space-y-2 overflow-auto pr-1">
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
            <div className="rounded-2xl bg-gradient-to-br from-anno-surface-med via-anno-surface-low to-anno-surface-med p-5 ring-1 ring-white/5">
              <div className="mb-3 flex gap-2">
                <input className={inputClassName} value={outputPath} placeholder="Select export .json output" onChange={(event) => setOutputPath(event.target.value)} />
                <Button variant="ghost" onClick={() => void pickSaveFile()} disabled={isExportBusy}>Browse</Button>
              </div>
              {outputPathError ? <div className="mb-3 inline-flex items-center gap-1.5 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-200"><span aria-hidden="true" className="text-rose-300">ⓘ</span><span>{outputPathError}</span></div> : null}
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleExport} disabled={isExportBusy}>Export COCO</Button>
                <Button variant="outlined" onClick={() => setPage("editor")} disabled={isExportBusy}>Continue editing</Button>
                <Button variant="text" onClick={() => void goHome()} disabled={isExportBusy}>Return home</Button>
              </div>
            </div>
          </Card>
        </section>
      ) : null}

      <section className="fixed bottom-0 left-0 right-0 z-30 border-t border-anno-surface-high bg-[#09090b]/90" aria-live="polite" aria-label="Application diagnostics terminal">
        <div className="mx-auto flex w-full max-w-[1480px] items-center justify-between gap-3 px-4 py-2 text-xs md:px-8">
          <button className="font-medium text-anno-text-main transition hover:text-anno-primary" onClick={() => setDiagnosticsOpen((value) => !value)}>
            Diagnostics terminal <span className={`inline-block transition-transform duration-200 ${diagnosticsOpen ? "rotate-180" : "rotate-0"}`}>⌄</span>
          </button>
          <div className="flex items-center gap-2">
            <Button variant="text" onClick={() => void navigator.clipboard.writeText(diagnosticsText)}>Copy diagnostics</Button>
            <Button variant="text" onClick={() => setDiagnosticsLog((prev) => prev.slice(-1))}>Clear log</Button>
            <span className={`rounded-full px-2 py-0.5 font-semibold ${hasDiagnosticError ? "bg-rose-500/20 text-rose-200" : "bg-emerald-500/20 text-emerald-200"}`}>{hasDiagnosticError ? "ERROR" : "READY"}</span>
          </div>
        </div>
        {diagnosticsOpen ? <pre className={`terminal-scrollbar max-h-56 overflow-auto bg-[#09090b] px-4 pb-3 text-xs text-anno-text-muted md:px-8 ${hasDiagnosticError ? "text-rose-200" : ""}`}>{diagnosticsText}</pre> : null}
      </section>

      {noticeMessage ? (
        <div className={modalOverlayClassName} role="alertdialog" aria-modal="true" aria-label="Generation notice">
          <div className="w-full max-w-xl rounded-2xl bg-anno-surface-med p-5 ring-1 ring-white/5 shadow-2xl shadow-black/60">
            <h3 className="text-lg font-semibold">Generation notice</h3>
            <p className="mt-1 text-sm text-anno-text-muted">Generation could not continue. See diagnostics for details.</p>
            <pre className="mt-3 max-h-44 overflow-auto rounded-2xl bg-anno-surface-low p-3 text-xs text-anno-text-muted">{noticeMessage}</pre>
            <div className="mt-3 flex gap-2">
              <Button variant="outlined" onClick={() => { setNoticeMessage(""); if (hasDiagnosticError) { clearDiagnostics("Ready."); } }}>Dismiss</Button>
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
            updateDiagnostics("Settings saved", "");
          }}
          onSetProviderKey={async (provider, apiKey) => {
            await setLlmApiKey({ provider, apiKey });
            await refreshLlmSettings();
            updateDiagnostics("API key updated");
          }}
          onClearProviderKey={async (provider) => {
            await clearLlmApiKey(provider);
            await refreshLlmSettings();
            updateDiagnostics("API key cleared");
          }}
        />
      ) : null}
      {isEnteringEditor ? (
        <div className={modalOverlayClassName} role="alertdialog" aria-modal="true" aria-label="Preparing suggestions">
          <div className="w-full max-w-xl rounded-2xl bg-anno-surface-med p-5 ring-1 ring-white/5 shadow-2xl shadow-black/60">
            <h3 className="text-lg font-semibold">Preparing suggestions</h3>
            <p className="mt-1 text-sm text-anno-text-muted">Building an initial LLM suggestion buffer before entering editor.</p>
            <p className="mt-3 text-xs text-anno-text-muted">{editorWarmupMessage || "Preparing suggestions..."}</p>
            <p className="mt-1 text-xs text-anno-text-muted">Targets: {editorWarmupFaceIds.length} • Required threshold ready: {Math.max(1, Math.ceil(editorWarmupFaceIds.length * (llmSettings?.editorWarmupThresholdRatio ?? EDITOR_WARMUP_THRESHOLD_RATIO)))} • Ready now: {editorWarmupReadyCount}</p>
            <p className="mt-1 text-xs text-anno-text-muted">Queue status: {queueSummaryText(warmupQueueSummary)}</p>
            <div className="mt-3 flex gap-2">
              <Button variant="outlined" onClick={() => void retryWarmupForCurrentBuffer()} disabled={isEnteringEditor}>Retry warmup for current buffer</Button>
              <Button variant="tonal" onClick={() => setSkipWarmupRequested(true)}>Continue immediately</Button>
            </div>
          </div>
        </div>
      ) : null}
      {dropModalOpen ? (
        <div className={modalOverlayClassName} role="dialog" aria-modal="true" aria-label="Drop input files">
          <div className="w-full max-w-lg rounded-2xl bg-anno-surface-med p-5 ring-1 ring-white/5 shadow-2xl shadow-black/60">
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
