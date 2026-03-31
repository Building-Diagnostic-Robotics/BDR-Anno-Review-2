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
import type { AnnotationEdit, FaceListItem, LlmSettingsResponse, SaveLlmSettingsRequest, SuggestionBox } from "./types";
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
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Pill,
  SectionHeading,
  SectionTabs,
  SegmentedControl,
  StatTile,
  inputClassName,
  modalOverlayClassName,
} from "./ui-primitives";
import { defaultScheduler, sleep } from "./orchestration";
import { DiagnosticsDrawer, WorkspaceStatusRail, WorkspaceTopBar, type WorkspaceStep } from "./workspace-shell";

const nowIso = () => new Date().toISOString();
const AUTOSAVE_DEBOUNCE_MS = 1000;
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
type IntakeMode = "create" | "open";
type EditorInspectorTab = "annotations" | "suggestions" | "help";
type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
type DiagnosticLevel = "info" | "warn" | "error";
type DiagnosticScope = "general" | "warmup" | "prefetch" | "suggestion-fetch" | "save" | "generation";
type DiagnosticsPanelState = "collapsed" | "expanded";

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
  const [intakeMode, setIntakeMode] = useState<IntakeMode>("create");
  const [inspectorTab, setInspectorTab] = useState<EditorInspectorTab>("annotations");
  const [faceSearchQuery, setFaceSearchQuery] = useState("");

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
  const [diagnosticsPanelState, setDiagnosticsPanelState] = useState<DiagnosticsPanelState>("collapsed");
  const [diagnosticsLog, setDiagnosticsLog] = useState<DiagnosticLogEntry[]>([
    {
      timestamp: nowIso(),
      level: "info",
      scope: "general",
      message: "Application started.",
    },
  ]);

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
  const diagnosticsOpen = diagnosticsPanelState === "expanded";


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
  const filteredFaces = useMemo(() => {
    const query = faceSearchQuery.trim().toLowerCase();
    if (!query) {
      return faces;
    }
    return faces.filter((face) => face.faceId.toLowerCase().includes(query) || face.face.toLowerCase().includes(query));
  }, [faceSearchQuery, faces]);
  const readySuggestionCount = useMemo(
    () =>
      faces.reduce((count, face) => {
        const ready = (suggestionsByFace[suggestionEntryKey(suggestionScopeKey, face.faceId)]?.length ?? 0) > 0;
        return count + (ready ? 1 : 0);
      }, 0),
    [faces, suggestionScopeKey, suggestionsByFace]
  );
  const totalInitialBoxCount = useMemo(
    () => faces.reduce((count, face) => count + face.initialBoxCount, 0),
    [faces]
  );
  const workspaceStep: WorkspaceStep = page === "home" ? "setup" : page === "editor" ? "review" : "export";
  const workspaceContextLabel = datasetRoot
    ? datasetRoot.split(/[\\/]/).filter(Boolean).pop() ?? datasetRoot
    : "No workspace selected";
  const workspaceContextDetail = datasetRoot
    ? datasetRoot
    : "Choose a project directory to create a new review set or reopen an existing one.";

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
    setInspectorTab("annotations");
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

  const goHome = async () => {
    await flushAutosave();
    setPage("home");
  };

  const getSuggestionPillForFace = (faceId: string): { label: string; tone: "neutral" | "accent" | "success" | "info" } => {
    if (!llmSettings?.llmSuggestionsEnabled) {
      return { label: "Manual", tone: "neutral" };
    }

    const suggestionCount = suggestionsByFace[suggestionEntryKey(suggestionScopeKey, faceId)]?.length ?? 0;
    if (suggestionCount > 0) {
      return { label: `${suggestionCount} ready`, tone: "success" };
    }

    if (faceId === selectedFaceId && isFaceBusy) {
      return { label: "Loading", tone: "info" };
    }

    return { label: "Queued", tone: "accent" };
  };

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard?.writeText(diagnosticsText);
    } catch (cause) {
      updateDiagnostics("Copy diagnostics failed", String(cause));
    }
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
    idle: "bg-anno-surface-med text-anno-text-muted ring-1 ring-anno-line/70",
    dirty: "bg-amber-100 text-amber-900 ring-1 ring-amber-300/70",
    saving: "bg-sky-100 text-sky-900 ring-1 ring-sky-300/70",
    saved: "bg-emerald-100 text-emerald-900 ring-1 ring-emerald-300/70",
    error: "bg-rose-100 text-rose-900 ring-1 ring-rose-300/70",
  };

  const coord = (value: number) => (Number.isFinite(value) ? Number(value.toFixed(2)) : value);
  const selectedSuggestions = selectedFaceId ? (suggestionsByFace[suggestionEntryKey(suggestionScopeKey, selectedFaceId)] ?? []) : [];
  const statusRailItems = [
    { label: "Workspace", value: workspaceContextLabel },
    {
      label: "Save",
      value: page === "editor" ? saveStateMessage : "Waiting for edits",
    },
    {
      label: "Suggestions",
      value: llmSettings?.llmSuggestionsEnabled ? `${readySuggestionCount}/${faces.length || 0} ready` : "Disabled",
    },
    {
      label: "Diagnostics",
      value: hasDiagnosticError ? "Needs attention" : "Healthy",
    },
  ];

  return (
    <>
      <main className="min-h-screen pb-40">
        <WorkspaceTopBar
          currentStep={workspaceStep}
          contextLabel={workspaceContextLabel}
          contextDetail={workspaceContextDetail}
          onOpenSettings={() => setSettingsOpen(true)}
          settingsDisabled={isHomeBusy || isFaceBusy || isExportBusy}
        />

        <div className="mx-auto w-full max-w-[1600px] px-4 py-6 md:px-8">
          {page === "home" ? (
            <section className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_380px]">
              <Card elevated tone="raised">
                <div className="flex flex-col gap-5 border-b border-anno-line/80 pb-5">
                  <SectionHeading
                    title="Start a review workspace"
                    subtitle="Keep the familiar setup flow, but move through it from a single calm intake surface."
                  />
                  <SegmentedControl
                    label="Workspace mode"
                    value={intakeMode}
                    onChange={setIntakeMode}
                    options={[
                      {
                        id: "create",
                        label: "Create dataset",
                        detail: "Import COCO + MP4, check inputs, and generate a review-ready dataset.",
                      },
                      {
                        id: "open",
                        label: "Open existing",
                        detail: "Resume directly from an existing dataset root.",
                      },
                    ]}
                  />
                </div>

                {intakeMode === "create" ? (
                  <div className="mt-6 space-y-5">
                    <Field label="Project directory" hint="Where the workspace metadata and generated assets will be stored.">
                      <div className="flex flex-col gap-2 md:flex-row">
                        <input
                          className={inputClassName}
                          aria-label="Project directory"
                          value={datasetRoot}
                          placeholder="Choose project directory"
                          onChange={(event) => setDatasetRoot(event.target.value)}
                        />
                        <Button variant="outlined" onClick={() => void pickDirectory(setDatasetRoot)} disabled={isHomeBusy}>
                          Browse
                        </Button>
                      </div>
                    </Field>

                    <div className="grid gap-4 md:grid-cols-2">
                      <Field label="COCO JSON" hint="Primary MVP input. Use the source `instances_default.json` file.">
                        <div className="flex flex-col gap-2 md:flex-row">
                          <input
                            className={inputClassName}
                            aria-label="COCO JSON"
                            value={cocoJsonPath}
                            placeholder="Choose COCO annotations (.json)"
                            onChange={(event) => setCocoJsonPath(event.target.value)}
                          />
                          <Button variant="outlined" onClick={() => void pickFile(setCocoJsonPath, [{ name: "JSON", extensions: ["json"] }])} disabled={isHomeBusy}>
                            Browse
                          </Button>
                        </div>
                      </Field>

                      <Field label="Source MP4" hint="Preferred video input for deterministic frame extraction.">
                        <div className="flex flex-col gap-2 md:flex-row">
                          <input
                            className={inputClassName}
                            aria-label="Source MP4"
                            value={mp4Path}
                            placeholder="Choose source video (.mp4)"
                            onChange={(event) => setMp4Path(event.target.value)}
                          />
                          <Button variant="outlined" onClick={() => void pickFile(setMp4Path, [{ name: "MP4", extensions: ["mp4"] }])} disabled={isHomeBusy}>
                            Browse
                          </Button>
                        </div>
                      </Field>
                    </div>

                    <Field label="Source frames directory (auto-managed)" hint="Derived during generation. This remains automatic unless the backend workflow changes.">
                      <input className={inputClassName} aria-label="Source frames directory (auto-managed)" value={sourceFramesDir} readOnly />
                    </Field>

                    {importInputError ? <Alert tone="danger">{importInputError}</Alert> : null}

                    <div className="rounded-[28px] bg-anno-surface-med p-4 ring-1 ring-anno-line/70">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-anno-text-main">Generation progress</p>
                          <p className="mt-1 text-xs text-anno-text-muted">
                            Step: {generationStep} · {generationDetail} · {generationHeartbeat}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button onClick={handleGenerate} disabled={isHomeBusy || !!importInputError}>
                            {isGenerating ? "Generating…" : "Generate review dataset"}
                          </Button>
                          <Button variant="outlined" onClick={() => void handleAbortGeneration()} disabled={!isGenerating || !generationJobId}>
                            Abort
                          </Button>
                        </div>
                      </div>
                      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/80" aria-label="generation progress">
                        <span className="block h-full rounded-full bg-anno-primary transition-all duration-300" style={{ width: `${generationPercent}%` }} />
                      </div>
                      {showGenerationSpinner ? (
                        <div className="mt-3 flex items-center gap-2 text-xs text-anno-text-muted">
                          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-anno-primary border-t-transparent" aria-label="Generation in progress" />
                          Generation is running in the background.
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="mt-6 space-y-5">
                    <Field label="Existing project directory" hint="Resume from a dataset root that already contains the review manifest and generated faces.">
                      <div className="flex flex-col gap-2 md:flex-row">
                        <input
                          className={inputClassName}
                          aria-label="Existing project directory"
                          value={datasetRoot}
                          placeholder="Choose existing project directory"
                          onChange={(event) => setDatasetRoot(event.target.value)}
                        />
                        <Button variant="outlined" onClick={() => void pickDirectory(setDatasetRoot)} disabled={isHomeBusy}>
                          Browse
                        </Button>
                      </div>
                    </Field>

                    {datasetRootError ? <Alert tone="danger">{datasetRootError}</Alert> : null}

                    <div className="rounded-[28px] bg-anno-surface-med p-5 ring-1 ring-anno-line/70">
                      <p className="text-lg font-semibold tracking-[-0.02em] text-anno-text-main">Resume directly into review</p>
                      <p className="mt-2 text-sm text-anno-text-muted">This keeps the current backend open flow intact, while bringing it into the calmer workspace shell.</p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button onClick={handleOpen} disabled={isHomeBusy || !!datasetRootError}>
                          Open dataset
                        </Button>
                        <Button variant="secondary" onClick={() => setDropModalOpen(true)} disabled={isHomeBusy}>
                          Open drop instructions
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </Card>

              <div className="space-y-6">
                <Card tone="soft">
                  <SectionHeading title="Preflight checklist" subtitle="Keep validation explicit before the backend pipeline starts." />
                  <div className="grid gap-3">
                    <StatTile label="Project directory" value={datasetRoot.trim() ? "Ready" : "Needed"} detail={datasetRoot || "Required for both create and open flows."} />
                    <StatTile label="COCO input" value={cocoJsonPath.trim() ? "Ready" : "Needed"} detail={cocoJsonPath || "Required when creating a new dataset."} />
                    <StatTile label="MP4 input" value={mp4Path.trim() ? "Ready" : "Needed"} detail={mp4Path || "Required when creating a new dataset."} />
                    <StatTile label="Suggestion profile" value={llmSettings?.llmSuggestionsEnabled ? "Enabled" : "Manual"} detail={llmSettings?.llmSuggestionsEnabled ? "Suggestions will warm up before editor entry when possible." : "Pure manual editing mode."} />
                  </div>
                </Card>

                <Card tone="soft">
                  <SectionHeading title="Workspace notes" subtitle="A small side panel for context, not a second workflow." />
                  <div className="space-y-4">
                    <Alert tone="info">
                      Drag-and-drop still works anywhere in the window for dataset directories, COCO JSON, and MP4 files.
                    </Alert>
                    <div className="rounded-[24px] border border-dashed border-anno-line bg-white/65 px-4 py-5">
                      <p className="text-sm font-semibold text-anno-text-main">Drop zone</p>
                      <p className="mt-2 text-sm text-anno-text-muted">Use this when a teammate hands you a folder or loose input files and you want the app to stage them quickly.</p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button variant="outlined" onClick={() => setDropModalOpen(true)}>
                          Show drop instructions
                        </Button>
                        <Button variant="quiet" onClick={() => setSettingsOpen(true)}>
                          Adjust studio settings
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>
              </div>
            </section>
          ) : null}

          {page === "editor" ? (
            <section className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)_360px]">
              <Card tone="soft" className="studio-scrollbar max-h-[calc(100vh-250px)] overflow-auto">
                <SectionHeading title="Face queue" subtitle="Search, skim progress, and move through the review line without losing context." />
                <Field label="Search faces" hint="Filter by face id or cube face label.">
                  <input
                    className={inputClassName}
                    aria-label="Search faces"
                    value={faceSearchQuery}
                    placeholder="Search face id or face label"
                    onChange={(event) => setFaceSearchQuery(event.target.value)}
                  />
                </Field>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1">
                  <StatTile label="Faces" value={faces.length} detail={`${Math.round(progress)}% through the queue`} />
                  <StatTile label="Suggestions ready" value={readySuggestionCount} detail={llmSettings?.llmSuggestionsEnabled ? "Cached suggestion sets available." : "Suggestions disabled."} />
                </div>

                <div className="studio-scrollbar mt-5 space-y-2 overflow-auto pr-1">
                  {filteredFaces.length === 0 ? (
                    <EmptyState title="No matching faces" description="Adjust the search term to see the review queue again." />
                  ) : (
                    filteredFaces.map((face, index) => {
                      const active = face.faceId === selectedFaceId;
                      const suggestionPill = getSuggestionPillForFace(face.faceId);
                      return (
                        <button
                          key={face.faceId}
                          type="button"
                          className={`w-full rounded-[24px] px-4 py-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-anno-primary ${
                            active
                              ? "bg-white shadow-md shadow-stone-200/60 ring-2 ring-anno-primary/25"
                              : "bg-anno-surface-med ring-1 ring-anno-line/70 hover:bg-white/80"
                          }`}
                          onClick={() => void navigateToFace(face.faceId)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-anno-text-subtle">
                                {String(index + 1).padStart(2, "0")} · {face.face}
                              </p>
                              <p className="mt-1 text-base font-semibold tracking-[-0.02em] text-anno-text-main">{face.faceId}</p>
                              <p className="mt-1 text-xs text-anno-text-muted">Seed boxes: {face.initialBoxCount}</p>
                            </div>
                            <Pill tone={suggestionPill.tone}>{suggestionPill.label}</Pill>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </Card>

              <div className="space-y-5">
                <Card elevated tone="raised">
                  <div className="flex flex-col gap-4 border-b border-anno-line/80 pb-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill tone="accent">Review stage</Pill>
                        <Pill tone="neutral">{selectedFace?.face ?? "No face selected"}</Pill>
                      </div>
                      <h2 className="mt-3 text-[2rem] font-semibold tracking-[-0.04em] text-anno-text-main">
                        {selectedFace ? `Editing ${selectedFace.faceId}` : "Select a face to begin"}
                      </h2>
                      <p className="mt-2 text-sm text-anno-text-muted">
                        Progress {Math.max(0, selectedIndex + 1)}/{faces.length} ({Math.round(progress)}%)
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-3 py-2 text-xs font-semibold ${saveStateClassName[saveState]}`}>
                        {saveStateMessage}
                        {lastSavedAt ? ` · ${lastSavedAt}` : ""}
                      </span>
                      <Button variant="secondary" onClick={handleSave} disabled={isFaceBusy || isEditorBusy || !selectedFaceId}>
                        Save now
                      </Button>
                      <Button onClick={() => setPage("export")} disabled={isFaceBusy || isEditorBusy || !selectedFaceId}>
                        Finish and export
                      </Button>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      variant="outlined"
                      onClick={() => void navigateToFace(faces[Math.max(selectedIndex - 1, 0)]?.faceId ?? "")}
                      disabled={isFaceBusy || isEditorBusy || selectedIndex <= 0}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outlined"
                      onClick={() => void navigateToFace(faces[Math.min(selectedIndex + 1, faces.length - 1)]?.faceId ?? "")}
                      disabled={isFaceBusy || isEditorBusy || selectedIndex < 0 || selectedIndex >= faces.length - 1}
                    >
                      Next
                    </Button>
                    <Button variant="quiet" onClick={() => void goHome()} disabled={isFaceBusy || isEditorBusy}>
                      Return home
                    </Button>
                  </div>
                </Card>

                {warmupTimedOut ? (
                  <Alert tone="warning" title="Suggestions are still warming up.">
                    <p>{queueSummaryText(warmupQueueSummary)}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="outlined" onClick={() => void retryWarmupForCurrentBuffer()}>
                        Retry warmup
                      </Button>
                      <Button variant="quiet" onClick={() => setWarmupTimedOut(false)}>
                        Continue immediately
                      </Button>
                    </div>
                  </Alert>
                ) : null}

                <Card tone="dark" className="overflow-hidden">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-600/70 px-5 py-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Canvas stage</p>
                      <p className="mt-1 text-base font-semibold tracking-[-0.02em] text-anno-text-inverse">Dark review focus for image checks and box placement</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Pill tone="dark">Editable boxes: {edits.length}</Pill>
                      <Pill tone="dark">Suggestions: {selectedSuggestions.length}</Pill>
                    </div>
                  </div>

                  <div className="relative bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_28%),linear-gradient(180deg,#1f262d_0%,#151a20_100%)] p-5">
                    {selectedFace ? (
                      <div className="relative rounded-[30px] border border-slate-600/70 bg-[#151a20] p-4 shadow-2xl shadow-slate-950/25">
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
                            setPreviewError(
                              `Failed to load face preview for ${selectedFace.faceId} from ${selectedFaceImagePath}. Resolved src: ${imageSrc}. Dataset root: ${
                                datasetRoot || "(empty)"
                              }.`
                            );
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
                      </div>
                    ) : (
                      <EmptyState
                        title="No face selected"
                        description="Open a dataset and choose a face from the left rail to begin reviewing boxes."
                      />
                    )}
                  </div>
                  {previewError ? <p className="border-t border-slate-600/70 px-5 py-4 text-sm text-rose-200">{previewError}</p> : null}
                </Card>
              </div>

              <Card tone="soft" className="studio-scrollbar max-h-[calc(100vh-250px)] overflow-auto">
                <div className="flex flex-col gap-4 border-b border-anno-line/80 pb-4">
                  <SectionHeading title="Inspector" subtitle="Keep annotations, suggestions, and guidance close without crowding the image stage." />
                  <SectionTabs
                    tabs={[
                      { id: "annotations", label: "Annotations", detail: String(edits.length) },
                      { id: "suggestions", label: "Suggestions", detail: String(selectedSuggestions.length) },
                      { id: "help", label: "Help" },
                    ]}
                    value={inspectorTab}
                    onChange={setInspectorTab}
                  />
                </div>

                {inspectorTab === "annotations" ? (
                  <div className="mt-5 space-y-4">
                    <div className="grid gap-3 md:grid-cols-2">
                      <StatTile label="Editable boxes" value={edits.length} detail="Confirmed annotations for the active face." />
                      <StatTile label="Seed boxes" value={selectedFace?.initialBoxCount ?? 0} detail="Original incoming boxes from the dataset." />
                    </div>

                    {editValidationError ? <Alert tone="danger">Invalid edits: {editValidationError}</Alert> : null}

                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" onClick={handleAddBox} disabled={isFaceBusy || isEditorBusy || !selectedFaceId}>
                        Add box
                      </Button>
                      <Button variant="outlined" onClick={handleDeleteActiveBox} disabled={isFaceBusy || isEditorBusy || !selectedFaceId || activeBoxIndex === null}>
                        Delete active box
                      </Button>
                    </div>

                    <div className="studio-scrollbar max-h-[48vh] space-y-3 overflow-auto pr-1">
                      {edits.length === 0 ? (
                        <EmptyState title="No editable boxes yet" description="Draw on the canvas or add a box from the controls above." />
                      ) : (
                        edits.map((edit, index) => (
                          <div
                            className={`bbox-editor rounded-[24px] px-4 py-4 transition ${
                              activeBoxIndex === index ? "bg-white shadow-md shadow-stone-200/60 ring-2 ring-anno-primary/25" : "bg-anno-surface-med ring-1 ring-anno-line/70"
                            }`}
                            key={`${selectedFaceId}-${index}`}
                            onMouseEnter={() => setActiveBoxIndex(index)}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold text-anno-text-main">Box {index + 1}</p>
                                <p className="mt-1 text-xs text-anno-text-muted">{edit.bbox.map(coord).join(", ")}</p>
                              </div>
                              <Pill tone={activeBoxIndex === index ? "success" : "neutral"}>
                                {activeBoxIndex === index ? "Active" : "Available"}
                              </Pill>
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-2">
                              {(["x", "y", "w", "h"] as const).map((axis, axisIndex) => (
                                <label key={axis} className="text-xs font-medium uppercase tracking-[0.08em] text-anno-text-subtle">
                                  {axis}
                                  <input
                                    className={`${inputClassName} mt-1`}
                                    aria-label={axis}
                                    value={edit.bbox[axisIndex]}
                                    onChange={(event) => handleEditChange(index, axisIndex, event.target.value)}
                                  />
                                </label>
                              ))}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}

                {inspectorTab === "suggestions" ? (
                  <div className="mt-5 space-y-4">
                    <div className="grid gap-3 md:grid-cols-2">
                      <StatTile label="Suggestions ready" value={selectedSuggestions.length} detail="Current cached suggestions for the active face." />
                      <StatTile label="Warmup queue" value={queueSummaryText(warmupQueueSummary)} detail="Background readiness summary for the suggestion buffer." />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" onClick={applyAllSuggestionsToEdits} disabled={isFaceBusy || isEditorBusy || !selectedFaceId || selectedSuggestions.length === 0}>
                        Apply all suggestions
                      </Button>
                      <Button variant="outlined" onClick={replaceEditsWithSuggestions} disabled={isFaceBusy || isEditorBusy || !selectedFaceId || selectedSuggestions.length === 0}>
                        Replace edits with suggestions
                      </Button>
                    </div>

                    <div className="studio-scrollbar max-h-[48vh] space-y-3 overflow-auto pr-1">
                      {selectedSuggestions.length === 0 ? (
                        <EmptyState
                          title="No suggestions ready"
                          description={llmSettings?.llmSuggestionsEnabled ? "Suggestions are still queueing or warming up for this face." : "Suggestions are disabled in studio settings."}
                        />
                      ) : (
                        selectedSuggestions.map((suggestion, index) => (
                          <div
                            key={`suggestion-${selectedFaceId}-${index}`}
                            className={`rounded-[24px] px-4 py-4 ring-1 transition ${
                              selectedSuggestionIndex === index ? "bg-white ring-anno-primary/30 shadow-md shadow-stone-200/60" : "bg-anno-surface-med ring-anno-line/70"
                            }`}
                            onMouseEnter={() => setSelectedSuggestionIndex(index)}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold text-anno-text-main">Suggestion {index + 1}</p>
                                <p className="mt-1 text-xs text-anno-text-muted">{suggestion.bbox.map(coord).join(", ")}</p>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Pill tone="info">{suggestion.source}</Pill>
                                {typeof suggestion.confidence === "number" ? <Pill tone="accent">conf {coord(suggestion.confidence)}</Pill> : null}
                              </div>
                            </div>
                            <div className="mt-4 flex flex-wrap gap-2">
                              <Button variant="quiet" onClick={() => addSuggestionToEdits(suggestion)} disabled={isFaceBusy || isEditorBusy}>
                                Add suggestion as new box
                              </Button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}

                {inspectorTab === "help" ? (
                  <div className="mt-5 space-y-4">
                    <Alert tone="info" title="Editing guide">
                      <ul className="list-disc space-y-1 pl-5 text-sm">
                        <li>Click and drag to draw a box.</li>
                        <li>Drag the center to move the active box.</li>
                        <li>Drag corners or edges to resize from any handle.</li>
                        <li>Use Delete or Backspace to remove the active box.</li>
                        <li>Use Left and Right arrow keys, or the Previous and Next buttons, to move between faces.</li>
                      </ul>
                    </Alert>

                    <Card tone="inset">
                      <p className="text-lg font-semibold tracking-[-0.02em] text-anno-text-main">Review notes</p>
                      <div className="mt-3 space-y-2 text-sm text-anno-text-muted">
                        <p>Autosave runs after valid edits settle, but the Save button remains available whenever you want an explicit checkpoint.</p>
                        <p>Diagnostics stay visible through the bottom rail, and the full console can be expanded without leaving the editor.</p>
                        <p>Suggestion warmup tries to front-load likely next faces so mixed operators can keep momentum once they enter the review stage.</p>
                      </div>
                    </Card>
                  </div>
                ) : null}
              </Card>
            </section>
          ) : null}

          {page === "export" ? (
            <section className="mx-auto max-w-[980px]">
              <Card elevated tone="raised">
                <SectionHeading
                  title="Export final annotations"
                  subtitle="Confirm the destination, review the current session summary, and write deterministic COCO output."
                />

                <div className="grid gap-4 md:grid-cols-3">
                  <StatTile label="Faces in workspace" value={faces.length} detail="Loaded from the current dataset manifest." />
                  <StatTile label="Seed boxes" value={totalInitialBoxCount} detail="Incoming boxes before review changes." />
                  <StatTile label="Current face edits" value={edits.length} detail={selectedFace ? `Active face: ${selectedFace.faceId}` : "No active face selected."} />
                </div>

                <div className="mt-6 rounded-[28px] bg-anno-surface-med p-5 ring-1 ring-anno-line/70">
                  <Field label="Export destination" hint="Choose the JSON file path for the final COCO export.">
                    <div className="flex flex-col gap-2 md:flex-row">
                      <input
                        className={inputClassName}
                        aria-label="Export destination"
                        value={outputPath}
                        placeholder="Select export .json output"
                        onChange={(event) => setOutputPath(event.target.value)}
                      />
                      <Button variant="outlined" onClick={() => void pickSaveFile()} disabled={isExportBusy}>
                        Browse
                      </Button>
                    </div>
                  </Field>

                  {outputPathError ? <Alert tone="danger">{outputPathError}</Alert> : null}

                  <div className="mt-5 flex flex-wrap gap-2">
                    <Button onClick={handleExport} disabled={isExportBusy}>
                      Export COCO
                    </Button>
                    <Button variant="outlined" onClick={() => setPage("editor")} disabled={isExportBusy}>
                      Continue editing
                    </Button>
                    <Button variant="quiet" onClick={() => void goHome()} disabled={isExportBusy}>
                      Return home
                    </Button>
                  </div>
                </div>
              </Card>
            </section>
          ) : null}
        </div>
      </main>

      <DiagnosticsDrawer
        open={diagnosticsOpen}
        diagnosticsText={diagnosticsText}
        hasError={hasDiagnosticError}
        onCopy={() => void copyDiagnostics()}
        onClear={() => setDiagnosticsLog((prev) => prev.slice(-1))}
      />

      <WorkspaceStatusRail
        diagnosticsOpen={diagnosticsOpen}
        onToggleDiagnostics={() =>
          setDiagnosticsPanelState((current) => (current === "expanded" ? "collapsed" : "expanded"))
        }
        items={statusRailItems}
      />

      {noticeMessage ? (
        <div className={modalOverlayClassName} role="alertdialog" aria-modal="true" aria-label="Generation notice">
          <div className="w-full max-w-xl rounded-[30px] bg-[#f5efe6] p-6 ring-1 ring-anno-line/80 shadow-2xl shadow-stone-900/20">
            <h3 className="text-2xl font-semibold tracking-[-0.03em] text-anno-text-main">Generation notice</h3>
            <p className="mt-2 text-sm text-anno-text-muted">Generation could not continue. See diagnostics for the full backend detail.</p>
            <pre className="studio-scrollbar mt-4 max-h-44 overflow-auto rounded-[22px] bg-anno-surface-med p-4 text-xs text-anno-text-muted">{noticeMessage}</pre>
            <div className="mt-4 flex gap-2">
              <Button
                variant="outlined"
                onClick={() => {
                  setNoticeMessage("");
                  if (hasDiagnosticError) {
                    clearDiagnostics("Ready.");
                  }
                }}
              >
                Dismiss
              </Button>
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
          <div className="w-full max-w-xl rounded-[30px] bg-[#f5efe6] p-6 ring-1 ring-anno-line/80 shadow-2xl shadow-stone-900/20">
            <h3 className="text-2xl font-semibold tracking-[-0.03em] text-anno-text-main">Preparing suggestions</h3>
            <p className="mt-2 text-sm text-anno-text-muted">Building an initial suggestion buffer before the review workspace opens.</p>
            <div className="mt-4 space-y-2 rounded-[22px] bg-anno-surface-med p-4 ring-1 ring-anno-line/70">
              <p className="text-sm text-anno-text-main">{editorWarmupMessage || "Preparing suggestions..."}</p>
              <p className="text-xs text-anno-text-muted">
                Targets: {editorWarmupFaceIds.length} · Required threshold ready:{" "}
                {Math.max(1, Math.ceil(editorWarmupFaceIds.length * (llmSettings?.editorWarmupThresholdRatio ?? EDITOR_WARMUP_THRESHOLD_RATIO)))} · Ready now: {editorWarmupReadyCount}
              </p>
              <p className="text-xs text-anno-text-muted">Queue status: {queueSummaryText(warmupQueueSummary)}</p>
            </div>
            <div className="mt-4 flex gap-2">
              <Button variant="outlined" onClick={() => void retryWarmupForCurrentBuffer()} disabled={isEnteringEditor}>
                Retry warmup
              </Button>
              <Button variant="secondary" onClick={() => setSkipWarmupRequested(true)}>
                Continue immediately
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {dropModalOpen ? (
        <div className={modalOverlayClassName} role="dialog" aria-modal="true" aria-label="Drop input files">
          <div className="w-full max-w-lg rounded-[30px] bg-[#f5efe6] p-6 ring-1 ring-anno-line/80 shadow-2xl shadow-stone-900/20">
            <h3 className="text-2xl font-semibold tracking-[-0.03em] text-anno-text-main">Drop input files</h3>
            <p className="mt-2 text-sm text-anno-text-muted">Drop a dataset directory, COCO JSON file, or MP4 anywhere on this window and the app will stage recognized inputs.</p>
            <div className="mt-4 rounded-[22px] bg-anno-surface-med p-4 ring-1 ring-anno-line/70">
              <p className="text-sm font-semibold text-anno-text-main">Supported drop targets</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-anno-text-muted">
                <li>Dataset roots containing annotations and generated face data</li>
                <li>COCO `instances_default.json` files</li>
                <li>Source `.mp4` videos for review dataset generation</li>
              </ul>
            </div>
            <div className="mt-4 flex gap-2">
              <Button variant="outlined" onClick={() => setDropModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
