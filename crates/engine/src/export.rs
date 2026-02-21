use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{AnnotationEdit, EngineError, FaceView, ReviewEditsDocument, ViewManifest};

const VIEW_MANIFEST_PATH: &str = "annotations/view_manifest.json";
const REVIEW_EDITS_PATH: &str = "annotations/review_edits.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportCocoOptions {
    pub dataset_root: String,
    pub output_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportCocoReport {
    pub output_path: String,
    pub image_count: usize,
    pub annotation_count: usize,
}

#[derive(Debug, Serialize)]
struct ExportCocoDocument {
    images: Vec<ExportImage>,
    annotations: Vec<ExportAnnotation>,
    categories: Vec<ExportCategory>,
}

#[derive(Debug, Serialize)]
struct ExportImage {
    id: u64,
    file_name: String,
    width: u64,
    height: u64,
}

#[derive(Debug, Serialize)]
struct ExportAnnotation {
    id: u64,
    image_id: u64,
    category_id: u64,
    bbox: [f64; 4],
    area: f64,
    iscrowd: u8,
}

#[derive(Debug, Serialize)]
struct ExportCategory {
    id: u64,
    name: String,
}

pub fn export_coco(options: ExportCocoOptions) -> Result<ExportCocoReport, EngineError> {
    if options.dataset_root.trim().is_empty() {
        return Err(EngineError::MissingInput("dataset_root"));
    }
    if options.output_path.trim().is_empty() {
        return Err(EngineError::MissingInput("output_path"));
    }

    let dataset_root = PathBuf::from(&options.dataset_root);
    let manifest = load_manifest(&dataset_root)?;
    let edits = load_review_edits(&dataset_root)?;

    let output_path = resolve_path(&dataset_root, &options.output_path);
    validate_output_path_writable(&output_path)?;

    let mut images = Vec::with_capacity(manifest.faces.len());
    let mut annotations = Vec::new();
    let mut next_annotation_id = 1u64;

    for (face_index, face) in manifest.faces.iter().enumerate() {
        let image_id = face_index as u64 + 1;
        images.push(ExportImage {
            id: image_id,
            file_name: face.image_path.clone(),
            width: manifest.render.size,
            height: manifest.render.size,
        });

        let mut face_annotations = merged_face_annotations(face, &edits);
        face_annotations.sort_by_key(|edit| bbox_sort_key(edit.bbox));

        for edit in face_annotations {
            annotations.push(ExportAnnotation {
                id: next_annotation_id,
                image_id,
                category_id: 1,
                bbox: edit.bbox,
                area: edit.bbox[2] * edit.bbox[3],
                iscrowd: 0,
            });
            next_annotation_id += 1;
        }
    }

    let document = ExportCocoDocument {
        images,
        annotations,
        categories: vec![ExportCategory {
            id: 1,
            name: "bbox".to_owned(),
        }],
    };

    let serialized = serde_json::to_string_pretty(&document).map_err(|source| {
        EngineError::InvalidConfiguration(format!("failed to serialize export COCO JSON: {source}"))
    })?;
    atomic_write(&output_path, serialized.as_bytes())?;

    Ok(ExportCocoReport {
        output_path: output_path.display().to_string(),
        image_count: document.images.len(),
        annotation_count: document.annotations.len(),
    })
}

fn merged_face_annotations(face: &FaceView, edits: &ReviewEditsDocument) -> Vec<AnnotationEdit> {
    edits
        .face_annotations
        .get(&face.face_id)
        .cloned()
        .unwrap_or_else(|| {
            face.initial_boxes
                .iter()
                .map(|entry| AnnotationEdit {
                    bbox: entry.bbox,
                    provenance: crate::Provenance {
                        source: "manifest_initial".to_owned(),
                        updated_at: "manifest_generated".to_owned(),
                        source_annotation_id: entry.source_annotation_id,
                    },
                })
                .collect()
        })
}

fn bbox_sort_key(bbox: [f64; 4]) -> (i64, i64, i64, i64) {
    (
        rounded_scaled(bbox[0]),
        rounded_scaled(bbox[1]),
        rounded_scaled(bbox[2]),
        rounded_scaled(bbox[3]),
    )
}

fn rounded_scaled(value: f64) -> i64 {
    (value * 1_000_000.0).round() as i64
}

fn load_manifest(dataset_root: &Path) -> Result<ViewManifest, EngineError> {
    let manifest_path = dataset_root.join(VIEW_MANIFEST_PATH);
    ensure_file(&manifest_path, "view manifest")?;

    let raw = fs::read_to_string(&manifest_path).map_err(|source| EngineError::UnreadableFile {
        path: manifest_path.display().to_string(),
        reason: source.to_string(),
    })?;

    serde_json::from_str(&raw).map_err(|source| {
        EngineError::InvalidConfiguration(format!(
            "invalid view manifest JSON at `{}`: {source}",
            manifest_path.display()
        ))
    })
}

