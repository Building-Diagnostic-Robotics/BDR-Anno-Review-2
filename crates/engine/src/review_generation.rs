use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ImageBuffer, ImageEncoder, Rgba};
use rayon::prelude::*;
use serde::Deserialize;

use crate::{
    frame_sourcing::resolve_frame_index, EngineError, FaceView, FramesSource, ProjectedBox,
    ProjectionConfig, ViewManifest,
};

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
    frame_index: Option<u64>,
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
    frame_index: Option<u64>,
    width: u64,
    height: u64,
}

#[derive(Debug, Clone)]
struct SourceAnnotation {
    id: Option<u64>,
    bbox: [f64; 4],
}

#[derive(Debug)]
struct ParallelImageResult {
    image_id: u64,
    faces: Vec<FaceView>,
    filtered_box_count: usize,
}

#[derive(Debug, Clone, Copy)]
struct FaceOrientation {
    yaw_start: f64,
    yaw_end: f64,
    yaw_center: f64,
}

pub fn generate_review_dataset(
    options: GenerateReviewDatasetOptions,
) -> Result<GenerateReviewDatasetReport, EngineError> {
    generate_review_dataset_with_progress(options, |_, _, _| {})
}

pub fn generate_review_dataset_with_progress<F>(
    options: GenerateReviewDatasetOptions,
    on_progress: F,
) -> Result<GenerateReviewDatasetReport, EngineError>
where
    F: FnMut(usize, usize, &str) + Send,
{
    generate_review_dataset_with_progress_and_cancel(options, on_progress, || false)
}

