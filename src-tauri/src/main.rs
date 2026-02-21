#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use engine::{
    get_annotations, run_import_stage, set_annotations, AnnotationEdit, ImportStageOptions,
    ImportStageReport,
};

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

#[tauri::command]
fn run_import_stage_command(options: ImportStageOptions) -> Result<ImportStageReport, String> {
    run_import_stage(options).map_err(|error| error.to_string())
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            run_import_stage_command,
            get_annotations_command,
            set_annotations_command
        ])
        .run(tauri::generate_context!())
        .expect("failed to run bdr-anno-review tauri app");
}