fn load_review_edits(dataset_root: &Path) -> Result<ReviewEditsDocument, EngineError> {
    let path = dataset_root.join(REVIEW_EDITS_PATH);
    if !path.exists() {
        return Ok(ReviewEditsDocument {
            face_annotations: BTreeMap::new(),
        });
    }

    ensure_file(&path, "review edits")?;

    let raw = fs::read_to_string(&path).map_err(|source| EngineError::UnreadableFile {
        path: path.display().to_string(),
        reason: source.to_string(),
    })?;

    serde_json::from_str(&raw).map_err(|source| {
        EngineError::MalformedPayload(format!(
            "invalid review edits JSON at `{}`: {source}",
            path.display()
        ))
    })
}

fn resolve_path(dataset_root: &Path, input: &str) -> PathBuf {
    let candidate = PathBuf::from(input);
    if candidate.is_absolute() {
        candidate
    } else {
        dataset_root.join(candidate)
    }
}

fn validate_output_path_writable(output_path: &Path) -> Result<(), EngineError> {
    if output_path.exists() && output_path.is_dir() {
        return Err(EngineError::UnreadableFile {
            path: output_path.display().to_string(),
            reason: "output path is a directory; expected a writable JSON file path".to_owned(),
        });
    }

    let parent = output_path.parent().ok_or_else(|| {
        EngineError::InvalidConfiguration(format!(
            "invalid output path `{}`",
            output_path.display()
        ))
    })?;

    fs::create_dir_all(parent).map_err(|source| EngineError::UnreadableFile {
        path: parent.display().to_string(),
        reason: format!("could not create output directory: {source}"),
    })?;

    let probe_path = parent.join(".export_write_probe.tmp");
    let mut probe =
        fs::File::create(&probe_path).map_err(|source| EngineError::UnreadableFile {
            path: output_path.display().to_string(),
            reason: format!("output path parent is not writable: {source}"),
        })?;
    probe
        .write_all(b"ok")
        .map_err(|source| EngineError::UnreadableFile {
            path: output_path.display().to_string(),
            reason: format!("output path parent is not writable: {source}"),
        })?;
    let _ = fs::remove_file(&probe_path);

    Ok(())
}

