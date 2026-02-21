use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MANIFEST_VERSION: &str = "1";

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("missing required input: {0}")]
    MissingInput(&'static str),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ViewManifest {
    pub schema_version: String,
    pub generated_at: String,
    pub faces: Vec<FaceView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FaceView {
    pub face_id: String,
    pub source_image_id: u64,
    pub face: String,
    pub image_path: String,
}

pub fn init_empty_manifest(generated_at: &str) -> Result<ViewManifest, EngineError> {
    if generated_at.trim().is_empty() {
        return Err(EngineError::MissingInput("generated_at"));
    }

    Ok(ViewManifest {
        schema_version: MANIFEST_VERSION.to_owned(),
        generated_at: generated_at.to_owned(),
        faces: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_manifest_requires_timestamp() {
        let err = init_empty_manifest("").unwrap_err();
        assert_eq!(err.to_string(), "missing required input: generated_at");
    }

    #[test]
    fn init_manifest_sets_schema_version() {
        let manifest = init_empty_manifest("2026-01-01T00:00:00Z").unwrap();
        assert_eq!(manifest.schema_version, MANIFEST_VERSION);
        assert!(manifest.faces.is_empty());
    }
}
