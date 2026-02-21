#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;

use engine::{
    export_coco, extract_frames_from_mp4, generate_review_dataset, get_annotations,
    init_empty_manifest, run_import_stage, set_annotations, AnnotationEdit, ExportCocoOptions,
    ExportCocoReport, ExtractFramesFromMp4Options, ExtractFramesFromMp4Report, FramesSource,
    GenerateReviewDatasetOptions, GenerateReviewDatasetReport, ImportStageOptions,
    ImportStageReport, ManifestInputs, ProjectionConfig, RenderConfig, ViewManifest,
};

const VIEW_MANIFEST_PATH: &str = "annotations/view_manifest.json";

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetAnnotationsRequest {
    dataset_root: String,
    face_id: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetAnnotationsRequest {
    dataset_root: String,
    face_id: String,
    edits: Vec<AnnotationEdit>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatasetOpenRequest {
    dataset_root: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FaceListItem {
    face_id: String,
    face: String,
    image_path: String,
    initial_box_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenDatasetReport {
    dataset_root: String,
    manifest_path: String,
    face_count: usize,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportCocoRequest {
    dataset_root: String,
    output_path: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportCocoResponse {
    output_path: String,
    image_count: usize,
    annotation_count: usize,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateReviewDatasetRequest {
    dataset_root: String,
    coco_json_path: String,
    mp4_path: String,
    source_frames_dir: String,
    generated_at: String,
    faces: Vec<String>,
    render_size: u64,
    horizontal_fov_degrees: f64,
    min_projected_box_area: f64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractFramesFromMp4Request {
    dataset_root: String,
    coco_json_path: String,
    mp4_path: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractFramesFromMp4Response {
    source_frames_dir: String,
    mp4_frame_count: u64,
    extracted_frame_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateReviewDatasetResponse {
    written_manifest_path: String,
    face_count: usize,
    filtered_box_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ListFacesReport {
    dataset_root: String,
    faces: Vec<FaceListItem>,
}

#[tauri::command]
fn run_import_stage_command(options: ImportStageOptions) -> Result<ImportStageReport, String> {
    run_import_stage(options).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_dataset_command(request: DatasetOpenRequest) -> Result<OpenDatasetReport, String> {
    let dataset_root = request.dataset_root.trim();
    if dataset_root.is_empty() {
        return Err("missing required input: dataset_root".to_owned());
    }

    let manifest_path = PathBuf::from(dataset_root).join(VIEW_MANIFEST_PATH);
    let raw = fs::read_to_string(&manifest_path).map_err(|source| {
        format!(
            "could not read file `{}`: {source}",
            manifest_path.display()
        )
    })?;

    let manifest: ViewManifest = serde_json::from_str(&raw).map_err(|source| {
        format!(
            "invalid view manifest JSON at `{}`: {source}",
            manifest_path.display()
        )
    })?;

    Ok(OpenDatasetReport {
        dataset_root: dataset_root.to_owned(),
        manifest_path: manifest_path.display().to_string(),
        face_count: manifest.faces.len(),
    })
}

#[tauri::command]
fn list_faces_command(request: DatasetOpenRequest) -> Result<ListFacesReport, String> {
    let dataset_root = request.dataset_root.trim();
    if dataset_root.is_empty() {
        return Err("missing required input: dataset_root".to_owned());
    }

    let manifest_path = PathBuf::from(dataset_root).join(VIEW_MANIFEST_PATH);
    let raw = fs::read_to_string(&manifest_path).map_err(|source| {
        format!(
            "could not read file `{}`: {source}",
            manifest_path.display()
        )
    })?;
    let manifest: ViewManifest = serde_json::from_str(&raw).map_err(|source| {
        format!(
            "invalid view manifest JSON at `{}`: {source}",
            manifest_path.display()
        )
    })?;

    let faces = manifest
        .faces
        .into_iter()
        .map(|face| FaceListItem {
            face_id: face.face_id,
            face: face.face,
            image_path: face.image_path,
            initial_box_count: face.initial_boxes.len(),
        })
        .collect();

    Ok(ListFacesReport {
        dataset_root: dataset_root.to_owned(),
        faces,
    })
}

#[tauri::command]
fn get_annotations_command(request: GetAnnotationsRequest) -> Result<Vec<AnnotationEdit>, String> {
    get_annotations(&request.dataset_root, &request.face_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_annotations_command(request: SetAnnotationsRequest) -> Result<Vec<AnnotationEdit>, String> {
    set_annotations(&request.dataset_root, &request.face_id, request.edits)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn export_coco_command(request: ExportCocoRequest) -> Result<ExportCocoResponse, String> {
    let report: ExportCocoReport = export_coco(ExportCocoOptions {
        dataset_root: request.dataset_root,
        output_path: request.output_path,
    })
    .map_err(|error| error.to_string())?;

    Ok(ExportCocoResponse {
        output_path: report.output_path,
        image_count: report.image_count,
        annotation_count: report.annotation_count,
    })
}

#[tauri::command]
fn generate_review_dataset_command(
    request: GenerateReviewDatasetRequest,
) -> Result<GenerateReviewDatasetResponse, String> {
    let manifest = init_empty_manifest(
        &request.generated_at,
        ManifestInputs {
            coco_path: request.coco_json_path,
            frames_source: FramesSource::Mp4 {
                path: request.mp4_path,
            },
        },
        RenderConfig {
            faces: request.faces,
            size: request.render_size,
        },
        ProjectionConfig {
            horizontal_fov_degrees: request.horizontal_fov_degrees,
            min_projected_box_area: request.min_projected_box_area,
        },
    )
    .map_err(|error| error.to_string())?;

    let report: GenerateReviewDatasetReport =
        generate_review_dataset(GenerateReviewDatasetOptions {
            dataset_root: request.dataset_root,
            source_frames_dir: request.source_frames_dir,
            manifest,
        })
        .map_err(|error| error.to_string())?;

    Ok(GenerateReviewDatasetResponse {
        written_manifest_path: report.written_manifest_path,
        face_count: report.rendered_face_count,
        filtered_box_count: report.filtered_box_count,
    })
}

#[tauri::command]
fn extract_frames_from_mp4_command(
    request: ExtractFramesFromMp4Request,
) -> Result<ExtractFramesFromMp4Response, String> {
    let report: ExtractFramesFromMp4Report = extract_frames_from_mp4(ExtractFramesFromMp4Options {
        dataset_root: request.dataset_root,
        coco_json_path: request.coco_json_path,
        mp4_path: request.mp4_path,
        ffmpeg_bin: None,
        ffprobe_bin: None,
    })
    .map_err(|error| error.to_string())?;

    Ok(ExtractFramesFromMp4Response {
        source_frames_dir: report.source_frames_dir,
        mp4_frame_count: report.mp4_frame_count,
        extracted_frame_count: report.extracted_frame_count,
    })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            run_import_stage_command,
            open_dataset_command,
            list_faces_command,
            get_annotations_command,
            set_annotations_command,
            export_coco_command,
            generate_review_dataset_command,
            extract_frames_from_mp4_command
        ])
        .run(tauri::generate_context!())
        .expect("failed to run bdr-anno-review tauri app");
}