fn ensure_file(path: &Path, label: &'static str) -> Result<(), EngineError> {
    if !path.is_file() {
        return Err(EngineError::MissingFile {
            path: path.display().to_string(),
            reason: format!("{label} file does not exist"),
        });
    }

    Ok(())
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), EngineError> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            EngineError::InvalidConfiguration(format!(
                "invalid target file path `{}`",
                path.display()
            ))
        })?;

    let tmp_name = format!(".{file_name}.tmp");
    let tmp_path = path.with_file_name(tmp_name);

    let mut temp_file =
        fs::File::create(&tmp_path).map_err(|source| EngineError::UnreadableFile {
            path: tmp_path.display().to_string(),
            reason: format!("could not create temporary file for atomic write: {source}"),
        })?;
    temp_file
        .write_all(contents)
        .map_err(|source| EngineError::UnreadableFile {
            path: tmp_path.display().to_string(),
            reason: format!("could not write temporary file for atomic write: {source}"),
        })?;
    temp_file
        .sync_all()
        .map_err(|source| EngineError::UnreadableFile {
            path: tmp_path.display().to_string(),
            reason: format!("could not sync temporary file for atomic write: {source}"),
        })?;

    fs::rename(&tmp_path, path).map_err(|source| EngineError::UnreadableFile {
        path: path.display().to_string(),
        reason: format!("could not atomically replace file: {source}"),
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        FaceView, FramesSource, ManifestInputs, ProjectedBox, ProjectionConfig, RenderConfig,
        ViewManifest,
    };

    fn unique_temp_dir() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("engine-export-{nanos}"))
    }

    fn write_manifest(dataset_root: &Path) {
        let manifest = ViewManifest {
            schema_version: "1".to_owned(),
            generated_at: "2026-01-01T00:00:00Z".to_owned(),
            inputs: ManifestInputs {
                coco_path: "annotations/instances_default.json".to_owned(),
                frames_source: FramesSource::Dir {
                    path: "derived_frames/frame_sourcing".to_owned(),
                },
            },
            render: RenderConfig {
                faces: vec!["front".to_owned(), "right".to_owned()],
                size: 1024,
            },
            projection: ProjectionConfig {
                horizontal_fov_degrees: 90.0,
                min_projected_box_area: 1.0,
            },
            faces: vec![
                FaceView {
                    face_id: "img1_front".to_owned(),
                    source_image_id: 1,
                    face: "front".to_owned(),
                    image_path: "raw_frames/img1_front.png".to_owned(),
                    initial_boxes: vec![ProjectedBox {
                        source_annotation_id: Some(10),
                        bbox: [8.0, 8.0, 6.0, 6.0],
                    }],
                },
                FaceView {
                    face_id: "img1_right".to_owned(),
                    source_image_id: 1,
                    face: "right".to_owned(),
                    image_path: "raw_frames/img1_right.png".to_owned(),
                    initial_boxes: vec![],
                },
            ],
        };

        let annotations_dir = dataset_root.join("annotations");
        fs::create_dir_all(&annotations_dir).unwrap();
        fs::write(
            annotations_dir.join("view_manifest.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn export_is_byte_stable_and_forces_single_category_contract() {
        let dataset_root = unique_temp_dir();
        fs::create_dir_all(&dataset_root).unwrap();
        write_manifest(&dataset_root);

        fs::write(
            dataset_root.join("annotations/review_edits.json"),
            r#"{
  "face_annotations": {
    "img1_right": [
      {
        "bbox": [30.0, 6.0, 5.0, 4.0],
        "provenance": {
          "source": "manual",
          "updated_at": "2026-01-02T00:00:00Z"
        }
      }
    ],
    "img1_front": [
      {
        "bbox": [15.0, 20.0, 2.0, 3.0],
        "provenance": {
          "source": "manual",
          "updated_at": "2026-01-02T00:00:00Z"
        }
      },
      {
        "bbox": [2.0, 5.0, 4.0, 7.0],
        "provenance": {
          "source": "manual",
          "updated_at": "2026-01-02T00:00:00Z"
        }
      }
    ]
  }
}"#,
        )
        .unwrap();

        let first_path = dataset_root.join("exports/run1.json");
        let second_path = dataset_root.join("exports/run2.json");

        let first_report = export_coco(ExportCocoOptions {
            dataset_root: dataset_root.display().to_string(),
            output_path: first_path.display().to_string(),
        })
        .unwrap();
        assert_eq!(first_report.image_count, 2);
        assert_eq!(first_report.annotation_count, 3);

        let second_report = export_coco(ExportCocoOptions {
            dataset_root: dataset_root.display().to_string(),
            output_path: second_path.display().to_string(),
        })
        .unwrap();
        assert_eq!(second_report.image_count, 2);
        assert_eq!(second_report.annotation_count, 3);

        let first_bytes = fs::read(&first_path).unwrap();
        let second_bytes = fs::read(&second_path).unwrap();
        assert_eq!(first_bytes, second_bytes);

        let exported: serde_json::Value = serde_json::from_slice(&first_bytes).unwrap();
        assert_eq!(exported["categories"][0]["id"], 1);
        assert_eq!(exported["categories"][0]["name"], "bbox");

        assert_eq!(exported["images"][0]["id"], 1);
        assert_eq!(exported["images"][1]["id"], 2);

        assert_eq!(exported["annotations"][0]["id"], 1);
        assert_eq!(exported["annotations"][1]["id"], 2);
        assert_eq!(exported["annotations"][2]["id"], 3);

        assert_eq!(exported["annotations"][0]["image_id"], 1);
        assert_eq!(exported["annotations"][1]["image_id"], 1);
        assert_eq!(exported["annotations"][2]["image_id"], 2);

        assert_eq!(exported["annotations"][0]["category_id"], 1);
        assert_eq!(exported["annotations"][1]["category_id"], 1);
        assert_eq!(exported["annotations"][2]["category_id"], 1);

        fs::remove_dir_all(&dataset_root).unwrap();
    }

    #[test]
    fn export_fails_loudly_when_manifest_is_missing() {
        let dataset_root = unique_temp_dir();
        fs::create_dir_all(&dataset_root).unwrap();

        let err = export_coco(ExportCocoOptions {
            dataset_root: dataset_root.display().to_string(),
            output_path: dataset_root.join("out.json").display().to_string(),
        })
        .unwrap_err();

        assert!(matches!(err, EngineError::MissingFile { .. }));
        assert!(err.to_string().contains("view manifest"));

        fs::remove_dir_all(&dataset_root).unwrap();
    }

    #[test]
    fn export_fails_when_output_path_points_to_directory() {
        let dataset_root = unique_temp_dir();
        fs::create_dir_all(&dataset_root).unwrap();
        write_manifest(&dataset_root);

        let err = export_coco(ExportCocoOptions {
            dataset_root: dataset_root.display().to_string(),
            output_path: dataset_root.join("annotations").display().to_string(),
        })
        .unwrap_err();

        assert!(matches!(err, EngineError::UnreadableFile { .. }));
        assert!(err.to_string().contains("output path is a directory"));

        fs::remove_dir_all(&dataset_root).unwrap();
    }
}
