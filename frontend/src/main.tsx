import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import {
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

function App() {
  const [datasetRoot, setDatasetRoot] = useState("fixtures/tiny_dataset");
  const [cocoJsonPath, setCocoJsonPath] = useState("annotations/instances_default.json");
  const [mp4Path, setMp4Path] = useState("videos/source.mp4");
  const [sourceFramesDir, setSourceFramesDir] = useState("derived_frames/frame_sourcing");
  const [outputPath, setOutputPath] = useState("annotations/exported_instances.json");

  const [faces, setFaces] = useState<FaceListItem[]>([]);
  const [selectedFaceId, setSelectedFaceId] = useState<string>("");
  const [edits, setEdits] = useState<AnnotationEdit[]>([]);

  const [isBusy, setIsBusy] = useState(false);
  const [status, setStatus] = useState("Ready.");
  const [error, setError] = useState("");

  const selectedIndex = useMemo(
    () => faces.findIndex((face) => face.faceId === selectedFaceId),
    [faces, selectedFaceId]
  );

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
      const report = await generateReviewDataset({
        datasetRoot,
        cocoJsonPath,
        mp4Path,
        sourceFramesDir,
        generatedAt: nowIso(),
        faces: ["front", "right", "back", "left"],
        renderSize: 1024,
        horizontalFovDegrees: 90,
        minProjectedBoxArea: 1,
      });

      await refreshFaces();
      updateDiagnostics(
        `Review dataset generation complete\nmanifest: ${report.writtenManifestPath}\nfaces: ${report.faceCount}\nfilteredBoxes: ${report.filteredBoxCount}`
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

      let generationReport;
      try {
        generationReport = await generateReviewDataset({
          datasetRoot,
          cocoJsonPath,
          mp4Path,
          sourceFramesDir,
          generatedAt: nowIso(),
          faces: ["front", "right", "back", "left"],
          renderSize: 1024,
          horizontalFovDegrees: 90,
          minProjectedBoxArea: 1,
        });
      } catch (generationError) {
        updateDiagnostics(
          "Generation failed after successful validation",
          `Validation passed: images=${importReport.imageCount}, annotations=${importReport.annotationCount}, categories=${importReport.categoryCount}, referenced=${importReport.referencedImageCount}\nGeneration error: ${String(
            generationError
          )}`
        );
        return;
      }

      await refreshFaces();
      updateDiagnostics(
        `Validation + generation complete\nvalidation: images=${importReport.imageCount}, annotations=${importReport.annotationCount}, categories=${importReport.categoryCount}, referenced=${importReport.referencedImageCount}\nmanifest: ${generationReport.writtenManifestPath}\nfaces: ${generationReport.faceCount}\nfilteredBoxes: ${generationReport.filteredBoxCount}`
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
      return;
    }

    setIsBusy(true);
    try {
      const current = await getAnnotations(datasetRoot, faceId);
      setEdits(current);
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
  };

  const handleAddBox = () => {
    setEdits((previous) => [
      ...previous,
      {
        bbox: [0, 0, 32, 32],
        provenance: { source: "ui_manual", updatedAt: nowIso() },
      },
    ]);
  };

  const handleSave = async () => {
    if (!selectedFaceId) {
      return;
    }

    setIsBusy(true);
    try {
      const saved = await setAnnotations(datasetRoot, selectedFaceId, edits);
      setEdits(saved);
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
          {edits.map((edit, index) => (
            <div className="row" key={`${selectedFaceId}-${index}`}>
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
