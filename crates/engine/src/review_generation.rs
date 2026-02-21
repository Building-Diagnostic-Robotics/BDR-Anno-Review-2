use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::{EngineError, FaceView, ProjectedBox, ProjectionConfig, ViewManifest};

const RAW_FRAMES_DIR: &str = "raw_frames";

#[derive(Debug, Clone, PartialEq)]
pub struct GenerateReviewDatasetOptions {
    pub dataset_root: String,
    pub source_frames_dir: String,
    pub manifest: ViewManifest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerateReviewDatasetReport {
    pub rendered_face_count: usize,
    pub filtered_box_count: usize,
    pub written_manifest_path: String,
}

#[derive(Debug, Deserialize)]
struct CocoDocument {
    images: Option<Vec<CocoImage>>,
    annotations: Option<Vec<CocoAnnotation>>,
}

#[derive(Debug, Deserialize)]
struct CocoImage {
    id: Option<u64>,
    file_name: Option<String>,
    width: Option<u64>,
    height: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct CocoAnnotation {
    id: Option<u64>,
    image_id: Option<u64>,
    bbox: Option<Vec<f64>>,
}

#[derive(Debug, Clone)]
struct SourceImage {
    file_name: String,
    width: u64,
    height: u64,
}

#[derive(Debug, Clone)]
struct SourceAnnotation {
    id: Option<u64>,
    bbox: [f64; 4],
}

#[derive(Debug, Clone, Copy)]
struct FaceOrientation {
    yaw_start: f64,
    yaw_end: f64,
}

pub fn generate_review_dataset(
    options: GenerateReviewDatasetOptions,
) -> Result<GenerateReviewDatasetReport, EngineError> {
    if options.dataset_root.trim().is_empty() {
        return Err(EngineError::MissingInput("dataset_root"));
    }
    if options.source_frames_dir.trim().is_empty() {
        return Err(EngineError::MissingInput("source_frames_dir"));
    }
    if options.manifest.inputs.coco_path.trim().is_empty() {
        return Err(EngineError::MissingInput("manifest.inputs.coco_path"));
    }
    if options.manifest.render.faces.is_empty() {
        return Err(EngineError::MissingInput("manifest.render.faces"));
    }
    if options.manifest.render.size == 0 {
        return Err(EngineError::MissingInput("manifest.render.size"));
    }

    let dataset_root = PathBuf::from(&options.dataset_root);
    if !dataset_root.is_dir() {
        return Err(EngineError::MissingFile {
            path: options.dataset_root,
            reason: "dataset root directory does not exist".to_owned(),
        });
    }

    let source_frames_dir = resolve_path(&dataset_root, &options.source_frames_dir);
    if !source_frames_dir.is_dir() {
        return Err(EngineError::MissingFile {
            path: source_frames_dir.display().to_string(),
            reason: "source frames directory does not exist".to_owned(),
        });
    }

    let coco_path = resolve_path(&dataset_root, &options.manifest.inputs.coco_path);
    ensure_file(&coco_path, "COCO annotation file")?;

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

    let mut images_by_id = BTreeMap::new();
    for (index, image) in images.into_iter().enumerate() {
        let image_id = image.id.ok_or_else(|| EngineError::InvalidCocoEntry {
            section: "images",
            index,
            reason: "missing required field `id`".to_owned(),
        })?;
        let file_name = image
            .file_name
            .ok_or_else(|| EngineError::InvalidCocoEntry {
                section: "images",
                index,
                reason: "missing required field `file_name`".to_owned(),
            })?;
        let width = image.width.ok_or_else(|| EngineError::InvalidCocoEntry {
            section: "images",
            index,
            reason: "missing required field `width`".to_owned(),
        })?;
        let height = image.height.ok_or_else(|| EngineError::InvalidCocoEntry {
            section: "images",
            index,
            reason: "missing required field `height`".to_owned(),
        })?;

        if width == 0 || height == 0 {
            return Err(EngineError::InvalidCocoEntry {
                section: "images",
                index,
                reason: "required fields `width` and `height` must be positive".to_owned(),
            });
        }

        if images_by_id
            .insert(
                image_id,
                SourceImage {
                    file_name,
                    width,
                    height,
                },
            )
            .is_some()
        {
            return Err(EngineError::InvalidCocoEntry {
                section: "images",
                index,
                reason: format!("duplicate image id `{image_id}`"),
            });
        }
    }

    let mut annotations_by_image_id: BTreeMap<u64, Vec<SourceAnnotation>> = BTreeMap::new();
    let mut referenced_image_ids = BTreeSet::new();

    for (index, annotation) in annotations.into_iter().enumerate() {
        let image_id = annotation
            .image_id
            .ok_or_else(|| EngineError::InvalidCocoEntry {
                section: "annotations",
                index,
                reason: "missing required field `image_id`".to_owned(),
            })?;

        if !images_by_id.contains_key(&image_id) {
            return Err(EngineError::BrokenAnnotationReference {
                annotation_index: index,
                annotation_id: annotation.id,
                image_id,
            });
        }

        let bbox_values = annotation
            .bbox
            .ok_or_else(|| EngineError::InvalidCocoEntry {
                section: "annotations",
                index,
                reason: "missing required field `bbox`".to_owned(),
            })?;

        if bbox_values.len() != 4 {
            return Err(EngineError::InvalidCocoEntry {
                section: "annotations",
                index,
                reason: "required field `bbox` must have exactly 4 numeric values".to_owned(),
            });
        }

        let bbox = [
            bbox_values[0],
            bbox_values[1],
            bbox_values[2],
            bbox_values[3],
        ];
        if bbox[2] <= 0.0 || bbox[3] <= 0.0 {
            return Err(EngineError::InvalidCocoEntry {
                section: "annotations",
                index,
                reason: "required field `bbox` must have positive width and height".to_owned(),
            });
        }

        annotations_by_image_id
            .entry(image_id)
            .or_default()
            .push(SourceAnnotation {
                id: annotation.id,
                bbox,
            });
        referenced_image_ids.insert(image_id);
    }

    let mut manifest = options.manifest;
    manifest.faces.clear();

    let raw_frames_dir = dataset_root.join(RAW_FRAMES_DIR);
    fs::create_dir_all(&raw_frames_dir).map_err(|source| EngineError::UnreadableFile {
        path: raw_frames_dir.display().to_string(),
        reason: format!("could not create output directory: {source}"),
    })?;

    let mut filtered_box_count = 0usize;

    for image_id in referenced_image_ids {
        let source_image = images_by_id
            .get(&image_id)
            .expect("referenced image should have been validated");
        let source_frame_path = source_frames_dir.join(&source_image.file_name);
        ensure_file(&source_frame_path, "source frame")?;

        let source_annotations = annotations_by_image_id
            .get(&image_id)
            .expect("referenced image annotations should exist");

        for face in &manifest.render.faces {
            let orientation = face_orientation(face)?;
            let mut initial_boxes = Vec::new();
            for annotation in source_annotations {
                if let Some(projected) = project_box_to_face(
                    annotation,
                    source_image,
                    orientation,
                    manifest.render.size,
                    &manifest.projection,
                ) {
                    initial_boxes.push(projected);
                } else {
                    filtered_box_count += 1;
                }
            }

            initial_boxes
                .sort_by(|left, right| left.source_annotation_id.cmp(&right.source_annotation_id));

            let face_id = build_face_id(
                image_id,
                &source_image.file_name,
                face,
                manifest.render.size,
                &manifest.projection,
            );
            let image_file_name = format!("{face_id}.png");
            let face_image_path = raw_frames_dir.join(&image_file_name);
            fs::copy(&source_frame_path, &face_image_path).map_err(|source| {
                EngineError::UnreadableFile {
                    path: face_image_path.display().to_string(),
                    reason: format!("could not write rendered face image: {source}"),
                }
            })?;

            manifest.faces.push(FaceView {
                face_id,
                source_image_id: image_id,
                face: face.clone(),
                image_path: format!("{RAW_FRAMES_DIR}/{image_file_name}"),
                initial_boxes,
            });
        }
    }

    let manifest_path = dataset_root.join("annotations/view_manifest.json");
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|source| {
        EngineError::InvalidConfiguration(format!("failed to serialize manifest JSON: {source}"))
    })?;
    fs::write(&manifest_path, manifest_json).map_err(|source| EngineError::UnreadableFile {
        path: manifest_path.display().to_string(),
        reason: format!("could not write manifest file: {source}"),
    })?;

