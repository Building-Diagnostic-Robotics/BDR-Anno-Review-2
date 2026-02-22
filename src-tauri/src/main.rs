#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager, State};

use engine::{
    export_coco, extract_frames_from_mp4_with_progress, generate_review_dataset_with_progress,
    get_annotations, init_empty_manifest, run_import_stage, set_annotations, AnnotationEdit,
    ExportCocoOptions, ExportCocoReport, ExtractFramesFromMp4Options, ExtractFramesFromMp4Report,
    FramesSource, GenerateReviewDatasetOptions, ImportStageOptions, ManifestInputs,
    ProjectionConfig, RenderConfig, ViewManifest,
};

const VIEW_MANIFEST_PATH: &str = "annotations/view_manifest.json";
const STAGING_WORKSPACE_PREFIX: &str = "bdr-anno-review-drop-";
const STAGING_REGISTRY_FILE: &str = "staging-workspaces.json";

#[derive(Default)]
struct AppState {
    annotation_cache: Mutex<HashMap<(String, String), Vec<AnnotationEdit>>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationProgressEvent {
    phase: String,
    detail: String,
    completed: usize,
    total: usize,
    percent: u8,
    elapsed_ms: u128,
}

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
    generated_at: String,
    faces: Vec<String>,
    render_size: u64,
    horizontal_fov_degrees: f64,
    min_projected_box_area: f64,
    quality_profile: Option<String>,
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
    skipped_existing_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateReviewDatasetResponse {
    written_manifest_path: String,
    face_count: usize,
    filtered_box_count: usize,
    extracted_frame_count: usize,
    skipped_existing_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ListFacesReport {
    dataset_root: String,
    faces: Vec<FaceListItem>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportStageRequest {
    dataset_root: String,
    coco_json_path: String,
    mp4_path: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportStageResponse {
    dataset_root: String,
    coco_json_path: String,
    mp4_path: String,
    image_count: usize,
    annotation_count: usize,
    category_count: usize,
    referenced_image_count: usize,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StageDroppedInputsRequest {
    paths: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StageDroppedInputsResponse {
    workspace_root: String,
    staged_dataset_root: Option<String>,
    staged_coco_json_path: Option<String>,
    staged_mp4_path: Option<String>,
    ignored_paths: Vec<String>,
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
struct StagingWorkspaceRegistry {
    workspaces: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupStagingWorkspacesResponse {
    removed_paths: Vec<String>,
    skipped_paths: Vec<String>,
}

#[tauri::command]
fn run_import_stage_command(options: ImportStageRequest) -> Result<ImportStageResponse, String> {
    let report = run_import_stage(ImportStageOptions {
        dataset_root: options.dataset_root,
        coco_json_path: options.coco_json_path,
        mp4_path: options.mp4_path,
    })
    .map_err(|error| error.to_string())?;

    Ok(ImportStageResponse {
        dataset_root: report.dataset_root,
        coco_json_path: report.coco_json_path,
        mp4_path: report.mp4_path,
        image_count: report.image_count,
        annotation_count: report.annotation_count,
        category_count: report.category_count,
        referenced_image_count: report.referenced_image_count,
    })
}

#[tauri::command]
fn open_dataset_command(
    state: State<AppState>,
    request: DatasetOpenRequest,
) -> Result<OpenDatasetReport, String> {
    let (dataset_root, manifest_path) = validate_manifest_request(&request.dataset_root)?;
    clear_annotation_cache_for_dataset(&state, &dataset_root)?;
    let dataset_root_path = PathBuf::from(&dataset_root);
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
    validate_face_image_paths(&dataset_root_path, &manifest.faces)?;

    Ok(OpenDatasetReport {
        dataset_root,
        manifest_path: manifest_path.display().to_string(),
        face_count: manifest.faces.len(),
    })
}

fn clear_annotation_cache_for_dataset(state: &AppState, dataset_root: &str) -> Result<(), String> {
    state
        .annotation_cache
        .lock()
        .map_err(|_| "annotation cache lock poisoned".to_owned())?
        .retain(|(cached_dataset_root, _), _| cached_dataset_root != dataset_root);
    Ok(())
}

#[tauri::command]
fn list_faces_command(request: DatasetOpenRequest) -> Result<ListFacesReport, String> {
    let (dataset_root, manifest_path) = validate_manifest_request(&request.dataset_root)?;
    let dataset_root_path = PathBuf::from(&dataset_root);
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
    validate_face_image_paths(&dataset_root_path, &manifest.faces)?;

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
        dataset_root,
        faces,
    })
}

fn validate_manifest_request(dataset_root_input: &str) -> Result<(String, PathBuf), String> {
    let dataset_root = dataset_root_input.trim();
    if dataset_root.is_empty() {
        return Err("missing required input: dataset_root".to_owned());
    }

    let dataset_root_path = PathBuf::from(dataset_root);
    if !dataset_root_path.is_dir() {
        return Err(format!(
            "dataset root directory does not exist: `{}`",
            dataset_root_path.display()
        ));
    }

    let manifest_path = dataset_root_path.join(VIEW_MANIFEST_PATH);
    if !manifest_path.is_file() {
        return Err(format!(
            "dataset is not initialized for review: missing `{}` under dataset root `{}`. Run Generate review dataset first.",
            VIEW_MANIFEST_PATH,
            dataset_root_path.display()
        ));
    }

    Ok((dataset_root.to_owned(), manifest_path))
}

fn validate_face_image_paths(
    dataset_root: &Path,
    faces: &[engine::FaceView],
) -> Result<(), String> {
    const SAMPLE_LIMIT: usize = 5;

    let mut missing = Vec::new();
    for face in faces {
        let image_path = normalize_manifest_image_path(&face.image_path);
        let resolved = if image_path.is_absolute() || is_windows_absolute_path(&face.image_path) {
            image_path
        } else {
            dataset_root.join(image_path)
        };

        if !resolved.is_file() {
            missing.push((face.face_id.clone(), resolved.display().to_string()));
        }
    }

    if missing.is_empty() {
        return Ok(());
    }

    let sample = missing
        .iter()
        .take(SAMPLE_LIMIT)
        .map(|(face_id, path)| format!("{face_id} -> `{path}`"))
        .collect::<Vec<_>>()
        .join("; ");

    let omitted_count = missing.len().saturating_sub(SAMPLE_LIMIT);
    let omitted_suffix = if omitted_count > 0 {
        format!("; ... and {omitted_count} more")
    } else {
        String::new()
    };

    Err(format!(
        "dataset preview files are missing: {} missing `faces[].image_path` target(s) under dataset root `{}`. Sample: {}{}",
        missing.len(),
        dataset_root.display(),
        sample,
        omitted_suffix
    ))
}

fn normalize_manifest_image_path(image_path: &str) -> PathBuf {
    PathBuf::from(image_path.replace('\\', "/"))
}

fn is_windows_absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

#[tauri::command]
fn get_annotations_command(
    state: State<AppState>,
    request: GetAnnotationsRequest,
) -> Result<Vec<AnnotationEdit>, String> {
    let key = (request.dataset_root.clone(), request.face_id.clone());
    if let Some(cached) = state
        .annotation_cache
        .lock()
        .map_err(|_| "annotation cache lock poisoned".to_owned())?
        .get(&key)
        .cloned()
    {
        return Ok(cached);
    }

    let edits = get_annotations(&request.dataset_root, &request.face_id)
        .map_err(|error| error.to_string())?;
    state
        .annotation_cache
        .lock()
        .map_err(|_| "annotation cache lock poisoned".to_owned())?
        .insert(key, edits.clone());
    Ok(edits)
}

#[tauri::command]
fn set_annotations_command(
    state: State<AppState>,
    request: SetAnnotationsRequest,
) -> Result<Vec<AnnotationEdit>, String> {
    let edits = set_annotations(&request.dataset_root, &request.face_id, request.edits)
        .map_err(|error| error.to_string())?;
    state
        .annotation_cache
        .lock()
        .map_err(|_| "annotation cache lock poisoned".to_owned())?
        .insert((request.dataset_root, request.face_id), edits.clone());
    Ok(edits)
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
async fn generate_review_dataset_command(
    app: AppHandle,
    state: State<'_, AppState>,
    request: GenerateReviewDatasetRequest,
) -> Result<GenerateReviewDatasetResponse, String> {
    let ffmpeg_bin = resolve_ffmpeg_binary(&app, "ffmpeg")?;
    let ffprobe_bin = resolve_ffmpeg_binary(&app, "ffprobe")?;
    let started = Instant::now();

    let profile_size = match request.quality_profile.as_deref() {
        Some("low") => 512,
        Some("balanced") => 768,
        _ => request.render_size,
    };

    let emit_progress = |phase: &str,
                         detail: &str,
                         completed: usize,
                         total: usize,
                         started: Instant,
                         app: &AppHandle| {
        let percent = if total == 0 {
            0
        } else {
            ((completed as f64 / total as f64) * 100.0)
                .round()
                .clamp(0.0, 100.0) as u8
        };
        let _ = app.emit(
            "generation-progress",
            GenerationProgressEvent {
                phase: phase.to_owned(),
                detail: detail.to_owned(),
                completed,
                total,
                percent,
                elapsed_ms: started.elapsed().as_millis(),
            },
        );
    };

    emit_progress("validating", "Validating inputs", 0, 1, started, &app);
    run_import_stage(ImportStageOptions {
        dataset_root: request.dataset_root.clone(),
        coco_json_path: request.coco_json_path.clone(),
        mp4_path: request.mp4_path.clone(),
    })
    .map_err(|error| error.to_string())?;

    let extraction_report = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let dataset_root = request.dataset_root.clone();
        let coco_json_path = request.coco_json_path.clone();
        let mp4_path = request.mp4_path.clone();
        move || {
            extract_frames_from_mp4_with_progress(
                ExtractFramesFromMp4Options {
                    dataset_root,
                    coco_json_path,
                    mp4_path,
                    ffmpeg_bin: Some(ffmpeg_bin),
                    ffprobe_bin: Some(ffprobe_bin),
                },
                |completed, total, phase| {
                    let detail = format!("Extracting source frames ({completed}/{total})");
                    let _ = app.emit(
                        "generation-progress",
                        GenerationProgressEvent {
                            phase: phase.to_owned(),
                            detail,
                            completed,
                            total,
                            percent: if total == 0 {
                                0
                            } else {
                                ((completed as f64 / total as f64) * 100.0)
                                    .round()
                                    .clamp(0.0, 100.0) as u8
                            },
                            elapsed_ms: started.elapsed().as_millis(),
                        },
                    );
                },
            )
        }
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;

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
            size: profile_size,
        },
        ProjectionConfig {
            horizontal_fov_degrees: request.horizontal_fov_degrees,
            min_projected_box_area: request.min_projected_box_area,
        },
    )
    .map_err(|error| error.to_string())?;

    let source_frames_dir = extraction_report.source_frames_dir.clone();
    let dataset_root = request.dataset_root.clone();
    let report = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            generate_review_dataset_with_progress(
                GenerateReviewDatasetOptions {
                    dataset_root,
                    source_frames_dir,
                    manifest,
                },
                |completed, total, _phase| {
                    let _ = app.emit(
                        "generation-progress",
                        GenerationProgressEvent {
                            phase: "rendering".to_owned(),
                            detail: format!("Rendering faces ({completed}/{total})"),
                            completed,
                            total,
                            percent: if total == 0 {
                                0
                            } else {
                                ((completed as f64 / total as f64) * 100.0)
                                    .round()
                                    .clamp(0.0, 100.0) as u8
                            },
                            elapsed_ms: started.elapsed().as_millis(),
                        },
                    );
                },
            )
        }
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;

    emit_progress("done", "Generation complete", 1, 1, started, &app);
    clear_annotation_cache_for_dataset(&state, &request.dataset_root)?;

    Ok(GenerateReviewDatasetResponse {
        written_manifest_path: report.written_manifest_path,
        face_count: report.rendered_face_count,
        filtered_box_count: report.filtered_box_count,
        extracted_frame_count: extraction_report.extracted_frame_count,
        skipped_existing_count: extraction_report.skipped_existing_count,
    })
}

#[tauri::command]
async fn extract_frames_from_mp4_command(
    app: AppHandle,
    request: ExtractFramesFromMp4Request,
) -> Result<ExtractFramesFromMp4Response, String> {
    let ffmpeg_bin = resolve_ffmpeg_binary(&app, "ffmpeg")?;
    let ffprobe_bin = resolve_ffmpeg_binary(&app, "ffprobe")?;

    let report: ExtractFramesFromMp4Report = tauri::async_runtime::spawn_blocking(move || {
        extract_frames_from_mp4_with_progress(
            ExtractFramesFromMp4Options {
                dataset_root: request.dataset_root,
                coco_json_path: request.coco_json_path,
                mp4_path: request.mp4_path,
                ffmpeg_bin: Some(ffmpeg_bin),
                ffprobe_bin: Some(ffprobe_bin),
            },
            |_, _, _| {},
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;

    Ok(ExtractFramesFromMp4Response {
        source_frames_dir: report.source_frames_dir,
        mp4_frame_count: report.mp4_frame_count,
        extracted_frame_count: report.extracted_frame_count,
        skipped_existing_count: report.skipped_existing_count,
    })
}

#[tauri::command]
fn stage_dropped_inputs_command(
    app: AppHandle,
    request: StageDroppedInputsRequest,
) -> Result<StageDroppedInputsResponse, String> {
    stage_dropped_inputs_inner(request, Some(&app))
}

fn stage_dropped_inputs_inner(
    request: StageDroppedInputsRequest,
    app: Option<&AppHandle>,
) -> Result<StageDroppedInputsResponse, String> {
    if request.paths.is_empty() {
        return Err("missing required input: paths".to_owned());
    }

    let workspace_root = create_staging_workspace()?;
    if let Some(app) = app {
        register_staging_workspace(app, &workspace_root)?;
    }
    let mut staged_dataset_root = None;
    let mut staged_coco_json_path = None;
    let mut staged_mp4_path = None;
    let mut ignored_paths = Vec::new();

    for raw in request.paths {
        let input = PathBuf::from(raw.trim());
        if raw.trim().is_empty() {
            continue;
        }
        if !input.exists() {
            return Err(format!(
                "dropped path does not exist: `{}`",
                input.display()
            ));
        }

        let file_name = input
            .file_name()
            .ok_or_else(|| format!("dropped path has no file name: `{}`", input.display()))?;
        let target = unique_target_path(&workspace_root, file_name);

        if input.is_dir() {
            copy_dir_recursive(&input, &target).map_err(|source| {
                format!(
                    "failed to copy dropped directory `{}`: {source}",
                    input.display()
                )
            })?;
            if staged_dataset_root.is_none() {
                staged_dataset_root = Some(target.display().to_string());
            }
            continue;
        }

        fs::copy(&input, &target).map_err(|source| {
            format!(
                "failed to copy dropped file `{}`: {source}",
                input.display()
            )
        })?;
        let lower = target.to_string_lossy().to_lowercase();
        if lower.ends_with(".json") && staged_coco_json_path.is_none() {
            staged_coco_json_path = Some(target.display().to_string());
        } else if lower.ends_with(".mp4") && staged_mp4_path.is_none() {
            staged_mp4_path = Some(target.display().to_string());
        } else {
            ignored_paths.push(target.display().to_string());
        }
    }

    Ok(StageDroppedInputsResponse {
        workspace_root: workspace_root.display().to_string(),
        staged_dataset_root,
        staged_coco_json_path,
        staged_mp4_path,
        ignored_paths,
    })
}

#[tauri::command]
fn cleanup_staging_workspaces_command(
    app: AppHandle,
) -> Result<CleanupStagingWorkspacesResponse, String> {
    cleanup_registered_staging_workspaces(&app)
}

fn create_staging_workspace() -> Result<PathBuf, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|source| source.to_string())?
        .as_nanos();
    let root = std::env::temp_dir().join(format!("{STAGING_WORKSPACE_PREFIX}{nanos}"));
    fs::create_dir_all(&root).map_err(|source| {
        format!(
            "failed to create staging workspace `{}`: {source}",
            root.display()
        )
    })?;
    Ok(root)
}

fn staging_registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .resolve(
            STAGING_REGISTRY_FILE,
            tauri::path::BaseDirectory::AppLocalData,
        )
        .map_err(|source| format!("failed to resolve staging registry path: {source}"))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| {
            format!(
                "failed to create staging registry parent directory `{}`: {source}",
                parent.display()
            )
        })?;
    }

    Ok(path)
}

fn load_staging_registry(path: &Path) -> Result<StagingWorkspaceRegistry, String> {
    if !path.exists() {
        return Ok(StagingWorkspaceRegistry::default());
    }

    let raw = fs::read_to_string(path).map_err(|source| {
        format!(
            "failed to read staging registry `{}`: {source}",
            path.display()
        )
    })?;
    serde_json::from_str(&raw).map_err(|source| {
        format!(
            "invalid staging registry JSON at `{}`: {source}",
            path.display()
        )
    })
}

fn save_staging_registry(path: &Path, registry: &StagingWorkspaceRegistry) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(registry)
        .map_err(|source| format!("failed to serialize staging registry: {source}"))?;
    fs::write(path, raw).map_err(|source| {
        format!(
            "failed to write staging registry `{}`: {source}",
            path.display()
        )
    })
}

fn is_owned_staging_workspace(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with(STAGING_WORKSPACE_PREFIX))
        .unwrap_or(false)
}

