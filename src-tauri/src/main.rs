#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

mod llm;
mod settings;
mod suggestion_signature;
mod suggestion_store;

use llm::{
    generate_suggestions_with_retry, QueueStateResponse, SuggestionQueue,
    SuggestionQueuePrefetchRequest, SuggestionRequest, SuggestionResponse,
};
use settings::{
    anthropic_key, clear_provider_key, get_settings_response, load_settings, openai_key,
    save_settings_request, set_provider_key, LlmSettings, LlmSettingsResponse, ProviderKeyRequest,
    SaveLlmSettingsRequest, SetProviderKeyRequest,
};
use suggestion_signature::{compute_suggestion_signature, SuggestionSignatureInput};
use suggestion_store::{
    complete_job, ensure_schema, has_active_job, has_ready_suggestion, insert_jobs_if_missing,
    lease_next_job, load_ready_suggestion, mark_suggestion_failed, readiness_snapshot,
    recently_failed, upsert_suggestion_ready, JobInsert, LeasedJob, ReadinessSnapshot,
    JOB_STATUS_CANCELLED, JOB_STATUS_DONE, JOB_STATUS_FAILED,
};

use engine::{
    export_coco, extract_frames_from_mp4_with_progress_and_cancel,
    generate_review_dataset_with_progress_and_cancel, get_annotations, init_empty_manifest,
    run_import_stage, set_annotations, AnnotationEdit, ExportCocoOptions, ExportCocoReport,
    ExtractFramesFromMp4Options, ExtractFramesFromMp4Report, FaceView, FramesSource,
    GenerateReviewDatasetOptions, ImportStageOptions, ManifestInputs, ProjectionConfig,
    RenderConfig, ViewManifest,
};

const VIEW_MANIFEST_PATH: &str = "annotations/view_manifest.json";
const STAGING_WORKSPACE_PREFIX: &str = "bdr-anno-review-drop-";
const STAGING_REGISTRY_FILE: &str = "staging-workspaces.json";
const STAGING_WORKSPACE_MARKER_FILE: &str = ".bdr-anno-review-owned";

