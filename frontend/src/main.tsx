import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  extractFramesFromMp4,
  exportCoco,
  generateReviewDataset,
  getAnnotations,
  listFaces,
  openDataset,
  runImportStage,
  setAnnotations,
  checkRuntimeDependencies,
} from "./api";
import type { AnnotationEdit, FaceListItem } from "./types";
import "./styles.css";
import { removeEditAtIndex, validateEdits } from "./editing";

const nowIso = () => new Date().toISOString();

type ImageViewport = {
  naturalWidth: number;
  naturalHeight: number;
  displayWidth: number;
  displayHeight: number;
};

type PointerMode = "idle" | "draw" | "move" | "resize";
type GenerationStep = "idle" | "validating" | "dependencies" | "extracting" | "generating" | "done";

const resolveFaceImagePath = (datasetRoot: string, imagePath: string) => {
  const normalizedPath = imagePath.replace(/\\/g, "/");
  if (normalizedPath.startsWith("/") || /^[A-Za-z]:\//.test(normalizedPath)) {
    return normalizedPath;
  }
  return `${datasetRoot.replace(/\/$/, "")}/${normalizedPath}`;
};


export function App() {
  const [datasetRoot, setDatasetRoot] = useState("");
  const [cocoJsonPath, setCocoJsonPath] = useState("");
  const [mp4Path, setMp4Path] = useState("");
  const [sourceFramesDir, setSourceFramesDir] = useState("(auto-managed after extraction)");
  const [outputPath, setOutputPath] = useState("");

  const [faces, setFaces] = useState<FaceListItem[]>([]);
  const [selectedFaceId, setSelectedFaceId] = useState<string>("");
  const [edits, setEdits] = useState<AnnotationEdit[]>([]);
  const [activeBoxIndex, setActiveBoxIndex] = useState<number | null>(null);
  const [editValidationError, setEditValidationError] = useState("");
  const [imageViewport, setImageViewport] = useState<ImageViewport | null>(null);

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

  const [isBusy, setIsBusy] = useState(false);
  const [status, setStatus] = useState("Ready.");
  const [error, setError] = useState("");
  const [generationStep, setGenerationStep] = useState<GenerationStep>("idle");
  const [generationPercent, setGenerationPercent] = useState(0);
  const [generationDetail, setGenerationDetail] = useState("Idle.");

  const selectedIndex = useMemo(
    () => faces.findIndex((face) => face.faceId === selectedFaceId),
    [faces, selectedFaceId]
  );
  const selectedFace = selectedIndex < 0 ? undefined : faces[selectedIndex];
  const imageSrc = selectedFace
    ? convertFileSrc(resolveFaceImagePath(datasetRoot, selectedFace.imagePath))
    : "";

  const progress = faces.length === 0 ? 0 : ((selectedIndex + 1) / faces.length) * 100;


  const datasetRootError = datasetRoot.trim() ? "" : "Dataset root is required.";
  const cocoPathError = cocoJsonPath.trim() ? "" : "COCO JSON path is required.";
  const mp4PathError = mp4Path.trim()
    ? mp4Path.toLowerCase().endsWith(".mp4")
      ? ""
      : "MP4 path must end with .mp4"
    : "MP4 path is required.";
  const outputPathError = outputPath.trim()
    ? outputPath.toLowerCase().endsWith(".json")
      ? ""
      : "Export path must end with .json"
    : "Export output path is required.";

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

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const attach = async () => {
      unlisten = await getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") {
          return;
        }

        const [firstPath] = event.payload.paths;
        if (!firstPath) {
          return;
        }

        const normalized = firstPath.replace(/\\/g, "/");
        if (normalized.toLowerCase().endsWith(".json")) {
          setCocoJsonPath(firstPath);
          updateDiagnostics("Drop imported", `COCO JSON set from drop: ${firstPath}`);
          return;
        }

        if (normalized.toLowerCase().endsWith(".mp4")) {
          setMp4Path(firstPath);
          updateDiagnostics("Drop imported", `MP4 set from drop: ${firstPath}`);
          return;
        }

        setDatasetRoot(firstPath);
        updateDiagnostics("Drop imported", `Dataset root set from drop: ${firstPath}`);
      });
    };

    void attach();

    return () => {
      if (unlisten) {
        unlisten();
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
    setIsBusy(true);
    try {
      const { openReport } = await refreshFaces();
      updateDiagnostics(
        `Dataset opened\nmanifest: ${openReport.manifestPath}\nfaces: ${openReport.faceCount}`
      );
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
    setGenerationPercent(5);
    setGenerationDetail("Step 1/4: validating input files");
    try {
      await runImportStage({ datasetRoot, cocoJsonPath, mp4Path });
      setGenerationStep("dependencies");
      setGenerationPercent(20);
      setGenerationDetail("Step 2/4: checking ffmpeg/ffprobe runtime dependencies");
      const runtimeReport = await ensureRuntimeDependencies();

      setGenerationStep("extracting");
      setGenerationPercent(35);
      setGenerationDetail("Step 3/4: extracting referenced frames from MP4");
      const extractionReport = await extractFramesFromMp4({ datasetRoot, cocoJsonPath, mp4Path });
      const effectiveSourceFramesDir = extractionReport.sourceFramesDir;
      setSourceFramesDir(effectiveSourceFramesDir);
      setGenerationPercent(75);
      setGenerationDetail(
        `Step 3/4: extracted ${extractionReport.extractedFrameCount} frame(s) from MP4`
      );

      setGenerationStep("generating");
      setGenerationPercent(85);
      setGenerationDetail("Step 4/4: generating review dataset manifest and faces");
      const report = await generateReviewDataset({
        datasetRoot,
        cocoJsonPath,
        mp4Path,
        sourceFramesDir: effectiveSourceFramesDir,
        generatedAt: nowIso(),
        faces: ["front", "right", "back", "left"],
        renderSize: 1024,
        horizontalFovDegrees: 90,
        minProjectedBoxArea: 1,
      });

      await refreshFaces();
      setGenerationStep("done");
      setGenerationPercent(100);
      setGenerationDetail("Done: review dataset is ready.");
      updateDiagnostics(
        `Review dataset generation complete\n${runtimeReport}\nsourceFramesDir (auto-generated): ${effectiveSourceFramesDir}\nextractedFrames: ${extractionReport.extractedFrameCount}\nmanifest: ${report.writtenManifestPath}\nfaces: ${report.faceCount}\nfilteredBoxes: ${report.filteredBoxCount}`
      );
    } catch (cause) {
      setGenerationStep("idle");
      setGenerationPercent(0);
      setGenerationDetail("Idle.");
      updateDiagnostics("Review dataset generation failed", String(cause));
    } finally {
      setIsBusy(false);
    }
  };

  const loadAnnotations = async (faceId: string) => {
    if (!faceId) {
      setEdits([]);
      setActiveBoxIndex(null);
      setEditValidationError("");
      return;
    }

    setIsBusy(true);
    try {
      const current = await getAnnotations(datasetRoot, faceId);
      setEdits(current);
      setActiveBoxIndex(null);
      setEditValidationError("");
      updateDiagnostics(`Loaded ${current.length} annotation(s) for ${faceId}`);
    } catch (cause) {
      updateDiagnostics("Load annotations failed", String(cause));
    } finally {
      setIsBusy(false);
    }
  };

  useEffect(() => {
    void loadAnnotations(selectedFaceId);
  }, [selectedFaceId]);

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

        const bbox: [number, number, number, number] = [...entry.bbox] as [
          number,
          number,
          number,
          number
        ];
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


  const handleDeleteActiveBox = () => {
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
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isBusy || faces.length === 0) {
        return;
      }

      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        const next = Math.min(selectedIndex + 1, faces.length - 1);
        setSelectedFaceId(faces[next].faceId);
      }

      if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        const next = Math.max(selectedIndex - 1, 0);
        setSelectedFaceId(faces[next].faceId);
      }

      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        !!target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (!isTypingTarget && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        handleDeleteActiveBox();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isBusy, faces, selectedIndex, handleDeleteActiveBox]);


  const getPointerInImageSpace = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !imageViewport) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          imageViewport.naturalWidth,
          ((event.clientX - rect.left) / rect.width) * imageViewport.naturalWidth
        )
      ),
      y: Math.max(
        0,
        Math.min(
          imageViewport.naturalHeight,
          ((event.clientY - rect.top) / rect.height) * imageViewport.naturalHeight
        )
      ),
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
      const inHandle =
        Math.abs(pointer.x - (x + w)) <= handleRadius && Math.abs(pointer.y - (y + h)) <= handleRadius;
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
    if (!selectedFaceId) {
      return;
    }

    const validationError = validateEdits(edits);
    if (validationError) {
      setEditValidationError(validationError);
      updateDiagnostics("Save blocked due to invalid edits", validationError);
      return;
    }

    setIsBusy(true);
    try {
      const saved = await setAnnotations(datasetRoot, selectedFaceId, edits);
      setEdits(saved);
      setEditValidationError("");
      updateDiagnostics(`Saved ${saved.length} annotation(s) for ${selectedFaceId}`);
    } catch (cause) {
      updateDiagnostics("Save edits failed", String(cause));
    } finally {
      setIsBusy(false);
    }
  };

  const handleExport = async () => {
    if (exportInputError) {
      updateDiagnostics("Export blocked", exportInputError);
      return;
    }

    setIsBusy(true);
    try {
      const report = await exportCoco({ datasetRoot, outputPath });
      updateDiagnostics(
        `Export finished\noutput: ${report.outputPath}\nimages=${report.imageCount}\nannotations=${report.annotationCount}`
      );
    } catch (cause) {
      updateDiagnostics("Export failed", String(cause));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <main>
      <h1>bdr-anno-review MVP workstation</h1>
      <div className="progress" aria-label="review progress">
        <span style={{ width: `${progress}%` }} />
      </div>
      <p>
        Progress: {faces.length === 0 ? "0 / 0" : `${selectedIndex + 1} / ${faces.length}`} (↑/↓
        or j/k to navigate)
      </p>

      <div className="grid">
        <section className="card">
          <h3>Dataset open/import</h3>
          <div className="row">
            <label>Dataset root</label>
          </div>
          <div className="row">
            <input
              value={datasetRoot}
              placeholder="Select dataset directory"
              onChange={(event) => setDatasetRoot(event.target.value)}
            />
            <button onClick={() => void pickDirectory(setDatasetRoot)} disabled={isBusy}>
              Browse
            </button>
          </div>
          {datasetRootError ? <p className="error">{datasetRootError}</p> : null}
          <div className="row">
            <button onClick={handleOpen} disabled={isBusy}>
              Open dataset
            </button>
          </div>

          <div className="row">
            <label>COCO JSON</label>
          </div>
          <div className="row">
            <input
              value={cocoJsonPath}
              placeholder="Select instances_default.json"
              onChange={(event) => setCocoJsonPath(event.target.value)}
            />
            <button
              onClick={() => void pickFile(setCocoJsonPath, [{ name: "COCO JSON", extensions: ["json"] }])}
              disabled={isBusy}
            >
              Browse
            </button>
          </div>
          {cocoPathError ? <p className="error">{cocoPathError}</p> : null}
          <div className="row">
            <label>MP4</label>
          </div>
          <div className="row">
            <input
              value={mp4Path}
              placeholder="Select source .mp4"
              onChange={(event) => setMp4Path(event.target.value)}
            />
            <button
              onClick={() => void pickFile(setMp4Path, [{ name: "MP4", extensions: ["mp4"] }])}
              disabled={isBusy}
            >
              Browse
            </button>
          </div>
          {mp4PathError ? <p className="error">{mp4PathError}</p> : null}
          <div className="row">
            <label>Source frames directory (auto-managed)</label>
          </div>
          <input
            aria-label="Source frames directory (auto-managed)"
            value={sourceFramesDir}
            readOnly
            aria-readonly="true"
          />
          <p className="hint">Generated from MP4 extraction; manual overrides are disabled in MVP.</p>
          <p className="hint">Tip: browse or drag-and-drop files/folders onto this window to auto-fill fields.</p>
          <div className="row">
            <label>Generation progress</label>
          </div>
          <div className="progress" aria-label="generation progress">
            <span style={{ width: `${generationPercent}%` }} />
          </div>
          <p className="hint">Step: {generationStep} • {generationDetail}</p>
          <div className="row">
            <button onClick={handleGenerate} disabled={isBusy}>
              Generate review dataset
            </button>
            <button onClick={handleImport} disabled={isBusy}>
              Validate inputs only
            </button>
          </div>

          <h3>Face browse</h3>
          <div className="face-list">
            {faces.map((face) => (
              <button
                key={face.faceId}
                className={`face-item ${face.faceId === selectedFaceId ? "active" : ""}`}
                onClick={() => setSelectedFaceId(face.faceId)}
                disabled={isBusy}
              >
                {face.faceId} ({face.face}) • init:{face.initialBoxCount}
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <h3>BBox edit + save</h3>
          <p>Selected face: {selectedFaceId || "(none)"}</p>
          <div className="preview-shell">
            {selectedFace ? (
              <>
                <img
                  ref={imageRef}
                  className="face-preview"
                  src={imageSrc}
                  alt={`Face preview for ${selectedFace.faceId}`}
                  onLoad={(event) => {
                    setImageViewport({
                      naturalWidth: event.currentTarget.naturalWidth,
                      naturalHeight: event.currentTarget.naturalHeight,
                      displayWidth: event.currentTarget.clientWidth,
                      displayHeight: event.currentTarget.clientHeight,
                    });
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
          <p className="hint">Canvas: drag to draw, drag inside to move, drag lower-right to resize, Delete/Backspace to remove active.</p>

          {edits.map((edit, index) => (
            <div
              className={`row ${activeBoxIndex === index ? "active-row" : ""}`}
              key={`${selectedFaceId}-${index}`}
              onMouseEnter={() => setActiveBoxIndex(index)}
            >
              {["x", "y", "w", "h"].map((axis, axisIndex) => (
                <label key={axis}>
                  {axis}
                  <input
                    value={edit.bbox[axisIndex]}
                    onChange={(event) => handleEditChange(index, axisIndex, event.target.value)}
                  />
                </label>
              ))}
            </div>
          ))}
          {editValidationError ? <p className="error">Invalid edits: {editValidationError}</p> : null}

          <div className="row">
            <button onClick={handleAddBox} disabled={isBusy || !selectedFaceId}>
              Add box
            </button>
            <button onClick={handleDeleteActiveBox} disabled={isBusy || !selectedFaceId || activeBoxIndex === null}>
              Delete active box
            </button>
            <button onClick={handleSave} disabled={isBusy || !selectedFaceId}>
              Save edits
            </button>
          </div>

          <h3>Export trigger</h3>
          <div className="row">
            <input
              value={outputPath}
              placeholder="Select export .json output"
              onChange={(event) => setOutputPath(event.target.value)}
            />
            <button onClick={() => void pickSaveFile()} disabled={isBusy}>
              Browse
            </button>
          </div>
          {outputPathError ? <p className="error">{outputPathError}</p> : null}
          <div className="row">
            <button onClick={handleExport} disabled={isBusy}>
              Export COCO
            </button>
          </div>

          <h3>Backend diagnostics</h3>
          {error ? <p className="error">Error: {error}</p> : null}
          <pre className="status">{status}</pre>
          <small>LLM suggestion helpers are intentionally deferred from this MVP path.</small>
        </section>
      </div>
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
