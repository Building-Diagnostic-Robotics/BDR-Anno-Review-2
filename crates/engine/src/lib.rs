use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod import_stage;

pub use import_stage::{run_import_stage, ImportStageOptions, ImportStageReport};

pub const MANIFEST_VERSION: &str = "1";

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("missing required input: {0}")]
    MissingInput(&'static str),
    #[error("unsupported schema_version: {0}")]
    UnsupportedSchemaVersion(String),
    #[error("missing file: {path} ({reason})")]
    MissingFile { path: String, reason: String },
    #[error("unsupported format for {field}: expected .{expected} file, got `{actual_path}`")]
    UnsupportedFormat {
        field: &'static str,
        expected: &'static str,
        actual_path: String,
    },
    #[error("could not read file `{path}`: {reason}")]
    UnreadableFile { path: String, reason: String },
    #[error("invalid COCO JSON at `{path}`: {reason}")]
    InvalidCoco { path: String, reason: String },
    #[error("required COCO section is missing: {0}")]
    MissingCocoSection(&'static str),
    #[error("required COCO section is empty: {0}")]
    EmptyCocoSection(&'static str),
    #[error("invalid COCO entry in section `{section}` at index {index}: {reason}")]
    InvalidCocoEntry {
        section: &'static str,
        index: usize,
        reason: String,
    },
    #[error("annotation reference is broken: annotation index {annotation_index} (id {annotation_id:?}) points to missing image_id {image_id}")]
    BrokenAnnotationReference {
        annotation_index: usize,
        annotation_id: Option<u64>,
        image_id: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ViewManifest {
    pub schema_version: String,
    pub generated_at: String,
    pub inputs: ManifestInputs,
    pub render: RenderConfig,
    pub projection: ProjectionConfig,
    pub faces: Vec<FaceView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManifestInputs {
    pub coco_path: String,
    pub frames_source: FramesSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum FramesSource {
    #[serde(rename = "dir")]
    Dir { path: String },
    #[serde(rename = "mp4")]
    Mp4 { path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RenderConfig {
    pub faces: Vec<String>,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectionConfig {
    pub horizontal_fov_degrees: f64,
    pub min_projected_box_area: f64,
}

pub fn expect_supported_schema_version(schema_version: &str) -> Result<(), EngineError> {
    if schema_version == MANIFEST_VERSION {
        Ok(())
    } else {
        Err(EngineError::UnsupportedSchemaVersion(
            schema_version.to_owned(),
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FaceView {
    pub face_id: String,
    pub source_image_id: u64,
    pub face: String,
    pub image_path: String,
}

pub fn init_empty_manifest(
    generated_at: &str,
    inputs: ManifestInputs,
    render: RenderConfig,
    projection: ProjectionConfig,
) -> Result<ViewManifest, EngineError> {
    if generated_at.trim().is_empty() {
        return Err(EngineError::MissingInput("generated_at"));
    }
    if inputs.coco_path.trim().is_empty() {
        return Err(EngineError::MissingInput("inputs.coco_path"));
    }

    match &inputs.frames_source {
        FramesSource::Dir { path } | FramesSource::Mp4 { path } if path.trim().is_empty() => {
            return Err(EngineError::MissingInput("inputs.frames_source.path"));
        }
        _ => {}
    }

    if render.faces.is_empty() {
        return Err(EngineError::MissingInput("render.faces"));
    }
    if render.size == 0 {
        return Err(EngineError::MissingInput("render.size"));
    }

    if projection.horizontal_fov_degrees <= 0.0 {
        return Err(EngineError::MissingInput(
            "projection.horizontal_fov_degrees",
        ));
    }
    if projection.min_projected_box_area < 0.0 {
        return Err(EngineError::MissingInput(
            "projection.min_projected_box_area",
        ));
    }

    Ok(ViewManifest {
        schema_version: MANIFEST_VERSION.to_owned(),
        generated_at: generated_at.to_owned(),
        inputs,
        render,
        projection,
        faces: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_inputs() -> ManifestInputs {
        ManifestInputs {
            coco_path: "annotations/instances_default.json".to_owned(),
            frames_source: FramesSource::Mp4 {
                path: "videos/source.mp4".to_owned(),
            },
        }
    }

    fn sample_render() -> RenderConfig {
        RenderConfig {
            faces: vec![
                "front".to_owned(),
                "right".to_owned(),
                "back".to_owned(),
                "left".to_owned(),
            ],
            size: 1024,
        }
    }

    fn sample_projection() -> ProjectionConfig {
        ProjectionConfig {
            horizontal_fov_degrees: 90.0,
            min_projected_box_area: 1.0,
        }
    }

    #[test]
    fn init_manifest_requires_timestamp() {
        let err = init_empty_manifest("", sample_inputs(), sample_render(), sample_projection())
            .unwrap_err();
        assert_eq!(err.to_string(), "missing required input: generated_at");
    }

    #[test]
    fn init_manifest_requires_coco_path() {
        let mut inputs = sample_inputs();
        inputs.coco_path = "   ".to_owned();

        let err = init_empty_manifest(
            "2026-01-01T00:00:00Z",
            inputs,
            sample_render(),
            sample_projection(),
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "missing required input: inputs.coco_path");
    }

    #[test]
    fn init_manifest_requires_frames_source_path() {
        let mut inputs = sample_inputs();
        inputs.frames_source = FramesSource::Dir {
            path: String::new(),
        };

        let err = init_empty_manifest(
            "2026-01-01T00:00:00Z",
            inputs,
            sample_render(),
            sample_projection(),
        )
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "missing required input: inputs.frames_source.path"
        );
    }

    #[test]
    fn init_manifest_sets_schema_version() {
        let manifest = init_empty_manifest(
            "2026-01-01T00:00:00Z",
            sample_inputs(),
            sample_render(),
            sample_projection(),
        )
        .unwrap();

        assert_eq!(manifest.schema_version, MANIFEST_VERSION);
        assert!(manifest.faces.is_empty());
    }

    #[test]
    fn schema_version_validation_rejects_wrong_version() {
        let value = serde_json::json!({
            "schema_version": "2",
            "generated_at": "2026-01-01T00:00:00Z",
            "inputs": {
                "coco_path": "annotations/instances_default.json",
                "frames_source": {
                    "type": "mp4",
                    "path": "videos/source.mp4"
                }
            },
            "render": {
                "faces": ["front", "right", "back", "left"],
                "size": 1024
            },
            "projection": {
                "horizontal_fov_degrees": 90.0,
                "min_projected_box_area": 1.0
            },
            "faces": []
        });

        let manifest: ViewManifest = serde_json::from_value(value).unwrap();
        let err = expect_supported_schema_version(&manifest.schema_version).unwrap_err();
        assert_eq!(err.to_string(), "unsupported schema_version: 2");
    }

    #[test]
    fn schema_version_validation_accepts_current_version() {
        assert!(expect_supported_schema_version(MANIFEST_VERSION).is_ok());
    }
}