struct AppState {
    annotation_cache: Mutex<HashMap<(String, String), Vec<AnnotationEdit>>>,
    suggestion_cache: Mutex<HashMap<(String, String, String), SuggestionResponse>>,
    suggestion_queue: Mutex<SuggestionQueue>,
    generation_jobs: Mutex<HashMap<String, GenerationJobRecord>>,
    suggestion_worker_running: Mutex<bool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            annotation_cache: Mutex::new(HashMap::new()),
            suggestion_cache: Mutex::new(HashMap::new()),
            suggestion_queue: Mutex::new(SuggestionQueue::new()),
            generation_jobs: Mutex::new(HashMap::new()),
            suggestion_worker_running: Mutex::new(false),
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditingSessionStartRequest {
    dataset_root: String,
    current_face_id: String,
    lookahead_window: usize,
    target_buffer_size: usize,
    min_ready_to_start: usize,
    failure_cooldown_seconds: Option<u64>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuggestionReadinessRequest {
    dataset_root: String,
    current_face_id: String,
    lookahead_window: usize,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuggestionTopupRequest {
    dataset_root: String,
    current_face_id: String,
    lookahead_window: usize,
    target_buffer_size: usize,
    failure_cooldown_seconds: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SuggestionReadinessResponse {
    ready_count: usize,
    queued_count: usize,
    in_progress_count: usize,
    failed_count: usize,
    target_buffer_size: usize,
    min_ready_to_start: usize,
    blocked: bool,
    candidate_face_ids: Vec<String>,
    ready_face_ids: Vec<String>,
}

struct AppSession {
    id: String,
}

impl AppSession {
    fn new() -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        Self {
            id: format!("{}-{nanos}", std::process::id()),
        }
    }
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
    gpu_acceleration: Option<String>,
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
struct StartGenerationResponse {
    job_id: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerationStatusRequest {
    job_id: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AbortGenerationRequest {
    job_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AbortGenerationResponse {
    job_id: String,
    state: String,
    message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationStatusResponse {
    job_id: String,
    state: String,
    message: String,
    result: Option<GenerateReviewDatasetResponse>,
}

#[derive(Debug, Clone)]
struct GenerationJobRecord {
    state: String,
    message: String,
    result: Option<GenerateReviewDatasetResponse>,
    cancellation_token: CancellationToken,
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
    workspaces: Vec<StagingWorkspaceRegistration>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StagingWorkspaceRegistration {
    path: String,
    #[serde(default)]
    owner_session_id: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
enum StagingWorkspaceRegistrationCompat {
    LegacyPath(String),
    Registration(StagingWorkspaceRegistration),
}

impl From<StagingWorkspaceRegistrationCompat> for StagingWorkspaceRegistration {
    fn from(value: StagingWorkspaceRegistrationCompat) -> Self {
        match value {
            StagingWorkspaceRegistrationCompat::LegacyPath(path) => Self {
                path,
                owner_session_id: None,
            },
            StagingWorkspaceRegistrationCompat::Registration(registration) => registration,
        }
    }
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

async fn run_generation_pipeline(
    app: AppHandle,
    request: GenerateReviewDatasetRequest,
    cancellation_token: CancellationToken,
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
    if cancellation_token.is_cancelled() {
        return Err("operation cancelled: generation job".to_owned());
    }
    tauri::async_runtime::spawn_blocking({
        let dataset_root = request.dataset_root.clone();
        let coco_json_path = request.coco_json_path.clone();
        let mp4_path = request.mp4_path.clone();
        move || {
            run_import_stage(ImportStageOptions {
                dataset_root,
                coco_json_path,
                mp4_path,
            })
        }
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;

    if cancellation_token.is_cancelled() {
        return Err("operation cancelled: generation job".to_owned());
    }

    emit_progress(
        "probing_video",
        "Probing video and planning extraction",
        0,
        1,
        started,
        &app,
    );

    let extraction_report = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let dataset_root = request.dataset_root.clone();
        let coco_json_path = request.coco_json_path.clone();
        let mp4_path = request.mp4_path.clone();
        let gpu_acceleration = request.gpu_acceleration.clone();
        let cancellation_token = cancellation_token.clone();
        move || {
            extract_frames_from_mp4_with_progress_and_cancel(
                ExtractFramesFromMp4Options {
                    dataset_root,
                    coco_json_path,
                    mp4_path,
                    ffmpeg_bin: Some(ffmpeg_bin),
                    ffprobe_bin: Some(ffprobe_bin),
                    ffmpeg_hwaccel: gpu_acceleration,
                },
                |completed, total, phase| {
                    let detail = match phase {
                        "planned" => "Planning source frame extraction".to_owned(),
                        _ => format!("Extracting source frames ({completed}/{total})"),
                    };
                    let _ = app.emit(
                        "generation-progress",
                        GenerationProgressEvent {
                            phase: if phase == "planned" {
                                "planning_frames".to_owned()
                            } else {
                                phase.to_owned()
                            },
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
                move || cancellation_token.is_cancelled(),
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
    if cancellation_token.is_cancelled() {
        return Err("operation cancelled: generation job".to_owned());
    }

    let report = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            generate_review_dataset_with_progress_and_cancel(
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
                move || cancellation_token.is_cancelled(),
            )
        }
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;

    emit_progress("done", "Generation complete", 1, 1, started, &app);
    let state = app.state::<AppState>();
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
async fn generate_review_dataset_command(
    app: AppHandle,
    state: State<'_, AppState>,
    request: GenerateReviewDatasetRequest,
) -> Result<GenerateReviewDatasetResponse, String> {
    let _ = state;
    run_generation_pipeline(app, request, CancellationToken::new()).await
}

#[tauri::command]
fn start_generate_review_dataset_command(
    app: AppHandle,
    request: GenerateReviewDatasetRequest,
) -> Result<StartGenerationResponse, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let job_id = format!("gen-{}-{nanos}", std::process::id());

    {
        let state = app.state::<AppState>();
        state
            .generation_jobs
            .lock()
            .map_err(|_| "generation jobs lock poisoned".to_owned())?
            .insert(
                job_id.clone(),
                GenerationJobRecord {
                    state: "pending".to_owned(),
                    message: "Queued generation job".to_owned(),
                    result: None,
                    cancellation_token: CancellationToken::new(),
                },
            );
    }

    let app_for_task = app.clone();
    let job_id_for_task = job_id.clone();
    let cancellation_token = {
        let state = app.state::<AppState>();
        let jobs = state
            .generation_jobs
            .lock()
            .map_err(|_| "generation jobs lock poisoned".to_owned())?;
        jobs.get(&job_id)
            .map(|job| job.cancellation_token.clone())
            .ok_or_else(|| format!("generation job not found: {job_id}"))?
    };
    tauri::async_runtime::spawn(async move {
        {
            let state = app_for_task.state::<AppState>();
            let lock = state.generation_jobs.lock();
            if let Ok(mut jobs) = lock {
                if let Some(job) = jobs.get_mut(&job_id_for_task) {
                    job.state = "running".to_owned();
                    job.message = "Generation job is running".to_owned();
                }
            }
        }

        let result =
            run_generation_pipeline(app_for_task.clone(), request, cancellation_token.clone())
                .await;

        if let Ok(mut jobs) = app_for_task.state::<AppState>().generation_jobs.lock() {
            if let Some(job) = jobs.get_mut(&job_id_for_task) {
                match result {
                    Ok(report) => {
                        job.state = "done".to_owned();
                        job.message = "Generation complete".to_owned();
                        job.result = Some(report);
                    }
                    Err(error) => {
                        if error.contains("operation cancelled") {
                            job.state = "cancelled".to_owned();
                        } else {
                            job.state = "error".to_owned();
                        }
                        job.message = error;
                        job.result = None;
                    }
                }
            }
        }
    });

    Ok(StartGenerationResponse { job_id })
}

#[tauri::command]
fn abort_generation_job_command(
    app: AppHandle,
    request: AbortGenerationRequest,
) -> Result<AbortGenerationResponse, String> {
    let state = app.state::<AppState>();
    let mut jobs = state
        .generation_jobs
        .lock()
        .map_err(|_| "generation jobs lock poisoned".to_owned())?;
    let record = jobs
        .get_mut(&request.job_id)
        .ok_or_else(|| format!("generation job not found: {}", request.job_id))?;

    if matches!(record.state.as_str(), "done" | "error" | "cancelled") {
        return Ok(AbortGenerationResponse {
            job_id: request.job_id,
            state: record.state.clone(),
            message: record.message.clone(),
        });
    }

    record.cancellation_token.cancel();
    record.state = "aborting".to_owned();
    record.message = "Abort requested by user".to_owned();

    Ok(AbortGenerationResponse {
        job_id: request.job_id,
        state: record.state.clone(),
        message: record.message.clone(),
    })
}

#[tauri::command]
fn get_generation_status_command(
    app: AppHandle,
    request: GenerationStatusRequest,
) -> Result<GenerationStatusResponse, String> {
    let state = app.state::<AppState>();
    let jobs = state
        .generation_jobs
        .lock()
        .map_err(|_| "generation jobs lock poisoned".to_owned())?;
    let record = jobs
        .get(&request.job_id)
        .ok_or_else(|| format!("generation job not found: {}", request.job_id))?;

    Ok(GenerationStatusResponse {
        job_id: request.job_id,
        state: record.state.clone(),
        message: record.message.clone(),
        result: record.result.clone(),
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
        extract_frames_from_mp4_with_progress_and_cancel(
            ExtractFramesFromMp4Options {
                dataset_root: request.dataset_root,
                coco_json_path: request.coco_json_path,
                mp4_path: request.mp4_path,
                ffmpeg_bin: Some(ffmpeg_bin),
                ffprobe_bin: Some(ffprobe_bin),
                ffmpeg_hwaccel: None,
            },
            |_, _, _| {},
            || false,
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
        let session = app.state::<AppSession>();
        register_staging_workspace(app, &workspace_root, &session.id)?;
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
    session: State<'_, AppSession>,
) -> Result<CleanupStagingWorkspacesResponse, String> {
    cleanup_registered_staging_workspaces(&app, &session.id)
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
    let marker_path = root.join(STAGING_WORKSPACE_MARKER_FILE);
    fs::write(&marker_path, b"bdr-anno-review staging workspace\n").map_err(|source| {
        format!(
            "failed to create staging workspace marker `{}`: {source}",
            marker_path.display()
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
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|source| {
        format!(
            "invalid staging registry JSON at `{}`: {source}",
            path.display()
        )
    })?;

    let workspaces_value = parsed
        .get("workspaces")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
    let registrations: Vec<StagingWorkspaceRegistrationCompat> =
        serde_json::from_value(workspaces_value).map_err(|source| {
            format!(
                "invalid staging workspace registry entries at `{}`: {source}",
                path.display()
            )
        })?;

    Ok(StagingWorkspaceRegistry {
        workspaces: registrations.into_iter().map(Into::into).collect(),
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
        && path.join(STAGING_WORKSPACE_MARKER_FILE).is_file()
}

fn register_staging_workspace(
    app: &AppHandle,
    workspace_root: &Path,
    owner_session_id: &str,
) -> Result<(), String> {
    let registry_path = staging_registry_path(app)?;
    let mut registry = load_staging_registry(&registry_path)?;
    registry.workspaces.retain(|entry| {
        let path = Path::new(&entry.path);
        path.exists() && is_owned_staging_workspace(path)
    });

    let workspace = workspace_root.display().to_string();
    if !registry
        .workspaces
        .iter()
        .any(|candidate| candidate.path == workspace)
    {
        registry.workspaces.push(StagingWorkspaceRegistration {
            path: workspace,
            owner_session_id: Some(owner_session_id.to_owned()),
        });
    }

    save_staging_registry(&registry_path, &registry)
}

fn cleanup_registered_staging_workspaces(
    app: &AppHandle,
    owner_session_id: &str,
) -> Result<CleanupStagingWorkspacesResponse, String> {
    let registry_path = staging_registry_path(app)?;
    cleanup_registered_staging_workspaces_by_registry_path(&registry_path, owner_session_id)
}

fn cleanup_registered_staging_workspaces_by_registry_path(
    registry_path: &Path,
    owner_session_id: &str,
) -> Result<CleanupStagingWorkspacesResponse, String> {
    let mut registry = load_staging_registry(registry_path)?;
    let mut removed_paths = Vec::new();
    let mut skipped_paths = Vec::new();
    let mut retained_paths: Vec<StagingWorkspaceRegistration> = Vec::new();
    let mut errors = Vec::new();

    for entry in &registry.workspaces {
        let path = PathBuf::from(&entry.path);
        if entry.owner_session_id.as_deref() != Some(owner_session_id) {
            retained_paths.push(entry.clone());
            continue;
        }
        if !path.exists() {
            continue;
        }
        if !is_owned_staging_workspace(&path) {
            skipped_paths.push(entry.path.clone());
            retained_paths.push(entry.clone());
            continue;
        }
        if !path.is_dir() {
            skipped_paths.push(entry.path.clone());
            retained_paths.push(entry.clone());
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
        removed_paths.push(entry.path.clone());
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
fn get_llm_settings_command(app: AppHandle) -> Result<LlmSettingsResponse, String> {
    get_settings_response(&app)
}

#[tauri::command]
fn save_llm_settings_command(
    app: AppHandle,
    request: SaveLlmSettingsRequest,
) -> Result<LlmSettingsResponse, String> {
    save_settings_request(&app, request)
}

#[tauri::command]
fn clear_llm_api_key_command(request: ProviderKeyRequest) -> Result<(), String> {
    clear_provider_key(request)
}

#[tauri::command]
fn set_llm_api_key_command(request: SetProviderKeyRequest) -> Result<(), String> {
    set_provider_key(request)
}

fn load_manifest(dataset_root: &str) -> Result<ViewManifest, String> {
    let manifest_path = PathBuf::from(dataset_root).join(VIEW_MANIFEST_PATH);
    let raw = fs::read_to_string(&manifest_path).map_err(|source| {
        format!(
            "failed to read manifest `{}`: {source}",
            manifest_path.display()
        )
    })?;
    serde_json::from_str(&raw).map_err(|source| {
        format!(
            "failed to parse manifest `{}`: {source}",
            manifest_path.display()
        )
    })
}

fn get_face_by_id(dataset_root: &str, face_id: &str) -> Result<FaceView, String> {
    let manifest = load_manifest(dataset_root)?;
    manifest
        .faces
        .into_iter()
        .find(|face| face.face_id == face_id)
        .ok_or_else(|| format!("unknown face_id: {face_id}"))
}

fn active_provider_model(settings: &LlmSettings) -> Result<String, String> {
    if settings.openai.enabled {
        return Ok(settings.openai.model.trim().to_owned());
    }
    if settings.anthropic.enabled {
        return Ok(settings.anthropic.model.trim().to_owned());
    }
    Err("no LLM provider is enabled in settings".to_owned())
}

fn suggestion_signature_from_settings(settings: &LlmSettings) -> Result<String, String> {
    let model_id = active_provider_model(settings)?;
    compute_suggestion_signature(&SuggestionSignatureInput {
        model_id,
        prompt_template_version: "suggest_boxes_v1".to_owned(),
        preprocessing_version: "face_manifest_v1".to_owned(),
        generation_params: serde_json::json!({
            "reasoningPreset": settings.reasoning_preset,
            "prefetchBufferSize": settings.prefetch_buffer_size,
            "editorWarmupThresholdRatio": settings.editor_warmup_threshold_ratio,
        }),
    })
}

fn candidate_face_ids(
    manifest: &ViewManifest,
    current_face_id: &str,
    lookahead_window: usize,
) -> Vec<String> {
    let Some(current_index) = manifest
        .faces
        .iter()
        .position(|face| face.face_id == current_face_id)
    else {
        return Vec::new();
    };

    let end = (current_index + lookahead_window + 1).min(manifest.faces.len());
    manifest.faces[current_index..end]
        .iter()
        .map(|face| face.face_id.clone())
        .collect()
}

fn to_readiness_response(
    snapshot: ReadinessSnapshot,
    target_buffer_size: usize,
    min_ready_to_start: usize,
    candidate_face_ids: Vec<String>,
    ready_face_ids: Vec<String>,
) -> SuggestionReadinessResponse {
    SuggestionReadinessResponse {
        ready_count: snapshot.ready_count,
        queued_count: snapshot.queued_count,
        in_progress_count: snapshot.in_progress_count,
        failed_count: snapshot.failed_count,
        target_buffer_size,
        min_ready_to_start,
        blocked: snapshot.ready_count < min_ready_to_start,
        candidate_face_ids,
        ready_face_ids,
    }
}

fn suggestion_queue_key(dataset_root: &str, face_id: &str) -> (String, String) {
    (dataset_root.to_owned(), face_id.to_owned())
}

fn worker_suggestion_request(job: &LeasedJob) -> SuggestionRequest {
    SuggestionRequest {
        dataset_root: job.dataset_id.clone(),
        face_id: job.frame_id.clone(),
        timeout_ms: None,
    }
}

fn ready_face_ids_for_signature(
    app: &AppHandle,
    dataset_root: &str,
    candidate_face_ids: &[String],
    signature: &str,
) -> Vec<String> {
    candidate_face_ids
        .iter()
        .filter_map(|face_id| {
            has_ready_suggestion(app, dataset_root, face_id, signature)
                .ok()
                .and_then(|is_ready| {
                    if is_ready {
                        Some(face_id.clone())
                    } else {
                        None
                    }
                })
        })
        .collect()
}

fn run_suggestion_topup(
    app: &AppHandle,
    state: &AppState,
    dataset_root: &str,
    current_face_id: &str,
    lookahead_window: usize,
    target_buffer_size: usize,
    failure_cooldown_seconds: u64,
) -> Result<(ReadinessSnapshot, Vec<String>, Vec<String>, usize), String> {
    let settings = load_settings(app)?;
    let signature = suggestion_signature_from_settings(&settings)?;
    let manifest = load_manifest(dataset_root)?;
    let candidates = candidate_face_ids(&manifest, current_face_id, lookahead_window);
    let before = readiness_snapshot(app, dataset_root, &candidates, &signature)?;
    let tracked = before.ready_count + before.queued_count + before.in_progress_count;
    let vacancy = target_buffer_size.saturating_sub(tracked);

    let mut jobs = Vec::new();
    if vacancy > 0 {
        for (offset, frame_id) in candidates.iter().enumerate() {
            if jobs.len() >= vacancy {
                break;
            }
            if has_ready_suggestion(app, dataset_root, frame_id, &signature)? {
                continue;
            }
            if has_active_job(app, dataset_root, frame_id, &signature)? {
                continue;
            }
            if recently_failed(
                app,
                dataset_root,
                frame_id,
                &signature,
                failure_cooldown_seconds as i64,
            )? {
                continue;
            }
            let priority = 1000_i64.saturating_sub(offset as i64);
            jobs.push(JobInsert {
                job_id: format!(
                    "sjob-{}-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_nanos())
                        .unwrap_or_default(),
                    offset
                ),
                dataset_id: dataset_root.to_owned(),
                frame_id: frame_id.clone(),
                suggestion_signature: signature.clone(),
                priority,
            });
        }
    }

    let inserted_frame_ids = insert_jobs_if_missing(app, &jobs)?;
    for frame_id in inserted_frame_ids.iter() {
        let mut queue = state
            .suggestion_queue
            .lock()
            .map_err(|_| "suggestion queue lock poisoned".to_owned())?;
        queue.states.insert(
            suggestion_queue_key(dataset_root, frame_id),
            "queued".to_owned(),
        );
    }

    let after = readiness_snapshot(app, dataset_root, &candidates, &signature)?;
    let ready_face_ids = ready_face_ids_for_signature(app, dataset_root, &candidates, &signature);
    Ok((after, candidates, ready_face_ids, inserted_frame_ids.len()))
}

fn suggestion_worker_loop(app_for_thread: &AppHandle) {
    loop {
        let lease = lease_next_job(app_for_thread, 30);
        let Some(job) = (match lease {
            Ok(value) => value,
            Err(error) => {
                eprintln!("suggestion worker lease failed: {error}");
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
        }) else {
            std::thread::sleep(Duration::from_millis(350));
            continue;
        };

        let state = app_for_thread.state::<AppState>();
        if let Ok(mut queue) = state.suggestion_queue.lock() {
            queue.states.insert(
                suggestion_queue_key(&job.dataset_id, &job.frame_id),
                "in_flight".to_owned(),
            );
        }

        let maybe_ready = has_ready_suggestion(
            app_for_thread,
            &job.dataset_id,
            &job.frame_id,
            &job.suggestion_signature,
        );
        match maybe_ready {
            Ok(true) => {
                let _ = complete_job(app_for_thread, &job.job_id, JOB_STATUS_CANCELLED, None);
                if let Ok(mut queue) = state.suggestion_queue.lock() {
                    queue.states.insert(
                        suggestion_queue_key(&job.dataset_id, &job.frame_id),
                        "ready".to_owned(),
                    );
                }
                continue;
            }
            Ok(false) => {}
            Err(error) => {
                let _ = complete_job(
                    app_for_thread,
                    &job.job_id,
                    JOB_STATUS_FAILED,
                    Some(&format!("dedup check failed: {error}")),
                );
                if let Ok(mut queue) = state.suggestion_queue.lock() {
                    queue.states.insert(
                        suggestion_queue_key(&job.dataset_id, &job.frame_id),
                        "failed".to_owned(),
                    );
                }
                continue;
            }
        }

        let result = generate_and_cache_suggestion(
            app_for_thread,
            &state,
            worker_suggestion_request(&job),
            Some(job.suggestion_signature.as_str()),
        );
        match result {
            Ok(response) => {
                if let Ok(payload) = serde_json::to_string(&response) {
                    let _ = upsert_suggestion_ready(
                        app_for_thread,
                        &job.dataset_id,
                        &job.frame_id,
                        &job.suggestion_signature,
                        &payload,
                    );
                }
                let _ = complete_job(app_for_thread, &job.job_id, JOB_STATUS_DONE, None);
                let _ = app_for_thread.emit("suggestion-job-complete", &job.frame_id);
            }
            Err(error) => {
                let _ = mark_suggestion_failed(
                    app_for_thread,
                    &job.dataset_id,
                    &job.frame_id,
                    &job.suggestion_signature,
                );
                let _ = complete_job(app_for_thread, &job.job_id, JOB_STATUS_FAILED, Some(&error));
                if let Ok(mut queue) = state.suggestion_queue.lock() {
                    queue.states.insert(
                        suggestion_queue_key(&job.dataset_id, &job.frame_id),
                        "failed".to_owned(),
                    );
                }
            }
        }
    }
}

fn ensure_suggestion_worker(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut running = state
            .suggestion_worker_running
            .lock()
            .map_err(|_| "suggestion worker lock poisoned".to_owned())?;
        if *running {
            return Ok(());
        }
        *running = true;
    }

    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            suggestion_worker_loop(&app_for_thread);
        }));

        if result.is_err() {
            eprintln!("suggestion worker crashed; allowing restart on next request");
        }

        if let Ok(mut running) = app_for_thread
            .state::<AppState>()
            .suggestion_worker_running
            .lock()
        {
            *running = false;
        }
    });

    Ok(())
}

#[tauri::command]
fn get_suggestions_command(
    app: AppHandle,
    state: State<AppState>,
    request: SuggestionRequest,
) -> Result<SuggestionResponse, String> {
    ensure_schema(&app)?;
    generate_and_cache_suggestion(&app, &state, request, None)
}

fn generate_and_cache_suggestion(
    app: &AppHandle,
    state: &AppState,
    request: SuggestionRequest,
    expected_signature: Option<&str>,
) -> Result<SuggestionResponse, String> {
    let settings = load_settings(app)?;
    if !settings.llm_suggestions_enabled {
        return Err("LLM suggestions are disabled in settings".to_owned());
    }

    let signature = suggestion_signature_from_settings(&settings)?;
    if let Some(expected) = expected_signature {
        if signature != expected {
            return Err(format!(
                "suggestion signature mismatch: current={signature}, expected={expected}"
            ));
        }
    }

    let cache_key = (
        request.dataset_root.clone(),
        request.face_id.clone(),
        signature.clone(),
    );
    if let Some(cached) = state
        .suggestion_cache
        .lock()
        .map_err(|_| "suggestion cache lock poisoned".to_owned())?
        .get(&cache_key)
        .cloned()
    {
        return Ok(cached);
    }

    if let Some(persisted) = load_ready_suggestion::<SuggestionResponse>(
        app,
        &request.dataset_root,
        &request.face_id,
        &signature,
    )? {
        state
            .suggestion_cache
            .lock()
            .map_err(|_| "suggestion cache lock poisoned".to_owned())?
            .insert(cache_key, persisted.clone());
        state
            .suggestion_queue
            .lock()
            .map_err(|_| "suggestion queue lock poisoned".to_owned())?
            .states
            .insert(
                suggestion_queue_key(&request.dataset_root, &request.face_id),
                "ready".to_owned(),
            );
        return Ok(persisted);
    }

    {
        let mut queue = state
            .suggestion_queue
            .lock()
            .map_err(|_| "suggestion queue lock poisoned".to_owned())?;
        queue.states.insert(
            suggestion_queue_key(&request.dataset_root, &request.face_id),
            "in_flight".to_owned(),
        );
    }

    let generated = (|| {
        let face = get_face_by_id(&request.dataset_root, &request.face_id)?;

        let (openai_api_key, anthropic_api_key) = if settings.openai.enabled {
            let key = openai_key()?;
            if key.is_none() {
                return Err("No API key configured for OpenAI. Add it in Settings.".to_owned());
            }
            (key, None)
        } else if settings.anthropic.enabled {
            let key = anthropic_key()?;
            if key.is_none() {
                return Err("No API key configured for Anthropic. Add it in Settings.".to_owned());
            }
            (None, key)
        } else {
            (None, None)
        };

        generate_suggestions_with_retry(
            app,
            &settings,
            &face,
            &request.dataset_root,
            openai_api_key.as_deref(),
            anthropic_api_key.as_deref(),
            request.timeout_ms,
        )
    })();

    match generated {
        Ok(response) => {
            state
                .suggestion_cache
                .lock()
                .map_err(|_| "suggestion cache lock poisoned".to_owned())?
                .insert(cache_key, response.clone());
            state
                .suggestion_queue
                .lock()
                .map_err(|_| "suggestion queue lock poisoned".to_owned())?
                .states
                .insert(
                    suggestion_queue_key(&request.dataset_root, &request.face_id),
                    "ready".to_owned(),
                );
            Ok(response)
        }
        Err(error) => {
            state
                .suggestion_queue
                .lock()
                .map_err(|_| "suggestion queue lock poisoned".to_owned())?
                .states
                .insert(
                    suggestion_queue_key(&request.dataset_root, &request.face_id),
                    "failed".to_owned(),
                );
            Err(error)
        }
    }
}

#[tauri::command]
fn prefetch_suggestions_command(
    app: AppHandle,
    state: State<AppState>,
    request: SuggestionQueuePrefetchRequest,
) -> Result<QueueStateResponse, String> {
    ensure_schema(&app)?;
    ensure_suggestion_worker(&app)?;

    let settings = load_settings(&app)?;
    if !settings.llm_suggestions_enabled {
        return Ok(QueueStateResponse { items: Vec::new() });
    }

    let current = request.face_ids.first().cloned().unwrap_or_default();
    let lookahead = settings.prefetch_buffer_size.saturating_sub(1);
    let (_, candidate_face_ids, _, _) = run_suggestion_topup(
        &app,
        &state,
        &request.dataset_root,
        &current,
        lookahead,
        settings.prefetch_buffer_size,
        30,
    )?;

    let queue = state
        .suggestion_queue
        .lock()
        .map_err(|_| "suggestion queue lock poisoned".to_owned())?;
    Ok(queue.state(&request.dataset_root, &candidate_face_ids))
}

#[tauri::command]
fn editing_session_start_command(
    app: AppHandle,
    state: State<AppState>,
    request: EditingSessionStartRequest,
) -> Result<SuggestionReadinessResponse, String> {
    ensure_schema(&app)?;
    ensure_suggestion_worker(&app)?;

    let (snapshot, candidates, ready_face_ids, _) = run_suggestion_topup(
        &app,
        &state,
        &request.dataset_root,
        &request.current_face_id,
        request.lookahead_window,
        request.target_buffer_size,
        request.failure_cooldown_seconds.unwrap_or(30),
    )?;

    Ok(to_readiness_response(
        snapshot,
        request.target_buffer_size,
        request.min_ready_to_start,
        candidates,
        ready_face_ids,
    ))
}

#[tauri::command]
fn suggestions_readiness_command(
    app: AppHandle,
    request: SuggestionReadinessRequest,
) -> Result<SuggestionReadinessResponse, String> {
    ensure_schema(&app)?;
    let settings = load_settings(&app)?;
    let signature = suggestion_signature_from_settings(&settings)?;
    let manifest = load_manifest(&request.dataset_root)?;
    let candidates = candidate_face_ids(
        &manifest,
        &request.current_face_id,
        request.lookahead_window,
    );
    let target = settings.prefetch_buffer_size;
    let required = ((target as f64) * settings.editor_warmup_threshold_ratio).ceil() as usize;
    let min_ready = required.clamp(1, target.max(1));
    let snapshot = readiness_snapshot(&app, &request.dataset_root, &candidates, &signature)?;
    let ready_face_ids =
        ready_face_ids_for_signature(&app, &request.dataset_root, &candidates, &signature);
    Ok(to_readiness_response(
        snapshot,
        target,
        min_ready,
        candidates,
        ready_face_ids,
    ))
}

#[tauri::command]
fn suggestions_topup_command(
    app: AppHandle,
    state: State<AppState>,
    request: SuggestionTopupRequest,
) -> Result<SuggestionReadinessResponse, String> {
    ensure_schema(&app)?;
    ensure_suggestion_worker(&app)?;

    let settings = load_settings(&app)?;
    let min_ready = (((request.target_buffer_size as f64) * settings.editor_warmup_threshold_ratio)
        .ceil() as usize)
        .clamp(1, request.target_buffer_size.max(1));
    let (snapshot, candidates, ready_face_ids, _) = run_suggestion_topup(
        &app,
        &state,
        &request.dataset_root,
        &request.current_face_id,
        request.lookahead_window,
        request.target_buffer_size,
        request.failure_cooldown_seconds.unwrap_or(30),
    )?;

    Ok(to_readiness_response(
        snapshot,
        request.target_buffer_size,
        min_ready,
        candidates,
        ready_face_ids,
    ))
}

#[tauri::command]
fn get_suggestion_queue_state_command(
    state: State<AppState>,
    dataset_root: String,
    face_ids: Vec<String>,
) -> Result<QueueStateResponse, String> {
    let queue = state
        .suggestion_queue
        .lock()
        .map_err(|_| "suggestion queue lock poisoned".to_owned())?;
    Ok(queue.state(&dataset_root, &face_ids))
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
        .manage(AppSession::new())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let session = app.state::<AppSession>();
            if let Err(error) = cleanup_registered_staging_workspaces(app.handle(), &session.id) {
                eprintln!("startup staging workspace cleanup failed: {error}");
            }
            if let Err(error) = ensure_schema(app.handle()) {
                return Err(error.into());
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
            start_generate_review_dataset_command,
            get_generation_status_command,
            abort_generation_job_command,
            extract_frames_from_mp4_command,
            check_runtime_dependencies_command,
            get_llm_settings_command,
            save_llm_settings_command,
            clear_llm_api_key_command,
            set_llm_api_key_command,
            get_suggestions_command,
            prefetch_suggestions_command,
            editing_session_start_command,
            suggestions_readiness_command,
            suggestions_topup_command,
            get_suggestion_queue_state_command,
            stage_dropped_inputs_command,
            cleanup_staging_workspaces_command
        ])
        .build(tauri::generate_context!())
        .expect("failed to build bdr-anno-review tauri app")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let app_state = app.state::<AppState>();
                if let Ok(mut jobs) = app_state.generation_jobs.lock() {
                    for job in jobs.values_mut() {
                        job.cancellation_token.cancel();
                        if job.state == "running" || job.state == "pending" {
                            job.state = "aborting".to_owned();
                            job.message = "App exit requested; aborting generation".to_owned();
                        }
                    }
                }

                let session = app.state::<AppSession>();
                if let Err(error) = cleanup_registered_staging_workspaces(app, &session.id) {
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
        worker_suggestion_request, ImportStageRequest, SetAnnotationsRequest,
        StageDroppedInputsRequest, STAGING_WORKSPACE_MARKER_FILE,
    };
    use crate::suggestion_store::LeasedJob;
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
    fn worker_requests_inherit_backend_timeout_policy() {
        let request = worker_suggestion_request(&LeasedJob {
            job_id: "job-1".to_owned(),
            dataset_id: "/tmp/dataset".to_owned(),
            frame_id: "face-1".to_owned(),
            suggestion_signature: "sig-1".to_owned(),
        });

        assert_eq!(request.dataset_root, "/tmp/dataset");
        assert_eq!(request.face_id, "face-1");
        assert_eq!(request.timeout_ms, None);
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
        let owner = "session-a";
        fs::create_dir_all(&owned).unwrap();
        fs::write(owned.join(STAGING_WORKSPACE_MARKER_FILE), "owned").unwrap();
        fs::create_dir_all(&non_owned).unwrap();

        let registry_path = fixture_root.join("registry.json");
        fs::write(
            &registry_path,
            format!(
                r#"{{"workspaces":[{{"path":"{}","ownerSessionId":"{}"}},{{"path":"{}","ownerSessionId":"{}"}}]}}"#,
                owned.display(),
                owner,
                non_owned.display(),
                owner
            ),
        )
        .unwrap();

        let result =
            cleanup_registered_staging_workspaces_by_registry_path(&registry_path, owner).unwrap();
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
        let owner = "session-a";
        let registry_path = fixture_root.join("registry.json");
        fs::write(
            &registry_path,
            format!(
                r#"{{"workspaces":[{{"path":"{}","ownerSessionId":"{}"}}]}}"#,
                missing.display(),
                owner
            ),
        )
        .unwrap();

        let result =
            cleanup_registered_staging_workspaces_by_registry_path(&registry_path, owner).unwrap();
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
