import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  extractFramesFromMp4,
  exportCoco,
  generateReviewDataset,
  getAnnotations,
  listFaces,
  openDataset,
  runImportStage,
  setAnnotations,
} from "./api";
import type { AnnotationEdit, FaceListItem } from "./types";
import "./styles.css";

const nowIso = () => new Date().toISOString();

type ImageViewport = {
  naturalWidth: number;
  naturalHeight: number;
  displayWidth: number;
  displayHeight: number;
};

type PointerMode = "idle" | "draw" | "move" | "resize";

const resolveFaceImagePath = (datasetRoot: string, imagePath: string) => {
  const normalizedPath = imagePath.replace(/\\/g, "/");
  if (normalizedPath.startsWith("/") || /^[A-Za-z]:\//.test(normalizedPath)) {
    return normalizedPath;
  }
  return `${datasetRoot.replace(/\/$/, "")}/${normalizedPath}`;
};

const validateEdits = (entries: AnnotationEdit[]) => {
  for (let index = 0; index < entries.length; index += 1) {
    const [x, y, w, h] = entries[index].bbox;
    if (![x, y, w, h].every((value) => Number.isFinite(value))) {
      return `Box ${index + 1} has non-finite values.`;
    }
    if (w < 0 || h < 0) {
      return `Box ${index + 1} has invalid size (width/height must be non-negative).`;
    }
  }
  return "";
};

function App() {
  const [datasetRoot, setDatasetRoot] = useState("fixtures/tiny_dataset");
  const [cocoJsonPath, setCocoJsonPath] = useState("annotations/instances_default.json");
  const [mp4Path, setMp4Path] = useState("videos/source.mp4");
  const [sourceFramesDir, setSourceFramesDir] = useState("derived_frames/frame_sourcing");
  const [outputPath, setOutputPath] = useState("annotations/exported_instances.json");

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

  const selectedIndex = useMemo(
    () => faces.findIndex((face) => face.faceId === selectedFaceId),
    [faces, selectedFaceId]
  );
  const selectedFace = selectedIndex < 0 ? undefined : faces[selectedIndex];
  const imageSrc = selectedFace
    ? convertFileSrc(resolveFaceImagePath(datasetRoot, selectedFace.imagePath))
    : "";

  const progress = faces.length === 0 ? 0 : ((selectedIndex + 1) / faces.length) * 100;

  const updateDiagnostics = (nextStatus: string, nextError = "") => {
    setStatus(nextStatus);
    setError(nextError);
  };

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
    setIsBusy(true);
    try {
      const extractionReport = await extractFramesFromMp4({ datasetRoot, cocoJsonPath, mp4Path });
      setSourceFramesDir(extractionReport.sourceFramesDir);

      const report = await generateReviewDataset({
        datasetRoot,
        cocoJsonPath,
        mp4Path,
        sourceFramesDir: extractionReport.sourceFramesDir,
        generatedAt: nowIso(),
        faces: ["front", "right", "back", "left"],
        renderSize: 1024,
        horizontalFovDegrees: 90,
        minProjectedBoxArea: 1,
      });

      await refreshFaces();
      updateDiagnostics(
        `Review dataset generation complete\nsourceFramesDir: ${extractionReport.sourceFramesDir}\nextractedFrames: ${extractionReport.extractedFrameCount}\nmanifest: ${report.writtenManifestPath}\nfaces: ${report.faceCount}\nfilteredBoxes: ${report.filteredBoxCount}`
      );
    } catch (cause) {
      updateDiagnostics("Review dataset generation failed", String(cause));
    } finally {
      setIsBusy(false);
    }
  };

  const handleValidateAndGenerate = async () => {
    setIsBusy(true);
    try {
      const importReport = await runImportStage({ datasetRoot, cocoJsonPath, mp4Path });

      const extractionReport = await extractFramesFromMp4({ datasetRoot, cocoJsonPath, mp4Path });
      setSourceFramesDir(extractionReport.sourceFramesDir);

      let generationReport;
      try {
        generationReport = await generateReviewDataset({
          datasetRoot,
          cocoJsonPath,
          mp4Path,
          sourceFramesDir: extractionReport.sourceFramesDir,
          generatedAt: nowIso(),
          faces: ["front", "right", "back", "left"],
          renderSize: 1024,
          horizontalFovDegrees: 90,
          minProjectedBoxArea: 1,
        });
      } catch (generationError) {
        updateDiagnostics(
          "Generation failed after successful validation",
          `Validation passed: images=${importReport.imageCount}, annotations=${importReport.annotationCount}, categories=${importReport.categoryCount}, referenced=${importReport.referencedImageCount}\nExtraction: sourceFramesDir=${extractionReport.sourceFramesDir}, extractedFrames=${extractionReport.extractedFrameCount}\nGeneration error: ${String(
            generationError
          )}`
        );
        return;
      }

      await refreshFaces();
      updateDiagnostics(
        `Validation + generation complete\nvalidation: images=${importReport.imageCount}, annotations=${importReport.annotationCount}, categories=${importReport.categoryCount}, referenced=${importReport.referencedImageCount}\nextraction: sourceFramesDir=${extractionReport.sourceFramesDir}, extractedFrames=${extractionReport.extractedFrameCount}\nmanifest: ${generationReport.writtenManifestPath}\nfaces: ${generationReport.faceCount}\nfilteredBoxes: ${generationReport.filteredBoxCount}`
      );
    } catch (cause) {
      updateDiagnostics("Import validation failed", String(cause));
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
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isBusy, faces, selectedIndex]);

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
          <input value={datasetRoot} onChange={(event) => setDatasetRoot(event.target.value)} />
          <div className="row">
            <button onClick={handleOpen} disabled={isBusy}>
              Open dataset
            </button>
          </div>

          <div className="row">
            <label>COCO JSON</label>
          </div>
          <input value={cocoJsonPath} onChange={(event) => setCocoJsonPath(event.target.value)} />
          <div className="row">
            <label>MP4</label>
          </div>
          <input value={mp4Path} onChange={(event) => setMp4Path(event.target.value)} />
          <div className="row">
            <label>Source frames directory</label>
          </div>
          <input
            value={sourceFramesDir}
            onChange={(event) => setSourceFramesDir(event.target.value)}
          />
          <div className="row">
            <button onClick={handleImport} disabled={isBusy}>
              Validate import
            </button>
            <button onClick={handleGenerate} disabled={isBusy}>
              Generate review dataset
            </button>
            <button onClick={handleValidateAndGenerate} disabled={isBusy}>
              Validate + generate
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
          <p className="hint">Canvas: drag to draw, drag inside to move, drag lower-right to resize.</p>

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
            <button onClick={handleSave} disabled={isBusy || !selectedFaceId}>
              Save edits
            </button>
          </div>

          <h3>Export trigger</h3>
          <input value={outputPath} onChange={(event) => setOutputPath(event.target.value)} />
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
