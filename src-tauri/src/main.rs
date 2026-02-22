#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager};

use engine::{
    export_coco, extract_frames_from_mp4, generate_review_dataset, get_annotations,
    init_empty_manifest, run_import_stage, set_annotations, AnnotationEdit, ExportCocoOptions,
    ExportCocoReport, ExtractFramesFromMp4Options, ExtractFramesFromMp4Report, FramesSource,
    GenerateReviewDatasetOptions, GenerateReviewDatasetReport, ImportStageOptions,
    ImportStageReport, ManifestInputs, ProjectionConfig, RenderConfig, ViewManifest,
};

const VIEW_MANIFEST_PATH: &str = "annotations/view_manifest.json";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDependencyStatus {
    name: String,
    resolved_path: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDependencyReport {
    ffmpeg: RuntimeDependencyStatus,
    ffprobe: RuntimeDependencyStatus,
}

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
    app: AppHandle,
    request: ExtractFramesFromMp4Request,
) -> Result<ExtractFramesFromMp4Response, String> {
    let ffmpeg_bin = resolve_ffmpeg_binary(&app, "ffmpeg")?;
    let ffprobe_bin = resolve_ffmpeg_binary(&app, "ffprobe")?;

    let report: ExtractFramesFromMp4Report = extract_frames_from_mp4(ExtractFramesFromMp4Options {
        dataset_root: request.dataset_root,
        coco_json_path: request.coco_json_path,
        mp4_path: request.mp4_path,
        ffmpeg_bin: Some(ffmpeg_bin),
        ffprobe_bin: Some(ffprobe_bin),
    })
    .map_err(|error| error.to_string())?;

    Ok(ExtractFramesFromMp4Response {
        source_frames_dir: report.source_frames_dir,
        mp4_frame_count: report.mp4_frame_count,
        extracted_frame_count: report.extracted_frame_count,
    })
}

#[tauri::command]
fn check_runtime_dependencies_command(app: AppHandle) -> Result<RuntimeDependencyReport, String> {
    let ffmpeg = resolve_ffmpeg_binary(&app, "ffmpeg")?;
    let ffprobe = resolve_ffmpeg_binary(&app, "ffprobe")?;

    Ok(RuntimeDependencyReport {
        ffmpeg: RuntimeDependencyStatus {
            name: "ffmpeg".to_owned(),
            resolved_path: ffmpeg,
        },
        ffprobe: RuntimeDependencyStatus {
            name: "ffprobe".to_owned(),
            resolved_path: ffprobe,
        },
    })
}

fn resolve_ffmpeg_binary(app: &AppHandle, binary_name: &str) -> Result<String, String> {
    let sidecar_resolution = resolve_sidecar_binary(app, binary_name);

    if let Some(sidecar) = sidecar_resolution.resolved_path {
        verify_binary_executable(&sidecar).map_err(|source| {
            format!(
                "runtime dependency `{binary_name}` sidecar is present but unusable at `{}`: {source}. Repackage the app with a valid executable sidecar",
                sidecar.display()
            )
        })?;

        return Ok(sidecar.display().to_string());
    }

    let tool = binary_name.to_owned();
    verify_binary_executable(Path::new(&tool)).map_err(|source| {
        format!(
            "runtime dependency `{binary_name}` is unavailable: {source}. Install ffmpeg/ffprobe or include sidecar binaries in the app bundle. Sidecar lookup candidates checked: {}",
            format_sidecar_candidates(&sidecar_resolution.candidate_paths)
        )
    })?;
    Ok(tool)
}

#[derive(Debug)]
struct SidecarResolution {
    resolved_path: Option<PathBuf>,
    candidate_paths: Vec<PathBuf>,
}

fn resolve_sidecar_binary(app: &AppHandle, binary_name: &str) -> SidecarResolution {
    let mut candidates = Vec::new();

    for sidecar_name in sidecar_binary_names(binary_name) {
        for resource_name in sidecar_resource_names(&sidecar_name) {
            if let Ok(sidecar_path) = app
                .path()
                .resolve(&resource_name, tauri::path::BaseDirectory::Resource)
            {
                candidates.push(sidecar_path);
            }
        }

        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(exe_dir) = current_exe.parent() {
                candidates.push(exe_dir.join(&sidecar_name));
                candidates.push(exe_dir.join("binaries").join(&sidecar_name));
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            candidates.push(PathBuf::from(format!(
                "/usr/lib/bdr-anno-review/bin/{sidecar_name}"
            )));
            candidates.push(PathBuf::from(format!(
                "/usr/lib/bdr-anno-review/bin/binaries/{sidecar_name}"
            )));
        }
    }

    let resolved_path = candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .cloned();

    SidecarResolution {
        resolved_path,
        candidate_paths: candidates,
    }
}

fn format_sidecar_candidates(candidates: &[PathBuf]) -> String {
    if candidates.is_empty() {
        return "(none)".to_owned();
    }

    candidates
        .iter()
        .map(|path| format!("`{}`", path.display()))
        .collect::<Vec<String>>()
        .join(", ")
}

fn sidecar_resource_names(sidecar_name: &str) -> Vec<String> {
    vec![sidecar_name.to_owned(), format!("binaries/{sidecar_name}")]
}

fn sidecar_binary_names(binary_name: &str) -> Vec<String> {
    let mut names = Vec::new();

    #[cfg(target_os = "windows")]
    {
        names.push(format!("{binary_name}.exe"));
        names.push(format!("{binary_name}-x86_64-pc-windows-msvc.exe"));
    }

    #[cfg(target_os = "linux")]
    {
        names.push(binary_name.to_owned());
        names.push(format!("{binary_name}-x86_64-unknown-linux-gnu"));
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        names.push(binary_name.to_owned());
    }

    names
}

fn command_no_window(path_or_name: &Path) -> Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut command = Command::new(path_or_name);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new(path_or_name)
    }
}

fn verify_binary_executable(path_or_name: &Path) -> Result<(), String> {
    let output = command_no_window(path_or_name)
        .arg("-version")
        .output()
        .map_err(|source| source.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            run_import_stage_command,
            open_dataset_command,
            list_faces_command,
            get_annotations_command,
            set_annotations_command,
            export_coco_command,
            generate_review_dataset_command,
            extract_frames_from_mp4_command,
            check_runtime_dependencies_command
        ])
        .run(tauri::generate_context!())
        .expect("failed to run bdr-anno-review tauri app");
}