    Ok(GenerateReviewDatasetReport {
        rendered_face_count: manifest.faces.len(),
        filtered_box_count,
        written_manifest_path: manifest_path.display().to_string(),
    })
}

fn project_box_to_face(
    annotation: &SourceAnnotation,
    image: &SourceImage,
    orientation: FaceOrientation,
    render_size: u64,
    projection: &ProjectionConfig,
) -> Option<ProjectedBox> {
    let img_w = image.width as f64;
    let img_h = image.height as f64;

    let x0 = annotation.bbox[0];
    let y0 = annotation.bbox[1];
    let x1 = x0 + annotation.bbox[2];
    let y1 = y0 + annotation.bbox[3];

    let cx = (x0 + x1) / 2.0;
    let center_yaw = normalize_yaw((cx / img_w) * 360.0 - 180.0);
    let half_fov = projection.horizontal_fov_degrees / 2.0;

    if !contains_yaw(
        center_yaw,
        orientation.yaw_start - half_fov,
        orientation.yaw_end + half_fov,
    ) {
        return None;
    }

    let left = ((x0 / img_w) * render_size as f64).clamp(0.0, render_size as f64);
    let right = ((x1 / img_w) * render_size as f64).clamp(0.0, render_size as f64);
    let top = ((y0 / img_h) * render_size as f64).clamp(0.0, render_size as f64);
    let bottom = ((y1 / img_h) * render_size as f64).clamp(0.0, render_size as f64);

    let width = (right - left).max(0.0);
    let height = (bottom - top).max(0.0);
    if width <= 0.0 || height <= 0.0 {
        return None;
    }
    if (width * height) < projection.min_projected_box_area {
        return None;
    }

    Some(ProjectedBox {
        source_annotation_id: annotation.id,
        bbox: [left, top, width, height],
    })
}

fn face_orientation(face: &str) -> Result<FaceOrientation, EngineError> {
    match face {
        "front" => Ok(FaceOrientation {
            yaw_start: -45.0,
            yaw_end: 45.0,
        }),
        "right" => Ok(FaceOrientation {
            yaw_start: 45.0,
            yaw_end: 135.0,
        }),
        "back" => Ok(FaceOrientation {
            yaw_start: 135.0,
            yaw_end: -135.0,
        }),
        "left" => Ok(FaceOrientation {
            yaw_start: -135.0,
            yaw_end: -45.0,
        }),
        _ => Err(EngineError::InvalidConfiguration(format!(
            "render.faces contains unsupported face `{face}`; expected one of front/right/back/left"
        ))),
    }
}

fn contains_yaw(value: f64, start: f64, end: f64) -> bool {
    let value = normalize_yaw(value);
    let start = normalize_yaw(start);
    let end = normalize_yaw(end);

    if start <= end {
        value >= start && value <= end
    } else {
        value >= start || value <= end
    }
}

fn normalize_yaw(value: f64) -> f64 {
    let mut normalized = value;
    while normalized > 180.0 {
        normalized -= 360.0;
    }
    while normalized < -180.0 {
        normalized += 360.0;
    }
    normalized
}

fn build_face_id(
    source_image_id: u64,
    source_file_name: &str,
    face: &str,
    render_size: u64,
    projection: &ProjectionConfig,
) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source_image_id.hash(&mut hasher);
    source_file_name.hash(&mut hasher);
    face.hash(&mut hasher);
    render_size.hash(&mut hasher);
    projection
        .horizontal_fov_degrees
        .to_bits()
        .hash(&mut hasher);
    projection
        .min_projected_box_area
        .to_bits()
        .hash(&mut hasher);
    format!("face_{:016x}", hasher.finish())
}

