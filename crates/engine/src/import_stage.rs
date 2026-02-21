use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::EngineError;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ImportStageOptions {
    pub dataset_root: String,
    pub coco_json_path: String,
    pub mp4_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ImportStageReport {
    pub dataset_root: String,
    pub coco_json_path: String,
    pub mp4_path: String,
    pub image_count: usize,
    pub annotation_count: usize,
    pub category_count: usize,
    pub referenced_image_count: usize,
}

#[derive(Debug, Deserialize)]
struct CocoDocument {
    images: Option<Vec<CocoImage>>,
    annotations: Option<Vec<CocoAnnotation>>,
    categories: Option<Vec<CocoCategory>>,
}

#[derive(Debug, Deserialize)]
struct CocoImage {
    id: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct CocoAnnotation {
    id: Option<u64>,
    image_id: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct CocoCategory {
    #[allow(dead_code)]
    id: Option<u64>,
}

pub fn run_import_stage(options: ImportStageOptions) -> Result<ImportStageReport, EngineError> {
    if options.dataset_root.trim().is_empty() {
        return Err(EngineError::MissingInput("dataset_root"));
    }
    if options.coco_json_path.trim().is_empty() {
        return Err(EngineError::MissingInput("coco_json_path"));
    }
    if options.mp4_path.trim().is_empty() {
        return Err(EngineError::MissingInput("mp4_path"));
    }

    let dataset_root = PathBuf::from(&options.dataset_root);
    if !dataset_root.is_dir() {
        return Err(EngineError::MissingFile {
            path: options.dataset_root,
            reason: "dataset root directory does not exist".to_owned(),
        });
    }

    let coco_path = resolve_path(&dataset_root, &options.coco_json_path);
    let mp4_path = resolve_path(&dataset_root, &options.mp4_path);

    ensure_extension(&coco_path, "json", "COCO annotation file")?;
    ensure_extension(&mp4_path, "mp4", "video file")?;
    ensure_file(&coco_path, "COCO annotation file")?;
    ensure_file(&mp4_path, "MP4 video")?;

    let coco_raw =
        fs::read_to_string(&coco_path).map_err(|source| EngineError::UnreadableFile {
            path: coco_path.display().to_string(),
            reason: source.to_string(),
        })?;

    let coco: CocoDocument =
        serde_json::from_str(&coco_raw).map_err(|source| EngineError::InvalidCoco {
            path: coco_path.display().to_string(),
            reason: source.to_string(),
        })?;

    let images = require_section(coco.images, "images")?;
    let annotations = require_section(coco.annotations, "annotations")?;
    let categories = require_section(coco.categories, "categories")?;

    let mut image_ids = HashSet::with_capacity(images.len());
    for (index, image) in images.iter().enumerate() {
        let image_id = image.id.ok_or_else(|| EngineError::InvalidCocoEntry {
            section: "images",
            index,
            reason: "missing required field `id`".to_owned(),
        })?;

        if !image_ids.insert(image_id) {
            return Err(EngineError::InvalidCocoEntry {
                section: "images",
                index,
                reason: format!("duplicate image id `{image_id}`"),
            });
        }
    }

    let mut referenced_image_ids = HashSet::new();
    for (index, annotation) in annotations.iter().enumerate() {
        let image_id = annotation
            .image_id
            .ok_or_else(|| EngineError::InvalidCocoEntry {
                section: "annotations",
                index,
                reason: "missing required field `image_id`".to_owned(),
            })?;

        if !image_ids.contains(&image_id) {
            return Err(EngineError::BrokenAnnotationReference {
                annotation_index: index,
                annotation_id: annotation.id,
                image_id,
            });
        }

        referenced_image_ids.insert(image_id);
    }

    Ok(ImportStageReport {
        dataset_root: dataset_root.display().to_string(),
        coco_json_path: coco_path.display().to_string(),
        mp4_path: mp4_path.display().to_string(),
        image_count: images.len(),
        annotation_count: annotations.len(),
        category_count: categories.len(),
        referenced_image_count: referenced_image_ids.len(),
    })
}

fn resolve_path(dataset_root: &Path, path: &str) -> PathBuf {
    let path_buf = PathBuf::from(path);
    if path_buf.is_absolute() {
        path_buf
    } else {
        dataset_root.join(path_buf)
    }
}

fn ensure_extension(
    path: &Path,
    expected_extension: &'static str,
    field_name: &'static str,
) -> Result<(), EngineError> {
    let extension_matches = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case(expected_extension))
        .unwrap_or(false);

    if extension_matches {
        Ok(())
    } else {
        Err(EngineError::UnsupportedFormat {
            field: field_name,
            expected: expected_extension,
            actual_path: path.display().to_string(),
        })
    }
}

fn ensure_file(path: &Path, field_name: &'static str) -> Result<(), EngineError> {
    if path.is_file() {
        Ok(())
    } else {
        Err(EngineError::MissingFile {
            path: path.display().to_string(),
            reason: format!("{field_name} not found"),
        })
    }
}

fn require_section<T>(
    section: Option<Vec<T>>,
    section_name: &'static str,
) -> Result<Vec<T>, EngineError> {
    let values = section.ok_or(EngineError::MissingCocoSection(section_name))?;
    if values.is_empty() {
        Err(EngineError::EmptyCocoSection(section_name))
    } else {
        Ok(values)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{run_import_stage, ImportStageOptions};

    fn unique_temp_dir() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("engine-import-stage-{nanos}"))
    }

    fn setup_dataset(coco_contents: &str) -> ImportStageOptions {
        let root = unique_temp_dir();
        let annotations_dir = root.join("annotations");
        let videos_dir = root.join("videos");

        fs::create_dir_all(&annotations_dir).unwrap();
        fs::create_dir_all(&videos_dir).unwrap();

        fs::write(
            annotations_dir.join("instances_default.json"),
            coco_contents,
        )
        .unwrap();
        fs::write(videos_dir.join("source.mp4"), b"fake-mp4").unwrap();

        ImportStageOptions {
            dataset_root: root.display().to_string(),
            coco_json_path: "annotations/instances_default.json".to_owned(),
            mp4_path: "videos/source.mp4".to_owned(),
        }
    }

    #[test]
    fn validates_successful_import_stage() {
        let options = setup_dataset(
            r#"{
                "images": [{"id": 1}, {"id": 2}],
                "annotations": [{"id": 10, "image_id": 1}],
                "categories": [{"id": 1}]
            }"#,
        );

        let result = run_import_stage(options).unwrap();
        assert_eq!(result.image_count, 2);
        assert_eq!(result.annotation_count, 1);
        assert_eq!(result.category_count, 1);
        assert_eq!(result.referenced_image_count, 1);
    }

    #[test]
    fn fails_on_broken_annotation_references() {
        let options = setup_dataset(
            r#"{
                "images": [{"id": 1}],
                "annotations": [{"id": 22, "image_id": 999}],
                "categories": [{"id": 1}]
            }"#,
        );

        let err = run_import_stage(options).unwrap_err();
        assert_eq!(
            err.to_string(),
            "annotation reference is broken: annotation index 0 (id Some(22)) points to missing image_id 999"
        );
    }

    #[test]
    fn fails_when_required_sections_are_empty() {
        let options = setup_dataset(
            r#"{
                "images": [],
                "annotations": [{"id": 22, "image_id": 1}],
                "categories": [{"id": 1}]
            }"#,
        );

        let err = run_import_stage(options).unwrap_err();
        assert_eq!(err.to_string(), "required COCO section is empty: images");
    }
}
