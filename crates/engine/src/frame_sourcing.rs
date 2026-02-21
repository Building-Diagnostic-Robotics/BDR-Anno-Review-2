use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::EngineError;

pub const FRAME_EXTRACTION_DIR: &str = "derived_frames/frame_sourcing";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FrameSourcingOptions {
    pub dataset_root: String,
    pub coco_json_path: String,
    pub mp4_path: String,
    pub mp4_frame_count: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ExtractFramesFromMp4Options {
    pub dataset_root: String,
    pub coco_json_path: String,
    pub mp4_path: String,
    #[serde(default)]
    pub ffmpeg_bin: Option<String>,
    #[serde(default)]
    pub ffprobe_bin: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FrameSourcingReport {
    pub dataset_root: String,
    pub coco_json_path: String,
    pub mp4_path: String,
    pub extraction_root: String,
    pub referenced_image_count: usize,
    pub resolved_frame_count: usize,
    pub mappings: Vec<FrameMapping>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ExtractFramesFromMp4Report {
    pub source_frames_dir: String,
    pub mp4_frame_count: u64,
    pub extracted_frame_count: usize,
    pub mappings: Vec<FrameMapping>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FrameMapping {
    pub image_id: u64,
    pub file_name: String,
    pub frame_index: u64,
    pub extracted_frame_path: String,
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
}

#[derive(Debug, Deserialize)]
struct CocoAnnotation {
    id: Option<u64>,
    image_id: Option<u64>,
}

pub fn extract_frames_from_mp4(
    options: ExtractFramesFromMp4Options,
) -> Result<ExtractFramesFromMp4Report, EngineError> {
    let dataset_root = validate_and_resolve_dataset_root(&options.dataset_root)?;
    let coco_path = resolve_path(&dataset_root, &options.coco_json_path);
    let mp4_path = resolve_path(&dataset_root, &options.mp4_path);

    ensure_extension(&coco_path, "json", "COCO annotation file")?;
    ensure_extension(&mp4_path, "mp4", "video file")?;
    ensure_file(&coco_path, "COCO annotation file")?;
    ensure_file(&mp4_path, "MP4 video")?;

    let ffprobe_bin = options.ffprobe_bin.as_deref().unwrap_or("ffprobe");
    let ffmpeg_bin = options.ffmpeg_bin.as_deref().unwrap_or("ffmpeg");

    let mp4_frame_count = probe_mp4_frame_count(ffprobe_bin, &mp4_path)?;
    let plan = build_frame_sourcing_report(FrameSourcingOptions {
        dataset_root: dataset_root.display().to_string(),
        coco_json_path: coco_path.display().to_string(),
        mp4_path: mp4_path.display().to_string(),
        mp4_frame_count,
    })?;

    let extraction_root = PathBuf::from(&plan.extraction_root);
    fs::create_dir_all(&extraction_root).map_err(|source| EngineError::UnreadableFile {
        path: extraction_root.display().to_string(),
        reason: format!("could not create frame extraction directory: {source}"),
    })?;

    for mapping in &plan.mappings {
        let output_path = PathBuf::from(&mapping.extracted_frame_path);
        extract_single_frame(ffmpeg_bin, &mp4_path, mapping.frame_index, &output_path)?;
    }

    Ok(ExtractFramesFromMp4Report {
        source_frames_dir: extraction_root.display().to_string(),
        mp4_frame_count,
        extracted_frame_count: plan.mappings.len(),
        mappings: plan.mappings,
    })
}

pub fn build_frame_sourcing_report(
    options: FrameSourcingOptions,
) -> Result<FrameSourcingReport, EngineError> {
    let dataset_root = validate_and_resolve_dataset_root(&options.dataset_root)?;
    if options.coco_json_path.trim().is_empty() {
        return Err(EngineError::MissingInput("coco_json_path"));
    }
    if options.mp4_path.trim().is_empty() {
        return Err(EngineError::MissingInput("mp4_path"));
    }
    if options.mp4_frame_count == 0 {
        return Err(EngineError::MissingInput("mp4_frame_count"));
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

    let mut images_by_id = BTreeMap::new();
    for (index, image) in images.into_iter().enumerate() {
        let image_id = image.id.ok_or_else(|| EngineError::InvalidCocoEntry {
            section: "images",
            index,
            reason: "missing required field `id`".to_owned(),
        })?;

        if images_by_id.insert(image_id, image).is_some() {
            return Err(EngineError::InvalidCocoEntry {
                section: "images",
                index,
                reason: format!("duplicate image id `{image_id}`"),
            });
        }
    }

    let mut referenced_image_ids = BTreeSet::new();
    for (index, annotation) in annotations.iter().enumerate() {
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

        referenced_image_ids.insert(image_id);
    }

    let extraction_root = dataset_root.join(FRAME_EXTRACTION_DIR);

    let referenced_image_count = referenced_image_ids.len();
    let mut mappings = Vec::with_capacity(referenced_image_count);
    let mut seen_frame_indices = HashSet::new();

    for image_id in referenced_image_ids {
        let image = images_by_id.get(&image_id).expect("validated image exists");
        let file_name = image
            .file_name
            .clone()
            .ok_or_else(|| EngineError::InvalidCocoEntry {
                section: "images",
                index: 0,
                reason: format!("missing required field `file_name` for image id `{image_id}`"),
            })?;

        let frame_index = resolve_frame_index(image.frame_index, &file_name, image_id)?;

        if frame_index >= options.mp4_frame_count {
            return Err(EngineError::FrameIndexOutOfRange {
                image_id,
                file_name,
                frame_index,
                mp4_frame_count: options.mp4_frame_count,
                mp4_path: mp4_path.display().to_string(),
            });
        }

        if seen_frame_indices.insert(frame_index) {
            mappings.push(FrameMapping {
                image_id,
                file_name,
                frame_index,
                extracted_frame_path: extraction_root
                    .join(format!("frame_{frame_index:06}.png"))
                    .display()
                    .to_string(),
            });
        }
    }

    Ok(FrameSourcingReport {
        dataset_root: dataset_root.display().to_string(),
        coco_json_path: coco_path.display().to_string(),
        mp4_path: mp4_path.display().to_string(),
        extraction_root: extraction_root.display().to_string(),
        referenced_image_count,
        resolved_frame_count: mappings.len(),
        mappings,
    })
}

pub fn resolve_frame_index(
    frame_index: Option<u64>,
    file_name: &str,
    image_id: u64,
) -> Result<u64, EngineError> {
    if let Some(frame_index) = frame_index {
        return Ok(frame_index);
    }

    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();

    let mut current_digits = String::new();
    let mut last_digits = String::new();

    for ch in stem.chars() {
        if ch.is_ascii_digit() {
            current_digits.push(ch);
        } else if !current_digits.is_empty() {
            last_digits = current_digits.clone();
            current_digits.clear();
        }
    }

    if !current_digits.is_empty() {
        last_digits = current_digits;
    }

    if last_digits.is_empty() {
        return Err(EngineError::UnresolvableFrameReference {
            image_id,
            file_name: file_name.to_owned(),
            reason: "missing `frame_index` and no numeric token in `images[].file_name`".to_owned(),
        });
    }

    last_digits
        .parse::<u64>()
        .map_err(|parse_error| EngineError::UnresolvableFrameReference {
            image_id,
            file_name: file_name.to_owned(),
            reason: format!("failed to parse frame index token `{last_digits}`: {parse_error}"),
        })
}

fn extract_single_frame(
    ffmpeg_bin: &str,
    mp4_path: &Path,
    frame_index: u64,
    output_path: &Path,
) -> Result<(), EngineError> {
    let ffmpeg_output = Command::new(ffmpeg_bin)
        .arg("-v")
        .arg("error")
        .arg("-nostdin")
        .arg("-i")
        .arg(mp4_path)
        .arg("-vf")
        .arg(format!("select=eq(n\\,{frame_index})"))
        .arg("-vframes")
        .arg("1")
        .arg("-y")
        .arg(output_path)
        .output()
        .map_err(|source| EngineError::InvalidConfiguration(format!(
            "failed to run ffmpeg for frame extraction; ensure ffmpeg is installed and available on PATH: {source}"
        )))?;

    if !ffmpeg_output.status.success() {
        return Err(EngineError::UnreadableFile {
            path: mp4_path.display().to_string(),
            reason: format!(
                "ffmpeg failed to extract frame {frame_index}: {}",
                String::from_utf8_lossy(&ffmpeg_output.stderr)
            ),
        });
    }

    if output_path.is_file() {
        Ok(())
    } else {
        Err(EngineError::UnreadableFile {
            path: mp4_path.display().to_string(),
            reason: format!(
                "ffmpeg did not produce output for frame index {frame_index}; frame may be outside MP4 bounds"
            ),
        })
    }
}

fn probe_mp4_frame_count(ffprobe_bin: &str, mp4_path: &Path) -> Result<u64, EngineError> {
    let output = Command::new(ffprobe_bin)
        .arg("-v")
        .arg("error")
        .arg("-select_streams")
        .arg("v:0")
        .arg("-count_frames")
        .arg("-show_entries")
        .arg("stream=nb_read_frames")
        .arg("-of")
        .arg("default=nokey=1:noprint_wrappers=1")
        .arg(mp4_path)
        .output()
        .map_err(|source| {
            EngineError::InvalidConfiguration(format!(
                "failed to run ffprobe for MP4 introspection; ensure ffprobe is installed and available on PATH: {source}"
            ))
        })?;

    if !output.status.success() {
        return Err(EngineError::UnreadableFile {
            path: mp4_path.display().to_string(),
            reason: format!(
                "ffprobe failed to inspect MP4: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        });
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("N/A") {
        return Err(EngineError::InvalidConfiguration(format!(
            "ffprobe could not determine MP4 frame count for `{}`",
            mp4_path.display()
        )));
    }

    trimmed.parse::<u64>().map_err(|source| {
        EngineError::InvalidConfiguration(format!(
            "ffprobe returned invalid frame count `{trimmed}` for `{}`: {source}",
            mp4_path.display()
        ))
    })
}

fn validate_and_resolve_dataset_root(dataset_root: &str) -> Result<PathBuf, EngineError> {
    if dataset_root.trim().is_empty() {
        return Err(EngineError::MissingInput("dataset_root"));
    }

    let root = PathBuf::from(dataset_root);
    if !root.is_dir() {
        return Err(EngineError::MissingFile {
            path: dataset_root.to_owned(),
            reason: "dataset root directory does not exist".to_owned(),
        });
    }

    Ok(root)
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
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        build_frame_sourcing_report, extract_frames_from_mp4, ExtractFramesFromMp4Options,
        FrameSourcingOptions,
    };

    fn unique_temp_dir() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("engine-frame-sourcing-{nanos}"))
    }

    fn setup_dataset(fixture_file_name: &str) -> FrameSourcingOptions {
        let root = unique_temp_dir();
        let annotations_dir = root.join("annotations");
        let videos_dir = root.join("videos");

        fs::create_dir_all(&annotations_dir).unwrap();
        fs::create_dir_all(&videos_dir).unwrap();

        let fixture_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/tiny_dataset/annotations")
            .join(fixture_file_name);
        let coco = fs::read_to_string(fixture_path).unwrap();

        fs::write(annotations_dir.join("instances_default.json"), coco).unwrap();
        fs::write(videos_dir.join("source.mp4"), b"fake-mp4").unwrap();

        FrameSourcingOptions {
            dataset_root: root.display().to_string(),
            coco_json_path: "annotations/instances_default.json".to_owned(),
            mp4_path: "videos/source.mp4".to_owned(),
            mp4_frame_count: 32,
        }
    }

    #[test]
    fn resolves_only_annotation_referenced_images() {
        let options = setup_dataset("instances_frame_source_valid.json");

        let report = build_frame_sourcing_report(options).unwrap();
        assert_eq!(report.referenced_image_count, 2);
        assert_eq!(report.resolved_frame_count, 2);
        assert_eq!(report.mappings[0].frame_index, 3);
        assert_eq!(report.mappings[0].image_id, 10);
        assert_eq!(report.mappings[1].frame_index, 7);
        assert_eq!(report.mappings[1].image_id, 20);
        assert!(report.mappings[0]
            .extracted_frame_path
            .ends_with("derived_frames/frame_sourcing/frame_000003.png"));
    }

    #[test]
    fn errors_when_frame_index_cannot_be_resolved() {
        let options = setup_dataset("instances_frame_source_missing_index.json");

        let err = build_frame_sourcing_report(options).unwrap_err();
        assert_eq!(
            err.to_string(),
            "could not resolve frame reference for image_id 10 (`no_index.png`): missing `frame_index` and no numeric token in `images[].file_name`"
        );
    }

    #[test]
    fn errors_when_resolved_frame_index_is_outside_mp4_length() {
        let mut options = setup_dataset("instances_frame_source_valid.json");
        options.mp4_frame_count = 5;

        let err = build_frame_sourcing_report(options).unwrap_err();
        let message = err.to_string();

        assert!(message.contains("frame reference out of range for image_id 20 (`cam0_frame_000007.jpg`): frame index 7 is outside MP4 frame count 5"));
        assert!(message.contains("videos/source.mp4"));
    }

    #[test]
    fn extraction_fails_loudly_when_ffmpeg_tools_are_missing() {
        let options = setup_dataset("instances_frame_source_valid.json");
        let err = extract_frames_from_mp4(ExtractFramesFromMp4Options {
            dataset_root: options.dataset_root,
            coco_json_path: options.coco_json_path,
            mp4_path: options.mp4_path,
            ffmpeg_bin: None,
            ffprobe_bin: None,
        })
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("failed to run ffprobe for MP4 introspection"));
    }

    #[test]
    fn extraction_reports_out_of_range_frame_when_ffmpeg_produces_no_output() {
        let options = setup_dataset("instances_frame_source_valid.json");
        let tool_root = unique_temp_dir();
        fs::create_dir_all(&tool_root).unwrap();

        let ffprobe_script = tool_root.join("ffprobe");
        fs::write(&ffprobe_script, "#!/usr/bin/env bash\necho 16\n").unwrap();
        let ffmpeg_script = tool_root.join("ffmpeg");
        fs::write(&ffmpeg_script, "#!/usr/bin/env bash\nexit 0\n").unwrap();
        fs::set_permissions(&ffprobe_script, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&ffmpeg_script, fs::Permissions::from_mode(0o755)).unwrap();

        let err = extract_frames_from_mp4(ExtractFramesFromMp4Options {
            dataset_root: options.dataset_root,
            coco_json_path: options.coco_json_path,
            mp4_path: options.mp4_path,
            ffmpeg_bin: Some(ffmpeg_script.display().to_string()),
            ffprobe_bin: Some(ffprobe_script.display().to_string()),
        })
        .unwrap_err();

        assert!(err
            .to_string()
            .contains("ffmpeg did not produce output for frame index"));
    }
}
