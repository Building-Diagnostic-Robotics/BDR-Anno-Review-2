use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{EngineError, FaceView, ViewManifest};

const VIEW_MANIFEST_PATH: &str = "annotations/view_manifest.json";
const REVIEW_EDITS_PATH: &str = "annotations/review_edits.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnnotationEdit {
    pub bbox: [f64; 4],
    pub provenance: Provenance,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Provenance {
    pub source: String,
    #[serde(alias = "updatedAt")]
    pub updated_at: String,
    #[serde(alias = "sourceAnnotationId")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_annotation_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReviewEditsDocument {
    pub face_annotations: BTreeMap<String, Vec<AnnotationEdit>>,
}

impl ReviewEditsDocument {
    fn empty() -> Self {
        Self {
            face_annotations: BTreeMap::new(),
        }
    }
}

pub fn get_annotations(
    dataset_root: &str,
    face_id: &str,
) -> Result<Vec<AnnotationEdit>, EngineError> {
    if dataset_root.trim().is_empty() {
        return Err(EngineError::MissingInput("dataset_root"));
    }
    if face_id.trim().is_empty() {
        return Err(EngineError::MissingInput("face_id"));
    }

    let dataset_root = PathBuf::from(dataset_root);
    let manifest = load_manifest(&dataset_root)?;
    let face = require_face(&manifest.faces, face_id)?;

    let edits = load_review_edits(&dataset_root)?;
    Ok(edits
        .face_annotations
        .get(face_id)
        .cloned()
        .unwrap_or_else(|| defaults_from_manifest(face)))
}

pub fn set_annotations(
    dataset_root: &str,
    face_id: &str,
    edits: Vec<AnnotationEdit>,
) -> Result<Vec<AnnotationEdit>, EngineError> {
    if dataset_root.trim().is_empty() {
        return Err(EngineError::MissingInput("dataset_root"));
    }
    if face_id.trim().is_empty() {
        return Err(EngineError::MissingInput("face_id"));
    }

    let dataset_root = PathBuf::from(dataset_root);
    let manifest = load_manifest(&dataset_root)?;
    let _ = require_face(&manifest.faces, face_id)?;

    validate_payload(&edits)?;

    let mut document = load_review_edits(&dataset_root)?;
    document
        .face_annotations
        .insert(face_id.to_owned(), edits.clone());
    persist_review_edits(&dataset_root, &document)?;

    Ok(edits)
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

fn require_face<'a>(faces: &'a [FaceView], face_id: &str) -> Result<&'a FaceView, EngineError> {
    faces
        .iter()
        .find(|face| face.face_id == face_id)
        .ok_or_else(|| EngineError::UnknownFaceId(face_id.to_owned()))
}

fn load_review_edits(dataset_root: &Path) -> Result<ReviewEditsDocument, EngineError> {
    let path = dataset_root.join(REVIEW_EDITS_PATH);
    if !path.exists() {
        return Ok(ReviewEditsDocument::empty());
    }

    ensure_file(&path, "review edits")?;

    let raw = fs::read_to_string(&path).map_err(|source| EngineError::UnreadableFile {
        path: path.display().to_string(),
        reason: source.to_string(),
    })?;

    let document: ReviewEditsDocument = serde_json::from_str(&raw).map_err(|source| {
        EngineError::MalformedPayload(format!(
            "invalid review edits JSON at `{}`: {source}",
            path.display()
        ))
    })?;

    validate_document(&document)?;
    Ok(document)
}

fn validate_document(document: &ReviewEditsDocument) -> Result<(), EngineError> {
    let mut seen = BTreeSet::new();
    for (face_id, edits) in &document.face_annotations {
        if face_id.trim().is_empty() {
            return Err(EngineError::MalformedPayload(
                "face_annotations key must not be empty".to_owned(),
            ));
        }
        if !seen.insert(face_id) {
            return Err(EngineError::MalformedPayload(format!(
                "duplicate face_annotations key `{face_id}`"
            )));
        }

        validate_payload(edits)?;
    }

    Ok(())
}

fn validate_payload(edits: &[AnnotationEdit]) -> Result<(), EngineError> {
    for (index, edit) in edits.iter().enumerate() {
        let [x, y, w, h] = edit.bbox;
        if !x.is_finite() || !y.is_finite() || !w.is_finite() || !h.is_finite() {
            return Err(EngineError::MalformedPayload(format!(
                "annotation edit at index {index} has non-finite bbox values"
            )));
        }
        if w <= 0.0 || h <= 0.0 {
            return Err(EngineError::MalformedPayload(format!(
                "annotation edit at index {index} must have positive width/height"
            )));
        }
        if edit.provenance.source.trim().is_empty() {
            return Err(EngineError::MalformedPayload(format!(
                "annotation edit at index {index} is missing provenance.source"
            )));
        }
        if edit.provenance.updated_at.trim().is_empty() {
            return Err(EngineError::MalformedPayload(format!(
                "annotation edit at index {index} is missing provenance.updated_at"
            )));
        }
    }

    Ok(())
}

fn defaults_from_manifest(face: &FaceView) -> Vec<AnnotationEdit> {
    face.initial_boxes
        .iter()
        .map(|item| AnnotationEdit {
            bbox: item.bbox,
            provenance: Provenance {
                source: "manifest_initial".to_owned(),
                updated_at: "manifest_generated".to_owned(),
                source_annotation_id: item.source_annotation_id,
            },
        })
        .collect()
}