fn resolve_path(dataset_root: &Path, path: &str) -> PathBuf {
    let path_buf = PathBuf::from(path);
    if path_buf.is_absolute() {
        path_buf
    } else {
        dataset_root.join(path_buf)
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
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::{
        init_empty_manifest, FramesSource, ManifestInputs, ProjectionConfig, RenderConfig,
    };

    use super::{generate_review_dataset, GenerateReviewDatasetOptions};

    fn unique_temp_dir() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("engine-review-generation-{nanos}"))
    }

    fn setup_dataset() -> GenerateReviewDatasetOptions {
        let root = unique_temp_dir();
        let annotations_dir = root.join("annotations");
        let source_frames_dir = root.join("source_frames");

        fs::create_dir_all(&annotations_dir).unwrap();
        fs::create_dir_all(&source_frames_dir).unwrap();

        fs::write(
            annotations_dir.join("instances_default.json"),
            r#"{
                "images": [
                    {"id": 2, "file_name": "frame_0002.png", "width": 2048, "height": 1024},
                    {"id": 1, "file_name": "frame_0001.png", "width": 2048, "height": 1024}
                ],
                "annotations": [
                    {"id": 22, "image_id": 2, "bbox": [1500, 100, 200, 100]},
                    {"id": 11, "image_id": 1, "bbox": [100, 50, 300, 200]}
                ]
            }"#,
        )
        .unwrap();

        fs::write(source_frames_dir.join("frame_0001.png"), b"f1").unwrap();
        fs::write(source_frames_dir.join("frame_0002.png"), b"f2").unwrap();

        let manifest = init_empty_manifest(
            "2026-01-01T00:00:00Z",
            ManifestInputs {
                coco_path: "annotations/instances_default.json".to_owned(),
                frames_source: FramesSource::Dir {
                    path: "source_frames".to_owned(),
                },
            },
            RenderConfig {
                faces: vec![
                    "front".to_owned(),
                    "right".to_owned(),
                    "back".to_owned(),
                    "left".to_owned(),
                ],
                size: 1024,
            },
            ProjectionConfig {
                horizontal_fov_degrees: 90.0,
                min_projected_box_area: 4.0,
            },
        )
        .unwrap();

        GenerateReviewDatasetOptions {
            dataset_root: root.display().to_string(),
            source_frames_dir: "source_frames".to_owned(),
            manifest,
        }
    }

    #[test]
    fn generation_is_deterministic_for_manifest_order_and_face_ids() {
        let options = setup_dataset();
        let first = generate_review_dataset(options.clone()).unwrap();
        let second = generate_review_dataset(options.clone()).unwrap();

        assert_eq!(first.rendered_face_count, 8);
        assert_eq!(first.filtered_box_count, 4);
        assert_eq!(first.written_manifest_path, second.written_manifest_path);

        let manifest_content = fs::read_to_string(&first.written_manifest_path).unwrap();
        let manifest: crate::ViewManifest = serde_json::from_str(&manifest_content).unwrap();

        let order: Vec<(u64, &str)> = manifest
            .faces
            .iter()
            .map(|item| (item.source_image_id, item.face.as_str()))
            .collect();
        assert_eq!(
            order,
            vec![
                (1, "front"),
                (1, "right"),
                (1, "back"),
                (1, "left"),
                (2, "front"),
                (2, "right"),
                (2, "back"),
                (2, "left"),
            ]
        );

        let ids_first: Vec<String> = manifest
            .faces
            .iter()
            .map(|item| item.face_id.clone())
            .collect();

        generate_review_dataset(options).unwrap();
        let manifest_again_content = fs::read_to_string(&first.written_manifest_path).unwrap();
        let manifest_again: crate::ViewManifest =
            serde_json::from_str(&manifest_again_content).unwrap();
        let ids_second: Vec<String> = manifest_again
            .faces
            .iter()
            .map(|item| item.face_id.clone())
            .collect();
        assert_eq!(ids_first, ids_second);
    }

    #[test]
    fn fails_loudly_when_required_inputs_are_missing() {
        let options = setup_dataset();
        fs::remove_file(
            PathBuf::from(&options.dataset_root)
                .join("source_frames")
                .join("frame_0001.png"),
        )
        .unwrap();

        let err = generate_review_dataset(options).unwrap_err();
        let message = err.to_string();
        assert!(message.contains("source frame not found"));
        assert!(message.contains("frame_0001.png"));
    }
}