pub fn generate_review_dataset_with_progress_and_cancel<F, C>(
    options: GenerateReviewDatasetOptions,
    on_progress: F,
    should_cancel: C,
) -> Result<GenerateReviewDatasetReport, EngineError>
where
    F: FnMut(usize, usize, &str) + Send,
    C: Fn() -> bool + Sync,
{
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
                    frame_index: image.frame_index,
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
    let render_faces = manifest.render.faces.clone();
    let render_size = manifest.render.size;
    let projection = manifest.projection.clone();
    manifest.faces.clear();

    let raw_frames_dir = dataset_root.join(RAW_FRAMES_DIR);
    fs::create_dir_all(&raw_frames_dir).map_err(|source| EngineError::UnreadableFile {
        path: raw_frames_dir.display().to_string(),
        reason: format!("could not create output directory: {source}"),
    })?;

    let referenced_image_ids: Vec<u64> = referenced_image_ids.into_iter().collect();
    let total_work = referenced_image_ids.len() * render_faces.len();

    let completed_work = AtomicUsize::new(0);
    let progress = Mutex::new(on_progress);
    {
        let mut progress_cb = progress.lock().expect("progress callback lock poisoned");
        progress_cb(0, total_work.max(1), "rendering");
    }

    let cancelled = AtomicBool::new(false);
    let results: Vec<ParallelImageResult> = referenced_image_ids
        .par_iter()
        .map(|image_id| -> Result<ParallelImageResult, EngineError> {
            if cancelled.load(Ordering::Relaxed) || should_cancel() {
                cancelled.store(true, Ordering::Relaxed);
                return Err(EngineError::Cancelled("review rendering"));
            }

            let source_image = images_by_id
                .get(image_id)
                .expect("referenced image should have been validated");
            let source_frame_path = resolve_source_frame_path(
                &manifest.inputs.frames_source,
                &source_frames_dir,
                source_image,
                *image_id,
            )?;
            ensure_file(&source_frame_path, "source frame")?;

            let source_annotations = annotations_by_image_id
                .get(image_id)
                .expect("referenced image annotations should exist");

            let decoded_source_image = image::open(&source_frame_path)
                .map_err(|source| EngineError::UnreadableFile {
                    path: source_frame_path.display().to_string(),
                    reason: format!("could not read source frame image: {source}"),
                })?
                .to_rgba8();

            let mut image_faces = Vec::new();
            let mut filtered_box_count = 0usize;
            let face_orientations: Vec<FaceOrientation> = render_faces
                .iter()
                .map(|face| face_orientation(face))
                .collect::<Result<Vec<_>, _>>()?;

            let annotation_owner_faces: Vec<Option<usize>> = source_annotations
                .iter()
                .map(|annotation| owner_face_index(annotation, source_image, &face_orientations))
                .collect();

            for (face_index, face) in render_faces.iter().enumerate() {
                if cancelled.load(Ordering::Relaxed) || should_cancel() {
                    cancelled.store(true, Ordering::Relaxed);
                    return Err(EngineError::Cancelled("review rendering"));
                }

                let orientation = face_orientations[face_index];
                let mut initial_boxes = Vec::new();
                for (annotation_index, annotation) in source_annotations.iter().enumerate() {
                    if annotation_owner_faces[annotation_index] != Some(face_index) {
                        filtered_box_count += 1;
                        continue;
                    }
                    if let Some(projected) = project_box_to_face(
                        annotation,
                        source_image,
                        orientation,
                        render_size,
                        &projection,
                    ) {
                        initial_boxes.push(projected);
                    } else {
                        filtered_box_count += 1;
                    }
                }

                initial_boxes.sort_by(|left, right| {
                    left.source_annotation_id.cmp(&right.source_annotation_id)
                });

                if !initial_boxes.is_empty() {
                    let face_id = build_face_id(
                        *image_id,
                        &source_image.file_name,
                        face,
                        render_size,
                        &projection,
                    );
                    let image_file_name = format!("{face_id}.png");
                    let face_image_path = raw_frames_dir.join(&image_file_name);
                    render_face_projection(
                        &decoded_source_image,
                        &face_image_path,
                        face,
                        render_size,
                        projection.horizontal_fov_degrees,
                    )?;

                    image_faces.push(FaceView {
                        face_id,
                        source_image_id: *image_id,
                        face: face.clone(),
                        image_path: format!("{RAW_FRAMES_DIR}/{image_file_name}"),
                        initial_boxes,
                    });
                }

                let done = completed_work.fetch_add(1, Ordering::Relaxed) + 1;
                let mut progress_cb = progress.lock().expect("progress callback lock poisoned");
                progress_cb(done, total_work.max(1), "rendering");
            }

            Ok(ParallelImageResult {
                image_id: *image_id,
                faces: image_faces,
                filtered_box_count,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut filtered_box_count = 0usize;
    let mut ordered_faces = Vec::new();
    let face_order: BTreeMap<&str, usize> = render_faces
        .iter()
        .enumerate()
        .map(|(index, face)| (face.as_str(), index))
        .collect();

    let mut results = results;
    results.sort_by_key(|result| result.image_id);
    for mut result in results {
        filtered_box_count += result.filtered_box_count;
        result.faces.sort_by_key(|face| {
            face_order
                .get(face.face.as_str())
                .copied()
                .unwrap_or(usize::MAX)
        });
        ordered_faces.extend(result.faces);
    }
    manifest.faces = ordered_faces;
    let manifest_path = dataset_root.join("annotations/view_manifest.json");
    let manifest_parent = manifest_path.parent().ok_or_else(|| {
        EngineError::InvalidConfiguration(format!(
            "invalid manifest output path `{}`",
            manifest_path.display()
        ))
    })?;
    fs::create_dir_all(manifest_parent).map_err(|source| EngineError::UnreadableFile {
        path: manifest_parent.display().to_string(),
        reason: format!("could not create manifest directory: {source}"),
    })?;

    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|source| {
        EngineError::InvalidConfiguration(format!("failed to serialize manifest JSON: {source}"))
    })?;
    fs::write(&manifest_path, manifest_json).map_err(|source| EngineError::UnreadableFile {
        path: manifest_path.display().to_string(),
        reason: format!("could not write manifest file: {source}"),
    })?;

    let mut progress_cb = progress.lock().expect("progress callback lock poisoned");
    progress_cb(total_work.max(1), total_work.max(1), "rendering");

    Ok(GenerateReviewDatasetReport {
        rendered_face_count: manifest.faces.len(),
        filtered_box_count,
        written_manifest_path: manifest_path.display().to_string(),
    })
}

fn render_face_projection(
    source_image: &ImageBuffer<Rgba<u8>, Vec<u8>>,
    face_image_path: &Path,
    face: &str,
    render_size: u64,
    horizontal_fov_degrees: f64,
) -> Result<(), EngineError> {
    let source_width = source_image.width();
    let source_height = source_image.height();

    let render_size_u32 = u32::try_from(render_size).map_err(|_| {
        EngineError::InvalidConfiguration(format!(
            "render.size value `{render_size}` exceeds max supported size {}",
            u32::MAX
        ))
    })?;

    let face_center_yaw = face_center_yaw(face)?;
    let mut face_pixels = ImageBuffer::<Rgba<u8>, Vec<u8>>::new(render_size_u32, render_size_u32);

    let h_fov_rad = horizontal_fov_degrees.to_radians();
    let tan_half_fov = (h_fov_rad / 2.0).tan();
    let v_fov_rad = h_fov_rad;
    let tan_half_v_fov = (v_fov_rad / 2.0).tan();
    let yaw_rotation = face_center_yaw.to_radians();
    let cos_yaw = yaw_rotation.cos();
    let sin_yaw = yaw_rotation.sin();

    let width_f = source_width as f64;
    let height_f = source_height as f64;
    let render_size_f = render_size as f64;

    let x_world_components: Vec<(f64, f64)> = (0..render_size_u32)
        .map(|x| {
            let x_ndc = ((x as f64 + 0.5) / render_size_f) * 2.0 - 1.0;
            let cam_x = x_ndc * tan_half_fov;
            let world_x = cos_yaw * cam_x + sin_yaw;
            let world_z = -sin_yaw * cam_x + cos_yaw;
            (world_x, world_z)
        })
        .collect();

    for y in 0..render_size_u32 {
        let y_ndc = 1.0 - ((y as f64 + 0.5) / render_size_f) * 2.0;
        let world_y = y_ndc * tan_half_v_fov;

        for x in 0..render_size_u32 {
            let (world_x, world_z) = x_world_components[x as usize];

            let lon = world_x.atan2(world_z);
            let hyp = (world_x * world_x + world_z * world_z).sqrt();
            let lat = world_y.atan2(hyp);

            let src_x = ((lon / (2.0 * std::f64::consts::PI)) + 0.5) * width_f;
            let src_y = (0.5 - (lat / std::f64::consts::PI)) * height_f;

            let src_x = src_x.rem_euclid(width_f).floor() as u32;
            let src_y = src_y.clamp(0.0, height_f - 1.0).floor() as u32;

            *face_pixels.get_pixel_mut(x, y) = *source_image.get_pixel(src_x, src_y);
        }
    }

    let file = fs::File::create(face_image_path).map_err(|source| EngineError::UnreadableFile {
        path: face_image_path.display().to_string(),
        reason: format!("could not create rendered face image: {source}"),
    })?;
    let encoder = PngEncoder::new_with_quality(file, CompressionType::Fast, FilterType::NoFilter);
    encoder
        .write_image(
            face_pixels.as_raw(),
            render_size_u32,
            render_size_u32,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|source| EngineError::UnreadableFile {
            path: face_image_path.display().to_string(),
            reason: format!("could not write rendered face image: {source}"),
        })
}

fn project_box_to_face(
    annotation: &SourceAnnotation,
    image: &SourceImage,
    orientation: FaceOrientation,
    render_size: u64,
    projection: &ProjectionConfig,
) -> Option<ProjectedBox> {
    let render_size_f = render_size as f64;

    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut visible_points = 0usize;

    for (sample_x, sample_y) in sample_annotation_perimeter(annotation) {
        if let Some((px, py)) = project_equirectangular_point_to_face(
            sample_x,
            sample_y,
            image,
            orientation,
            projection.horizontal_fov_degrees,
            render_size_f,
        ) {
            min_x = min_x.min(px);
            min_y = min_y.min(py);
            max_x = max_x.max(px);
            max_y = max_y.max(py);
            visible_points += 1;
        }
    }

    if visible_points == 0 {
        return None;
    }

    let left = min_x.clamp(0.0, render_size_f);
    let right = max_x.clamp(0.0, render_size_f);
    let top = min_y.clamp(0.0, render_size_f);
    let bottom = max_y.clamp(0.0, render_size_f);

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

fn owner_face_index(
    annotation: &SourceAnnotation,
    image: &SourceImage,
    orientations: &[FaceOrientation],
) -> Option<usize> {
    if orientations.is_empty() {
        return None;
    }

    let center_yaw = annotation_center_yaw(annotation, image);

    let mut best: Option<(usize, f64)> = None;
    for (index, orientation) in orientations.iter().enumerate() {
        if contains_yaw_half_open(center_yaw, orientation.yaw_start, orientation.yaw_end) {
            let delta = angular_distance_degrees(center_yaw, orientation.yaw_center);
            match best {
                Some((_, best_delta)) if best_delta <= delta => {}
                _ => best = Some((index, delta)),
            }
        }
    }

    if let Some((index, _)) = best {
        return Some(index);
    }

    orientations
        .iter()
        .enumerate()
        .map(|(index, orientation)| {
            (
                index,
                angular_distance_degrees(center_yaw, orientation.yaw_center),
            )
        })
        .min_by(|(_, left_delta), (_, right_delta)| left_delta.total_cmp(right_delta))
        .map(|(index, _)| index)
}

fn sample_annotation_perimeter(annotation: &SourceAnnotation) -> Vec<(f64, f64)> {
    const EDGE_SEGMENTS: usize = 64;

    let x0 = annotation.bbox[0];
    let y0 = annotation.bbox[1];
    let x1 = x0 + annotation.bbox[2];
    let y1 = y0 + annotation.bbox[3];

    let mut points = Vec::with_capacity(EDGE_SEGMENTS * 6);
    for index in 0..=EDGE_SEGMENTS {
        let t = index as f64 / EDGE_SEGMENTS as f64;
        let x = x0 + (x1 - x0) * t;
        let y = y0 + (y1 - y0) * t;
        points.push((x, y0));
        points.push((x, y1));
        points.push((x0, y));
        points.push((x1, y));
    }

    points.push(((x0 + x1) / 2.0, (y0 + y1) / 2.0));
    points
}

fn annotation_center_yaw(annotation: &SourceAnnotation, image: &SourceImage) -> f64 {
    let img_w = image.width as f64;
    let x_center = annotation.bbox[0] + annotation.bbox[2] / 2.0;
    normalize_yaw((x_center / img_w) * 360.0 - 180.0)
}

fn project_equirectangular_point_to_face(
    source_x: f64,
    source_y: f64,
    image: &SourceImage,
    orientation: FaceOrientation,
    horizontal_fov_degrees: f64,
    render_size: f64,
) -> Option<(f64, f64)> {
    let img_w = image.width as f64;
    let img_h = image.height as f64;

    let x_wrapped = source_x.rem_euclid(img_w);
    let y_clamped = source_y.clamp(0.0, img_h);

    let lon = ((x_wrapped / img_w) * 2.0 * std::f64::consts::PI) - std::f64::consts::PI;
    let lat = std::f64::consts::FRAC_PI_2 - ((y_clamped / img_h) * std::f64::consts::PI);

    let world_x = lat.cos() * lon.sin();
    let world_y = lat.sin();
    let world_z = lat.cos() * lon.cos();

    let yaw_rotation = orientation.yaw_center.to_radians();
    let cos_yaw = yaw_rotation.cos();
    let sin_yaw = yaw_rotation.sin();

    let cam_x = cos_yaw * world_x - sin_yaw * world_z;
    let cam_z = sin_yaw * world_x + cos_yaw * world_z;
    let cam_y = world_y;

    if cam_z <= 0.0 {
        return None;
    }

    let tan_half_fov = (horizontal_fov_degrees.to_radians() / 2.0).tan();
    let x_ndc = cam_x / (cam_z * tan_half_fov);
    let y_ndc = cam_y / (cam_z * tan_half_fov);

    if x_ndc.abs() > 1.0 || y_ndc.abs() > 1.0 {
        return None;
    }

    let px = ((x_ndc + 1.0) / 2.0) * render_size;
    let py = ((1.0 - y_ndc) / 2.0) * render_size;
    Some((px, py))
}

fn face_orientation(face: &str) -> Result<FaceOrientation, EngineError> {
    match face {
        "front" => Ok(FaceOrientation {
            yaw_start: -45.0,
            yaw_end: 45.0,
            yaw_center: 0.0,
        }),
        "right" => Ok(FaceOrientation {
            yaw_start: 45.0,
            yaw_end: 135.0,
            yaw_center: 90.0,
        }),
        "back" => Ok(FaceOrientation {
            yaw_start: 135.0,
            yaw_end: -135.0,
            yaw_center: 180.0,
        }),
        "left" => Ok(FaceOrientation {
            yaw_start: -135.0,
            yaw_end: -45.0,
            yaw_center: -90.0,
        }),
        _ => Err(EngineError::InvalidConfiguration(format!(
            "render.faces contains unsupported face `{face}`; expected one of front/right/back/left"
        ))),
    }
}

fn face_center_yaw(face: &str) -> Result<f64, EngineError> {
    match face {
        "front" => Ok(0.0),
        "right" => Ok(90.0),
        "back" => Ok(180.0),
        "left" => Ok(-90.0),
        _ => Err(EngineError::InvalidConfiguration(format!(
            "render.faces contains unsupported face `{face}`; expected one of front/right/back/left"
        ))),
    }
}

fn contains_yaw_half_open(value: f64, start: f64, end: f64) -> bool {
    let value = normalize_yaw(value);
    let start = normalize_yaw(start);
    let end = normalize_yaw(end);

    if start <= end {
        value >= start && value < end
    } else {
        value >= start || value < end
    }
}

fn angular_distance_degrees(a: f64, b: f64) -> f64 {
    let delta = (normalize_yaw(a) - normalize_yaw(b)).abs();
    delta.min(360.0 - delta)
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

fn resolve_source_frame_path(
    frames_source: &FramesSource,
    source_frames_dir: &Path,
    source_image: &SourceImage,
    image_id: u64,
) -> Result<PathBuf, EngineError> {
    match frames_source {
        FramesSource::Dir { .. } => Ok(source_frames_dir.join(&source_image.file_name)),
        FramesSource::Mp4 { .. } => {
            let frame_index =
                resolve_frame_index(source_image.frame_index, &source_image.file_name, image_id)?;
            Ok(source_frames_dir.join(format!("frame_{frame_index:06}.png")))
        }
    }
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
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use std::hash::{Hash, Hasher};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use image::{ImageBuffer, Rgba};

    use crate::{
        init_empty_manifest, FramesSource, ManifestInputs, ProjectionConfig, RenderConfig,
    };

    use super::{
        generate_review_dataset, owner_face_index, project_box_to_face, FaceOrientation,
        GenerateReviewDatasetOptions, SourceAnnotation, SourceImage,
    };

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
                    {"id": 22, "image_id": 2, "bbox": [1500, 420, 200, 100]},
                    {"id": 11, "image_id": 1, "bbox": [100, 420, 300, 200]}
                ]
            }"#,
        )
        .unwrap();

        write_test_frame(&source_frames_dir.join("frame_0001.png"), 2048, 1024, 0);
        write_test_frame(&source_frames_dir.join("frame_0002.png"), 2048, 1024, 37);

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

    fn setup_dataset_without_annotations_dir() -> GenerateReviewDatasetOptions {
        let root = unique_temp_dir();
        let source_frames_dir = root.join("source_frames");
        let metadata_dir = root.join("metadata");

        fs::create_dir_all(&source_frames_dir).unwrap();
        fs::create_dir_all(&metadata_dir).unwrap();
        fs::write(
            metadata_dir.join("instances_default.json"),
            r#"{
                "images": [
                    {"id": 1, "file_name": "frame_0001.png", "width": 2048, "height": 1024}
                ],
                "annotations": [
                    {"id": 11, "image_id": 1, "bbox": [100, 420, 300, 200]}
                ]
            }"#,
        )
        .unwrap();
        write_test_frame(&source_frames_dir.join("frame_0001.png"), 2048, 1024, 0);

        let manifest = init_empty_manifest(
            "2026-01-01T00:00:00Z",
            ManifestInputs {
                coco_path: "metadata/instances_default.json".to_owned(),
                frames_source: FramesSource::Dir {
                    path: "source_frames".to_owned(),
                },
            },
            RenderConfig {
                faces: vec!["front".to_owned()],
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

    fn setup_dataset_mp4_frames() -> GenerateReviewDatasetOptions {
        let root = unique_temp_dir();
        let annotations_dir = root.join("annotations");
        let source_frames_dir = root.join("derived_frames/frame_sourcing");

        fs::create_dir_all(&annotations_dir).unwrap();
        fs::create_dir_all(&source_frames_dir).unwrap();

        fs::write(
            annotations_dir.join("instances_default.json"),
            r#"{
                "images": [
                    {"id": 1, "file_name": "cam0_frame_0001.jpg", "frame_index": 1, "width": 2048, "height": 1024},
                    {"id": 2, "file_name": "cam0_frame_0002.jpg", "frame_index": 2, "width": 2048, "height": 1024}
                ],
                "annotations": [
                    {"id": 11, "image_id": 1, "bbox": [100, 420, 300, 200]},
                    {"id": 22, "image_id": 2, "bbox": [1500, 420, 200, 100]}
                ]
            }"#,
        )
        .unwrap();

        write_test_frame(&source_frames_dir.join("frame_000001.png"), 2048, 1024, 0);
        write_test_frame(&source_frames_dir.join("frame_000002.png"), 2048, 1024, 37);

        let manifest = init_empty_manifest(
            "2026-01-01T00:00:00Z",
            ManifestInputs {
                coco_path: "annotations/instances_default.json".to_owned(),
                frames_source: FramesSource::Mp4 {
                    path: "videos/source.mp4".to_owned(),
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
            source_frames_dir: "derived_frames/frame_sourcing".to_owned(),
            manifest,
        }
    }

    fn write_test_frame(path: &PathBuf, width: u32, height: u32, phase: u32) {
        let mut image = ImageBuffer::<Rgba<u8>, Vec<u8>>::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let r = ((x + phase) % 256) as u8;
                let g = ((y + phase * 2) % 256) as u8;
                let b = (((x / 8) + (y / 4) + phase) % 256) as u8;
                image.put_pixel(x, y, Rgba([r, g, b, 255]));
            }
        }
        image.save(path).unwrap();
    }

    #[test]
    fn generation_is_deterministic_for_manifest_order_and_face_ids() {
        let options = setup_dataset();
        let first = generate_review_dataset(options.clone()).unwrap();
        let second = generate_review_dataset(options.clone()).unwrap();

        assert_eq!(first.rendered_face_count, 2);
        assert_eq!(first.filtered_box_count, 6);
        assert_eq!(first.written_manifest_path, second.written_manifest_path);

        let manifest_content = fs::read_to_string(&first.written_manifest_path).unwrap();
        let manifest: crate::ViewManifest = serde_json::from_str(&manifest_content).unwrap();

        let order: Vec<(u64, &str)> = manifest
            .faces
            .iter()
            .map(|item| (item.source_image_id, item.face.as_str()))
            .collect();
        assert_eq!(order, vec![(1, "back"), (2, "right"),]);

        let ids_first: Vec<String> = manifest
            .faces
            .iter()
            .map(|item| item.face_id.clone())
            .collect();

        generate_review_dataset(options.clone()).unwrap();
        let manifest_again_content = fs::read_to_string(&first.written_manifest_path).unwrap();
        let manifest_again: crate::ViewManifest =
            serde_json::from_str(&manifest_again_content).unwrap();
        let ids_second: Vec<String> = manifest_again
            .faces
            .iter()
            .map(|item| item.face_id.clone())
            .collect();
        assert_eq!(ids_first, ids_second);

        let mut hashes_by_face = BTreeMap::new();
        for face in manifest
            .faces
            .iter()
            .filter(|face| face.source_image_id == 1)
        {
            let image_path = PathBuf::from(&options.dataset_root).join(&face.image_path);
            let rendered = image::open(image_path).unwrap().to_rgba8();
            assert_eq!(rendered.width(), 1024);
            assert_eq!(rendered.height(), 1024);

            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            rendered.as_raw().hash(&mut hasher);
            hashes_by_face.insert(face.face.clone(), hasher.finish());
        }

        assert_eq!(hashes_by_face.len(), 1);
        let unique_hashes: BTreeSet<u64> = hashes_by_face.values().copied().collect();
        assert_eq!(unique_hashes.len(), 1);
    }

    #[test]
    fn creates_annotations_dir_before_writing_manifest() {
        let options = setup_dataset_without_annotations_dir();
        let dataset_root = PathBuf::from(&options.dataset_root);

        let report = generate_review_dataset(options).unwrap();

        assert!(dataset_root.join("annotations").is_dir());
        assert!(PathBuf::from(report.written_manifest_path).is_file());
    }

    #[cfg(windows)]
    #[test]
    fn supports_windows_style_relative_paths() {
        let mut options = setup_dataset();
        options.source_frames_dir = "source_frames\\".to_owned();
        options.manifest.inputs.coco_path = "annotations\\instances_default.json".to_owned();

        let report = generate_review_dataset(options).unwrap();
        assert!(PathBuf::from(report.written_manifest_path).is_file());
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

    #[test]
    fn supports_mp4_frame_sourcing_convention() {
        let options = setup_dataset_mp4_frames();

        let report = generate_review_dataset(options.clone()).unwrap();
        assert_eq!(report.rendered_face_count, 2);

        let manifest_content = fs::read_to_string(&report.written_manifest_path).unwrap();
        let manifest: crate::ViewManifest = serde_json::from_str(&manifest_content).unwrap();
        assert_eq!(manifest.faces.len(), 2);
    }

    #[test]
    fn falls_back_to_nearest_rendered_owner_face_for_subset_renders() {
        let image = SourceImage {
            file_name: "frame.png".to_owned(),
            frame_index: None,
            width: 2048,
            height: 1024,
        };
        let front_only = vec![FaceOrientation {
            yaw_start: -45.0,
            yaw_end: 45.0,
            yaw_center: 0.0,
        }];

        let right_centered = SourceAnnotation {
            id: Some(1),
            bbox: [1470.0, 320.0, 120.0, 120.0],
        };

        assert_eq!(
            owner_face_index(&right_centered, &image, &front_only),
            Some(0)
        );
    }

    #[test]
    fn assigns_owner_face_without_adjacent_duplication() {
        let image = SourceImage {
            file_name: "frame.png".to_owned(),
            frame_index: None,
            width: 2048,
            height: 1024,
        };
        let orientations = vec![
            FaceOrientation {
                yaw_start: -45.0,
                yaw_end: 45.0,
                yaw_center: 0.0,
            },
            FaceOrientation {
                yaw_start: 45.0,
                yaw_end: 135.0,
                yaw_center: 90.0,
            },
            FaceOrientation {
                yaw_start: 135.0,
                yaw_end: -135.0,
                yaw_center: 180.0,
            },
            FaceOrientation {
                yaw_start: -135.0,
                yaw_end: -45.0,
                yaw_center: -90.0,
            },
        ];

        let front = SourceAnnotation {
            id: Some(1),
            bbox: [1000.0, 200.0, 100.0, 100.0],
        };
        let right = SourceAnnotation {
            id: Some(2),
            bbox: [1500.0, 200.0, 100.0, 100.0],
        };
        let left = SourceAnnotation {
            id: Some(3),
            bbox: [500.0, 200.0, 100.0, 100.0],
        };

        assert_eq!(owner_face_index(&front, &image, &orientations), Some(0));
        assert_eq!(owner_face_index(&right, &image, &orientations), Some(1));
        assert_eq!(owner_face_index(&left, &image, &orientations), Some(3));
    }

    #[test]
    fn projection_is_face_relative_not_identical_between_faces() {
        let image = SourceImage {
            file_name: "frame.png".to_owned(),
            frame_index: None,
            width: 2048,
            height: 1024,
        };
        let annotation = SourceAnnotation {
            id: Some(10),
            bbox: [1300.0, 400.0, 240.0, 120.0],
        };
        let projection = ProjectionConfig {
            horizontal_fov_degrees: 90.0,
            min_projected_box_area: 4.0,
        };

        let front_orientation = FaceOrientation {
            yaw_start: -45.0,
            yaw_end: 45.0,
            yaw_center: 0.0,
        };
        let right_orientation = FaceOrientation {
            yaw_start: 45.0,
            yaw_end: 135.0,
            yaw_center: 90.0,
        };

        let front = project_box_to_face(&annotation, &image, front_orientation, 1024, &projection);
        let right = project_box_to_face(&annotation, &image, right_orientation, 1024, &projection)
            .expect("bbox should be visible on right face");

        assert!(front.is_none());
        assert!(right.bbox[0] >= 0.0 && right.bbox[0] <= 1024.0);
        assert!(right.bbox[1] >= 0.0 && right.bbox[1] <= 1024.0);
        assert!(right.bbox[2] > 0.0);
        assert!(right.bbox[3] > 0.0);
    }
    #[test]
    fn reports_missing_extracted_mp4_frame_with_deterministic_name() {
        let options = setup_dataset_mp4_frames();
        fs::remove_file(
            PathBuf::from(&options.dataset_root)
                .join("derived_frames/frame_sourcing")
                .join("frame_000001.png"),
        )
        .unwrap();

        let err = generate_review_dataset(options).unwrap_err();
        let message = err.to_string();
        assert!(message.contains("source frame not found"));
        assert!(message.contains("frame_000001.png"));
    }
}