fn register_staging_workspace(app: &AppHandle, workspace_root: &Path) -> Result<(), String> {
    let registry_path = staging_registry_path(app)?;
    let mut registry = load_staging_registry(&registry_path)?;
    registry
        .workspaces
        .retain(|entry| Path::new(entry).exists() && is_owned_staging_workspace(Path::new(entry)));

    let workspace = workspace_root.display().to_string();
    if !registry
        .workspaces
        .iter()
        .any(|candidate| candidate == &workspace)
    {
        registry.workspaces.push(workspace);
    }

    save_staging_registry(&registry_path, &registry)
}

fn cleanup_registered_staging_workspaces(
    app: &AppHandle,
) -> Result<CleanupStagingWorkspacesResponse, String> {
    let registry_path = staging_registry_path(app)?;
    cleanup_registered_staging_workspaces_by_registry_path(&registry_path)
}

fn cleanup_registered_staging_workspaces_by_registry_path(
    registry_path: &Path,
) -> Result<CleanupStagingWorkspacesResponse, String> {
    let mut registry = load_staging_registry(registry_path)?;
    let mut removed_paths = Vec::new();
    let mut skipped_paths = Vec::new();
    let mut retained_paths = Vec::new();
    let mut errors = Vec::new();

    for entry in &registry.workspaces {
        let path = PathBuf::from(entry);
        if !is_owned_staging_workspace(&path) {
            skipped_paths.push(entry.clone());
            continue;
        }
        if !path.exists() {
            continue;
        }
        if !path.is_dir() {
            skipped_paths.push(entry.clone());
            continue;
        }

        if let Err(source) = fs::remove_dir_all(&path) {
            errors.push(format!(
                "failed to remove staging workspace `{}`: {source}",
                path.display()
            ));
            retained_paths.push(entry.clone());
            continue;
        }
        removed_paths.push(entry.clone());
    }

    registry.workspaces = retained_paths;
    save_staging_registry(registry_path, &registry)?;

    if !errors.is_empty() {
        return Err(errors.join("; "));
    }

    Ok(CleanupStagingWorkspacesResponse {
        removed_paths,
        skipped_paths,
    })
}