fn persist_review_edits(
    dataset_root: &Path,
    document: &ReviewEditsDocument,
) -> Result<(), EngineError> {
    let path = dataset_root.join(REVIEW_EDITS_PATH);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| EngineError::UnreadableFile {
            path: parent.display().to_string(),
            reason: format!("could not create review edits directory: {source}"),
        })?;
    }

    let serialized = serde_json::to_string_pretty(document).map_err(|source| {
        EngineError::InvalidConfiguration(format!(
            "failed to serialize review edits JSON: {source}"
        ))
    })?;

    atomic_write(&path, serialized.as_bytes())
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

fn ensure_file(path: &Path, label: &'static str) -> Result<(), EngineError> {
    if !path.is_file() {
        return Err(EngineError::MissingFile {
            path: path.display().to_string(),
            reason: format!("{label} file does not exist"),
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FramesSource, ManifestInputs, ProjectionConfig, RenderConfig, ViewManifest};

    fn unique_temp_dir() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("engine-review-edits-{nanos}"))
    }

    fn write_manifest(dataset_root: &Path, face_ids: &[&str]) {
        let mut faces = Vec::new();
        for (idx, face_id) in face_ids.iter().enumerate() {
            faces.push(FaceView {
                face_id: (*face_id).to_owned(),
                source_image_id: idx as u64 + 1,
                face: "front".to_owned(),
                image_path: format!("raw_frames/{face_id}.png"),
                initial_boxes: Vec::new(),
            });
        }

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
                faces: vec!["front".to_owned()],
                size: 1024,
            },
            projection: ProjectionConfig {
                horizontal_fov_degrees: 90.0,
                min_projected_box_area: 1.0,
            },
            faces,
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
    fn round_trip_persistence_for_single_face() {
        let root = unique_temp_dir();
        fs::create_dir_all(&root).unwrap();
        write_manifest(&root, &["face_a"]);

        let first = vec![AnnotationEdit {
            bbox: [10.0, 20.0, 30.0, 40.0],
            provenance: Provenance {
                source: "manual".to_owned(),
                updated_at: "2026-01-01T00:00:00Z".to_owned(),
                source_annotation_id: Some(11),
            },
        }];

        set_annotations(root.to_str().unwrap(), "face_a", first.clone()).unwrap();
        let loaded = get_annotations(root.to_str().unwrap(), "face_a").unwrap();

        assert_eq!(loaded, first);
    }

    #[test]
    fn serialization_order_is_deterministic() {
        let root = unique_temp_dir();
        fs::create_dir_all(&root).unwrap();
        write_manifest(&root, &["z_face", "a_face"]);

        set_annotations(
            root.to_str().unwrap(),
            "z_face",
            vec![AnnotationEdit {
                bbox: [1.0, 1.0, 5.0, 6.0],
                provenance: Provenance {
                    source: "manual".to_owned(),
                    updated_at: "t1".to_owned(),
                    source_annotation_id: None,
                },
            }],
        )
        .unwrap();

        set_annotations(
            root.to_str().unwrap(),
            "a_face",
            vec![AnnotationEdit {
                bbox: [2.0, 2.0, 5.0, 6.0],
                provenance: Provenance {
                    source: "manual".to_owned(),
                    updated_at: "t2".to_owned(),
                    source_annotation_id: None,
                },
            }],
        )
        .unwrap();

        let raw = fs::read_to_string(root.join(REVIEW_EDITS_PATH)).unwrap();
        let a_pos = raw.find("a_face").unwrap();
        let z_pos = raw.find("z_face").unwrap();

        assert!(
            a_pos < z_pos,
            "expected lexical key ordering in serialized JSON"
        );
    }

    #[test]
    fn rejects_malformed_payload() {
        let root = unique_temp_dir();
        fs::create_dir_all(&root).unwrap();
        write_manifest(&root, &["known_face"]);

        let err = set_annotations(
            root.to_str().unwrap(),
            "known_face",
            vec![AnnotationEdit {
                bbox: [1.0, 2.0, 0.0, 3.0],
                provenance: Provenance {
                    source: "manual".to_owned(),
                    updated_at: "2026-01-01T00:00:00Z".to_owned(),
                    source_annotation_id: None,
                },
            }],
        )
        .unwrap_err();

        assert_eq!(
            err.to_string(),
            "malformed payload: annotation edit at index 0 must have positive width/height"
        );
    }

    #[test]
    fn rejects_unknown_face_id() {
        let root = unique_temp_dir();
        fs::create_dir_all(&root).unwrap();
        write_manifest(&root, &["known_face"]);

        let err = set_annotations(root.to_str().unwrap(), "missing", Vec::new()).unwrap_err();
        assert_eq!(err.to_string(), "unknown face_id: missing");
    }

    #[test]
    fn provenance_deserializes_frontend_camel_case_aliases() {
        let raw =
            r#"{"source":"ui_manual","updatedAt":"2026-01-01T00:00:00Z","sourceAnnotationId":77}"#;
        let parsed: Provenance = serde_json::from_str(raw).unwrap();

        assert_eq!(parsed.source, "ui_manual");
        assert_eq!(parsed.updated_at, "2026-01-01T00:00:00Z");
        assert_eq!(parsed.source_annotation_id, Some(77));
    }
}
