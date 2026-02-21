#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use engine::{run_import_stage, ImportStageOptions, ImportStageReport};

#[tauri::command]
fn run_import_stage_command(options: ImportStageOptions) -> Result<ImportStageReport, String> {
    run_import_stage(options).map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![run_import_stage_command])
        .run(tauri::generate_context!())
        .expect("failed to run bdr-anno-review tauri app");
}
