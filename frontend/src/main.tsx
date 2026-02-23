import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  exportCoco,
  generateReviewDataset,
  getAnnotations,
  listFaces,
  openDataset,
  runImportStage,
  setAnnotations,
  checkRuntimeDependencies,
  stageDroppedInputs,
} from "./api";
import type { AnnotationEdit, FaceListItem } from "./types";
import "./styles.css";
import { removeEditAtIndex, validateEdits } from "./editing";

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
type GenerationStep = "idle" | "validating" | "dependencies" | "extracting" | "generating" | "done";
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

  useEffect(() => {
    editsRef.current = edits;
  }, [edits]);

  useEffect(() => {
    selectedFaceIdRef.current = selectedFaceId;
  }, [selectedFaceId]);

  const [isBusy, setIsBusy] = useState(false);
  const [status, setStatus] = useState("Ready.");
  const [error, setError] = useState("");
  const [generationStep, setGenerationStep] = useState<GenerationStep>("idle");
  const [generationPercent, setGenerationPercent] = useState(0);
  const [generationDetail, setGenerationDetail] = useState("Idle.");
  const [generationHeartbeat, setGenerationHeartbeat] = useState("Idle");

  const selectedIndex = useMemo(
    () => faces.findIndex((face) => face.faceId === selectedFaceId),
    [faces, selectedFaceId]
  );
  const selectedFace = selectedIndex < 0 ? undefined : faces[selectedIndex];
  const selectedFaceImagePath = selectedFace ? resolveFaceImagePath(datasetRoot, selectedFace.imagePath) : "";
  const imageSrc = selectedFace ? convertFileSrc(selectedFaceImagePath) : "";

  const progress = faces.length === 0 ? 0 : ((selectedIndex + 1) / faces.length) * 100;

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
        defaultPath: outputPath || "exported_instances.json",
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
            : (["idle", "validating", "dependencies", "extracting", "generating", "done"].includes(phase)
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

    setIsBusy(true);
    try {
      const { openReport } = await refreshFaces();
      setPage("editor");
      updateDiagnostics(`Dataset opened\nmanifest: ${openReport.manifestPath}\nfaces: ${openReport.faceCount}`);
    } catch (cause) {
      updateDiagnostics("Open dataset failed", String(cause));
    } finally {
      setIsBusy(false);
    }
  };

  const handleImport = async () => {
    if (importInputError) {
      updateDiagnostics("Import validation blocked", importInputError);
      return;
    }

    setIsBusy(true);
    try {
      const report = await runImportStage({ datasetRoot, cocoJsonPath, mp4Path });
      updateDiagnostics(
        `Import validation complete\nimages=${report.imageCount}, annotations=${report.annotationCount}, categories=${report.categoryCount}, referenced=${report.referencedImageCount}`
      );
    } catch (cause) {
      updateDiagnostics("Import validation failed", String(cause));
    } finally {
      setIsBusy(false);
    }
  };

  const handleGenerate = async () => {
    if (importInputError) {
      updateDiagnostics("Review dataset generation blocked", importInputError);
      return;
    }

    setIsBusy(true);
    setGenerationStep("validating");
    setGenerationPercent(0);
    setGenerationDetail("Starting generation pipeline...");
    setGenerationHeartbeat("Live");

    try {
      const runtimeReport = await ensureRuntimeDependencies();
      const report = await generateReviewDataset({
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
      updateDiagnostics("Review dataset generation failed", String(cause));
    } finally {
      setIsBusy(false);
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
    setIsBusy(true);
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
      setIsBusy(false);
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
        context.fillRect((x + w) * scaleX - 4, (y + h) * scaleY - 4, 8, 8);
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

    const snapshot = JSON.stringify(edits);
    const baseline = lastSavedSnapshotRef.current[selectedFaceId] ?? "";
    if (snapshot === baseline) {
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
  }, [edits, selectedFaceId, isFaceLoading, commitSave]);

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

        return {
          ...entry,
          bbox,
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
          dragState.current = { mode: "idle", index: null, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
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
      if (isBusy || faces.length === 0 || page !== "editor") {
        return;
      }

      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        const next = Math.min(selectedIndex + 1, faces.length - 1);
        void navigateToFace(faces[next].faceId);
      }

      if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        const next = Math.max(selectedIndex - 1, 0);
        void navigateToFace(faces[next].faceId);
      }

      const target = event.target as HTMLElement | null;
      const isTypingTarget = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (!isTypingTarget && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        handleDeleteActiveBox();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isBusy, faces, selectedIndex, handleDeleteActiveBox, page]);

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
    if (!pointer || isBusy) {
      return;
    }

    const handleRadius = 8;
    let mode: PointerMode = "draw";
    let targetIndex: number | null = null;
    let offsetX = 0;
    let offsetY = 0;

    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const [x, y, w, h] = edits[index].bbox;
      const inHandle = Math.abs(pointer.x - (x + w)) <= handleRadius && Math.abs(pointer.y - (y + h)) <= handleRadius;
      if (inHandle) {
        mode = "resize";
        targetIndex = index;
        break;
      }

      const inBox = pointer.x >= x && pointer.x <= x + w && pointer.y >= y && pointer.y <= y + h;
      if (inBox) {
        mode = "move";
        targetIndex = index;
        offsetX = pointer.x - x;
        offsetY = pointer.y - y;
        break;
      }
    }

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
      startX: pointer.x,
      startY: pointer.y,
      offsetX,
      offsetY,
    };
    setActiveBoxIndex(targetIndex);
    setEditValidationError("");
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pointer = getPointerInImageSpace(event);
    const state = dragState.current;
    if (!pointer || state.mode === "idle" || state.index === null) {
      return;
    }

    const box = edits[state.index];
    if (!box) {
      return;
    }

    const [x, y, w, h] = box.bbox;
    if (state.mode === "move") {
      updateBoxFromPointer(state.index, [Math.max(0, pointer.x - state.offsetX), Math.max(0, pointer.y - state.offsetY), w, h]);
      return;
    }

    if (state.mode === "resize") {
      updateBoxFromPointer(state.index, [x, y, Math.max(0, pointer.x - x), Math.max(0, pointer.y - y)]);
      return;
    }

    updateBoxFromPointer(state.index, [
      Math.min(state.startX, pointer.x),
      Math.min(state.startY, pointer.y),
      Math.max(0, Math.abs(pointer.x - state.startX)),
      Math.max(0, Math.abs(pointer.y - state.startY)),
    ]);
  };

  const handleCanvasPointerUp = () => {
    dragState.current = { mode: "idle", index: null, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
  };

  const handleSave = async () => {
    await commitSave("manual");
  };

  const handleExport = async () => {
    if (exportInputError) {
      updateDiagnostics("Export blocked", exportInputError);
      return;
    }

    setIsBusy(true);
    try {
      const report = await exportCoco({ datasetRoot, outputPath });
      updateDiagnostics(`Export finished\noutput: ${report.outputPath}\nimages=${report.imageCount}\nannotations=${report.annotationCount}`);
    } catch (cause) {
      updateDiagnostics("Export failed", String(cause));
    } finally {
      setIsBusy(false);
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

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>bdr-anno-review</h1>
        <p className="hint">Workflow: Home → Annotate → Export</p>
      </header>

      {page === "home" ? (
        <section className="home-layout">
          <div className="card">
            <h2>Create new dataset</h2>
            <p className="hint">Upload COCO + MP4 and generate a review dataset.</p>
            <div className="row">
              <label>Dataset root</label>
              <input
                aria-label="Dataset root"
                value={datasetRoot}
                placeholder="Select dataset directory"
                onChange={(event) => setDatasetRoot(event.target.value)}
              />
              <button onClick={() => void pickDirectory(setDatasetRoot)} disabled={isBusy}>Browse</button>
            </div>
            <div className="row">
              <label>COCO JSON</label>
              <input
                aria-label="COCO JSON"
                value={cocoJsonPath}
                placeholder="Select instances_default.json"
                onChange={(event) => setCocoJsonPath(event.target.value)}
              />
              <button onClick={() => void pickFile(setCocoJsonPath, [{ name: "JSON", extensions: ["json"] }])} disabled={isBusy}>Browse</button>
            </div>
            <div className="row">
              <label>Source MP4</label>
              <input
                aria-label="Source MP4"
                value={mp4Path}
                placeholder="Select source .mp4"
                onChange={(event) => setMp4Path(event.target.value)}
              />
              <button onClick={() => void pickFile(setMp4Path, [{ name: "MP4", extensions: ["mp4"] }])} disabled={isBusy}>Browse</button>
            </div>
            <div className="row">
              <label>Source frames directory (auto-managed)</label>
              <input aria-label="Source frames directory (auto-managed)" value={sourceFramesDir} readOnly />
            </div>
            <p className="hint">Manual overrides are disabled in MVP to keep runtime behavior deterministic.</p>
            {(datasetRootError || cocoPathError || mp4PathError) ? (
              <p className="error">{datasetRootError || cocoPathError || mp4PathError}</p>
            ) : null}

            <div className="row">
              <button onClick={handleGenerate} disabled={isBusy}>Generate review dataset</button>
              <button onClick={handleImport} disabled={isBusy}>Validate inputs only</button>
            </div>

            <div className="progress" aria-label="generation progress">
              <span style={{ width: `${generationPercent}%` }} />
            </div>
            <p className="hint">Step: {generationStep} • {generationDetail} • {generationHeartbeat}</p>
          </div>

          <div className="card">
            <h2>Resume existing dataset</h2>
            <p className="hint">Open a dataset with an existing review manifest and continue editing.</p>
            <div className="row">
              <input
                aria-label="Resume dataset directory"
                value={datasetRoot}
                placeholder="Select dataset directory"
                onChange={(event) => setDatasetRoot(event.target.value)}
              />
              <button onClick={() => void pickDirectory(setDatasetRoot)} disabled={isBusy}>Browse</button>
            </div>
            <div className="row">
              <button onClick={handleOpen} disabled={isBusy}>Open dataset</button>
              <button onClick={() => setDropModalOpen(true)} disabled={isBusy}>Drop input</button>
            </div>
            {datasetRootError ? <p className="error">{datasetRootError}</p> : null}
          </div>

          <div className="card">
            <h3>Diagnostics</h3>
            {error ? <p className="error">Error: {error}</p> : null}
            <pre className="status">{status}</pre>
          </div>
        </section>
      ) : null}

      {page === "editor" ? (
        <section className="editor-layout">
          <div className="card editor-toolbar">
            <div className="row spread">
              <div>
                <strong>Editing: {selectedFaceId || "(none)"}</strong>
                <p className="hint">Progress {Math.max(0, selectedIndex + 1)}/{faces.length} ({Math.round(progress)}%)</p>
              </div>
              <div className="row compact">
                <span className={`save-pill ${saveState}`}>{saveStateMessage}{lastSavedAt ? ` (${lastSavedAt})` : ""}</span>
                <button onClick={handleSave} disabled={isBusy || !selectedFaceId}>Save now</button>
                <button onClick={() => setPage("export")} disabled={isBusy || !selectedFaceId}>Finish & export</button>
              </div>
            </div>
            <div className="progress" aria-label="review progress">
              <span style={{ width: `${progress}%` }} />
            </div>
            <div className="row compact">
              <button onClick={() => void navigateToFace(faces[Math.max(selectedIndex - 1, 0)]?.faceId ?? "")} disabled={isBusy || selectedIndex <= 0}>Previous</button>
              <button onClick={() => void navigateToFace(faces[Math.min(selectedIndex + 1, faces.length - 1)]?.faceId ?? "")} disabled={isBusy || selectedIndex < 0 || selectedIndex >= faces.length - 1}>Next</button>
              <button onClick={() => void goHome()} disabled={isBusy}>Return home</button>
            </div>
          </div>

          <div className="card tutorial-card">
            <button className="link-button" onClick={toggleTutorial} aria-expanded={!tutorialCollapsed}>
              {tutorialCollapsed ? "Show quick tutorial" : "Hide quick tutorial"}
            </button>
            {!tutorialCollapsed ? (
              <ul className="hint">
                <li>Draw a box by dragging on the image.</li>
                <li>Drag inside a box to move it. Drag bottom-right corner to resize.</li>
                <li>Use Delete/Backspace to remove the active box.</li>
                <li>Use ↑/↓ or j/k to move between faces.</li>
                <li>Autosave runs after edits; use Save now for immediate persistence.</li>
              </ul>
            ) : null}
          </div>

          <div className="card canvas-card">
            <div className="preview-shell preview-large">
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
                    onPointerDown={handleCanvasPointerDown}
                    onPointerMove={handleCanvasPointerMove}
                    onPointerUp={handleCanvasPointerUp}
                    onPointerLeave={handleCanvasPointerUp}
                  />
                </>
              ) : (
                <p className="empty-preview">Open a dataset and select a face to start reviewing.</p>
              )}
            </div>
            {previewError ? <p className="error">{previewError}</p> : null}
          </div>

          <div className="card">
            <h3>Bounding boxes</h3>
            {edits.map((edit, index) => (
              <div className={`row ${activeBoxIndex === index ? "active-row" : ""}`} key={`${selectedFaceId}-${index}`} onMouseEnter={() => setActiveBoxIndex(index)}>
                {(["x", "y", "w", "h"] as const).map((axis, axisIndex) => (
                  <label key={axis}>
                    {axis}
                    <input value={edit.bbox[axisIndex]} onChange={(event) => handleEditChange(index, axisIndex, event.target.value)} />
                  </label>
                ))}
              </div>
            ))}
            {editValidationError ? <p className="error">Invalid edits: {editValidationError}</p> : null}
            <div className="row">
              <button onClick={handleAddBox} disabled={isBusy || !selectedFaceId}>Add box</button>
              <button onClick={handleDeleteActiveBox} disabled={isBusy || !selectedFaceId || activeBoxIndex === null}>Delete active box</button>
            </div>
          </div>
        </section>
      ) : null}

      {page === "export" ? (
        <section className="export-layout">
          <div className="card">
            <h2>Export final annotations</h2>
            <p className="hint">Export reviewed annotations to COCO JSON.</p>
            <div className="row">
              <input value={outputPath} placeholder="Select export .json output" onChange={(event) => setOutputPath(event.target.value)} />
              <button onClick={() => void pickSaveFile()} disabled={isBusy}>Browse</button>
            </div>
            {outputPathError ? <p className="error">{outputPathError}</p> : null}
            <div className="row">
              <button onClick={handleExport} disabled={isBusy}>Export COCO</button>
            </div>
            <div className="row">
              <button onClick={() => setPage("editor")} disabled={isBusy}>Continue editing</button>
              <button onClick={() => void goHome()} disabled={isBusy}>Return home</button>
            </div>
          </div>

          <div className="card">
            <h3>Diagnostics</h3>
            {error ? <p className="error">Error: {error}</p> : null}
            <pre className="status">{status}</pre>
          </div>
        </section>
      ) : null}

      {dropModalOpen ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Drop input files">
          <div className="modal-card">
            <h3>Drop input files</h3>
            <p className="hint">Drop dataset directory, COCO JSON, and MP4 anywhere on this window.</p>
            <div className="row">
              <button onClick={() => setDropModalOpen(false)}>Close</button>
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