fn unique_target_path(root: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let mut candidate = root.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("input");
    let ext = Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let mut index = 1usize;
    loop {
        let name = if ext.is_empty() {
            format!("{stem}_{index}")
        } else {
            format!("{stem}_{index}.{ext}")
        };
        candidate = root.join(name);
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

fn copy_dir_recursive(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        let destination = target.join(entry.file_name());
        if metadata.file_type().is_symlink() {
            let resolved_metadata = fs::metadata(&path)?;
            if resolved_metadata.is_dir() {
                continue;
            }
        }

        if metadata.is_dir() {
            copy_dir_recursive(&path, &destination)?;
        } else {
            fs::copy(&path, &destination)?;
        }
    }
    Ok(())
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
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Err(error) = cleanup_registered_staging_workspaces(&app.handle()) {
                eprintln!("startup staging workspace cleanup failed: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_import_stage_command,
            open_dataset_command,
            list_faces_command,
            get_annotations_command,
            set_annotations_command,
            export_coco_command,
            generate_review_dataset_command,
            extract_frames_from_mp4_command,
            check_runtime_dependencies_command,
            stage_dropped_inputs_command,
            cleanup_staging_workspaces_command
        ])
        .build(tauri::generate_context!())
        .expect("failed to build bdr-anno-review tauri app")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Err(error) = cleanup_registered_staging_workspaces(app) {
                    eprintln!("exit staging workspace cleanup failed: {error}");
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_registered_staging_workspaces_by_registry_path, copy_dir_recursive,
        stage_dropped_inputs_inner, validate_face_image_paths, validate_manifest_request,
        ImportStageRequest, SetAnnotationsRequest, StageDroppedInputsRequest,
    };
    use engine::FaceView;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("bdr_anno_review_main_tests_{nanos}"))
    }

    #[test]
    fn import_stage_request_deserializes_camel_case_fields() {
        let raw = r#"{"datasetRoot":"/tmp/dataset","cocoJsonPath":"annotations/instances_default.json","mp4Path":"videos/source.mp4"}"#;
        let parsed: ImportStageRequest = serde_json::from_str(raw).unwrap();

        assert_eq!(parsed.dataset_root, "/tmp/dataset");
        assert_eq!(parsed.coco_json_path, "annotations/instances_default.json");
        assert_eq!(parsed.mp4_path, "videos/source.mp4");
    }

    #[test]
    fn set_annotations_request_accepts_camel_case_provenance_fields() {
        let raw = r#"{
            "datasetRoot":"/tmp/dataset",
            "faceId":"face-1",
            "edits":[{
                "bbox":[0.0,1.0,2.0,3.0],
                "provenance":{
                    "source":"ui_manual",
                    "updatedAt":"2026-01-01T00:00:00Z",
                    "sourceAnnotationId":42
                }
            }]
        }"#;

        let parsed: SetAnnotationsRequest = serde_json::from_str(raw).unwrap();

        assert_eq!(parsed.dataset_root, "/tmp/dataset");
        assert_eq!(parsed.face_id, "face-1");
        assert_eq!(parsed.edits.len(), 1);
        assert_eq!(
            parsed.edits[0].provenance.updated_at,
            "2026-01-01T00:00:00Z"
        );
        assert_eq!(parsed.edits[0].provenance.source_annotation_id, Some(42));
    }
    #[test]
    fn validate_manifest_request_reports_missing_manifest_with_actionable_message() {
        let dataset_root = unique_temp_dir();
        fs::create_dir_all(&dataset_root).unwrap();

        let err = validate_manifest_request(dataset_root.to_str().unwrap()).unwrap_err();
        assert!(err.contains("missing `annotations/view_manifest.json`"));
        assert!(err.contains("Run Generate review dataset first"));

        fs::remove_dir_all(&dataset_root).unwrap();
    }

    #[test]
    fn validate_face_image_paths_reports_missing_files_with_samples() {
        let dataset_root = unique_temp_dir();
        fs::create_dir_all(dataset_root.join("raw_frames")).unwrap();
        fs::write(dataset_root.join("raw_frames/face-ok.png"), "ok").unwrap();

        let faces = vec![
            FaceView {
                face_id: "face-ok".to_owned(),
                source_image_id: 1,
                face: "front".to_owned(),
                image_path: "raw_frames/face-ok.png".to_owned(),
                initial_boxes: Vec::new(),
            },
            FaceView {
                face_id: "face-missing".to_owned(),
                source_image_id: 1,
                face: "right".to_owned(),
                image_path: "raw_frames/face-missing.png".to_owned(),
                initial_boxes: Vec::new(),
            },
        ];

        let err = validate_face_image_paths(&dataset_root, &faces).unwrap_err();
        assert!(err.contains("dataset preview files are missing"));
        assert!(err.contains("1 missing `faces[].image_path` target(s)"));
        assert!(err.contains("face-missing ->"));
        assert!(err.contains("raw_frames/face-missing.png"));

        fs::remove_dir_all(&dataset_root).unwrap();
    }

    #[test]
    fn validate_face_image_paths_accepts_windows_style_relative_separators() {
        let dataset_root = unique_temp_dir();
        fs::create_dir_all(dataset_root.join("raw_frames")).unwrap();
        fs::write(dataset_root.join("raw_frames/face-ok.png"), "ok").unwrap();

        let faces = vec![FaceView {
            face_id: "face-ok".to_owned(),
            source_image_id: 1,
            face: "front".to_owned(),
            image_path: "raw_frames\\face-ok.png".to_owned(),
            initial_boxes: Vec::new(),
        }];

        validate_face_image_paths(&dataset_root, &faces).unwrap();

        fs::remove_dir_all(&dataset_root).unwrap();
    }

    #[test]
    fn stage_dropped_inputs_prefers_directory_for_dataset_root_and_reports_ignored_files() {
        let fixture_root = unique_temp_dir();
        fs::create_dir_all(&fixture_root).unwrap();

        let unsupported_path = fixture_root.join("notes.txt");
        fs::write(&unsupported_path, "not supported").unwrap();

        let dataset_root = fixture_root.join("dataset");
        fs::create_dir_all(&dataset_root).unwrap();
        fs::write(dataset_root.join("placeholder.txt"), "ok").unwrap();

        let response = stage_dropped_inputs_inner(
            StageDroppedInputsRequest {
                paths: vec![
                    unsupported_path.display().to_string(),
                    dataset_root.display().to_string(),
                ],
            },
            None,
        )
        .unwrap();

        assert!(response.staged_dataset_root.is_some());
        assert!(
            PathBuf::from(response.staged_dataset_root.unwrap()).is_dir(),
            "dataset root should always be a directory"
        );
        assert_eq!(response.ignored_paths.len(), 1);
        assert!(response.ignored_paths[0]
            .to_lowercase()
            .ends_with("notes.txt"));
        assert!(PathBuf::from(response.workspace_root).is_dir());

        fs::remove_dir_all(&fixture_root).unwrap();
    }

    #[test]
    fn cleanup_staging_workspaces_removes_owned_directories_and_skips_non_owned() {
        let fixture_root = unique_temp_dir();
        fs::create_dir_all(&fixture_root).unwrap();

        let owned = std::env::temp_dir().join(format!(
            "bdr-anno-review-drop-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let non_owned = fixture_root.join("not-owned");
        fs::create_dir_all(&owned).unwrap();
        fs::create_dir_all(&non_owned).unwrap();

        let registry_path = fixture_root.join("registry.json");
        fs::write(
            &registry_path,
            format!(
                r#"{{"workspaces":["{}","{}"]}}"#,
                owned.display(),
                non_owned.display()
            ),
        )
        .unwrap();

        let result =
            cleanup_registered_staging_workspaces_by_registry_path(&registry_path).unwrap();
        assert_eq!(result.removed_paths, vec![owned.display().to_string()]);
        assert_eq!(result.skipped_paths, vec![non_owned.display().to_string()]);
        assert!(!owned.exists());
        assert!(non_owned.exists());

        fs::remove_dir_all(&fixture_root).unwrap();
    }

    #[test]
    fn cleanup_staging_workspaces_prunes_missing_registry_entries() {
        let fixture_root = unique_temp_dir();
        fs::create_dir_all(&fixture_root).unwrap();
        let missing = std::env::temp_dir().join("bdr-anno-review-drop-does-not-exist");
        let registry_path = fixture_root.join("registry.json");
        fs::write(
            &registry_path,
            format!(r#"{{"workspaces":["{}"]}}"#, missing.display()),
        )
        .unwrap();

        let result =
            cleanup_registered_staging_workspaces_by_registry_path(&registry_path).unwrap();
        assert!(result.removed_paths.is_empty());
        assert!(result.skipped_paths.is_empty());
        let rewritten = fs::read_to_string(&registry_path).unwrap();
        assert_eq!(rewritten, "{\n  \"workspaces\": []\n}");

        fs::remove_dir_all(&fixture_root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn copy_dir_recursive_skips_symlinked_directories() {
        use std::os::unix::fs::symlink;

        let fixture_root = unique_temp_dir();
        let source = fixture_root.join("source");
        let nested = source.join("nested");
        let target = fixture_root.join("target");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("file.txt"), "ok").unwrap();

        symlink(&source, nested.join("loop")).unwrap();

        copy_dir_recursive(&source, &target).unwrap();

        assert!(target.join("nested").join("file.txt").is_file());
        assert!(!target.join("nested").join("loop").exists());

        fs::remove_dir_all(&fixture_root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn copy_dir_recursive_copies_symlinked_files() {
        use std::os::unix::fs::symlink;

        let fixture_root = unique_temp_dir();
        let source = fixture_root.join("source");
        let target = fixture_root.join("target");
        fs::create_dir_all(&source).unwrap();

        let real_file = fixture_root.join("shared.txt");
        fs::write(&real_file, "linked-content").unwrap();
        symlink(&real_file, source.join("linked.txt")).unwrap();

        copy_dir_recursive(&source, &target).unwrap();

        assert_eq!(
            fs::read_to_string(target.join("linked.txt")).unwrap(),
            "linked-content"
        );

        fs::remove_dir_all(&fixture_root).unwrap();
    }
}
