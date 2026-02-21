#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;

use engine::{
    export_coco, get_annotations, run_import_stage, set_annotations, AnnotationEdit,
    ExportCocoOptions, ExportCocoReport, ImportStageOptions, ImportStageReport, ViewManifest,
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            run_import_stage_command,
            open_dataset_command,
            list_faces_command,
            get_annotations_command,
            set_annotations_command,
            export_coco_command
        ])
        .run(tauri::generate_context!())
        .expect("failed to run bdr-anno-review tauri app");
}
