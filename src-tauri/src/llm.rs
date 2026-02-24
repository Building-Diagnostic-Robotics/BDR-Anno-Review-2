use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use engine::FaceView;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use tauri::{path::BaseDirectory, AppHandle, Manager};

use crate::settings::{LlmProviderSettings, LlmSettings};

const OPENAI_URL: &str = "https://api.openai.com/v1/responses";
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const CODE_INTERPRETER_MEMORY_LIMIT: &str = "4g";
const TOOL_CHOICE_REQUIRED_ENV: &str = "BDR_OPENAI_TOOL_CHOICE_REQUIRED";
const CODE_EXECUTION_ENABLED_ENV: &str = "BDR_LLM_CODE_EXECUTION_ENABLED";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionRequest {
    pub dataset_root: String,
    pub face_id: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionBox {
    pub bbox: [f64; 4],
    pub confidence: Option<f64>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionResponse {
    pub face_id: String,
    pub provider: String,
    pub model: String,
    pub suggestions: Vec<SuggestionBox>,
    pub attempts: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStateItem {
    pub face_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStateResponse {
    pub items: Vec<QueueStateItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionQueuePrefetchRequest {
    pub dataset_root: String,
    pub face_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SuggestionQueue {
    pub states: HashMap<(String, String), String>,
}

impl SuggestionQueue {
    pub fn new() -> Self {
        Self {
            states: HashMap::new(),
        }
    }

    pub fn state(&self, dataset_root: &str, face_ids: &[String]) -> QueueStateResponse {
        let mut items = Vec::with_capacity(face_ids.len());
        for face_id in face_ids {
            items.push(QueueStateItem {
                face_id: face_id.clone(),
                status: self
                    .states
                    .get(&(dataset_root.to_owned(), face_id.clone()))
                    .cloned()
                    .unwrap_or_else(|| "unseen".to_owned()),
            });
        }
        QueueStateResponse { items }
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ParsedSuggestions {
    Object(ParsedSuggestionObject),
    Boxes(Vec<ParsedSuggestionItem>),
    NoDefects(String),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ParsedSuggestionObject {
    boxes: Vec<ParsedPixelSuggestionItem>,
    image_size: ParsedImageSize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ParsedPixelSuggestionItem {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    confidence: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ParsedImageSize {
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ParsedSuggestionItem {
    xmin: f64,
    ymin: f64,
    xmax: f64,
    ymax: f64,
    confidence: Option<f64>,
}

pub fn prompt_text(app: &AppHandle) -> Result<String, String> {
    let resource_path = app
        .path()
        .resolve("prompts/suggest_boxes_v1.txt", BaseDirectory::Resource)
        .map_err(|source| format!("failed to resolve bundled prompt resource path: {source}"))?;
    if resource_path.is_file() {
        return fs::read_to_string(&resource_path).map_err(|source| {
            format!(
                "failed to read bundled prompt resource `{}`: {source}",
                resource_path.display()
            )
        });
    }

    let dev_path = PathBuf::from("src-tauri/prompts/suggest_boxes_v1.txt");
    if dev_path.is_file() {
        return fs::read_to_string(&dev_path).map_err(|source| {
            format!(
                "failed to read prompt file `{}`: {source}",
                dev_path.display()
            )
        });
    }

    Err(format!(
        "prompt file was not found in bundled resources (`{}`) or dev fallback (`{}`)",
        resource_path.display(),
        dev_path.display()
    ))
}

pub fn build_face_context(
    dataset_root: &str,
    face: &FaceView,
) -> Result<(String, String, [f64; 2]), String> {
    let image_path = PathBuf::from(dataset_root).join(&face.image_path);
    let bytes = fs::read(&image_path).map_err(|source| {
        format!(
            "failed to read face image for suggestions `{}`: {source}",
            image_path.display()
        )
    })?;
    let base64_image = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    };
    let media_type = match image::guess_format(&bytes).map_err(|source| {
        format!(
            "failed to detect image format for `{}`: {source}",
            image_path.display()
        )
    })? {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::Gif => "image/gif",
        image::ImageFormat::WebP => "image/webp",
        _ => {
            return Err(format!(
                "unsupported face image format for `{}`; supported media types: image/jpeg, image/png, image/gif, image/webp",
                image_path.display()
            ))
        }
    }
    .to_owned();
    let dimensions = image::image_dimensions(&image_path).map_err(|source| {
        format!(
            "failed to determine image dimensions for `{}`: {source}",
            image_path.display()
        )
    })?;
    Ok((
        base64_image,
        media_type,
        [dimensions.0 as f64, dimensions.1 as f64],
    ))
}

fn parse_json_suggestions(
    raw: &str,
    width: f64,
    height: f64,
) -> Result<Vec<SuggestionBox>, String> {
    let parsed: ParsedSuggestions = serde_json::from_str(raw)
        .map_err(|source| format!("provider response was not valid suggestion JSON: {source}"))?;

    if let ParsedSuggestions::NoDefects(value) = &parsed {
        if value.trim() == "No defects detected" {
            return Ok(Vec::new());
        }
    }

    let mut out = Vec::new();
    let mut invalid_count = 0usize;

    match parsed {
        ParsedSuggestions::Object(value) => {
            if !(value.image_size.width.is_finite() && value.image_size.height.is_finite()) {
                return Err(
                    "provider response image_size must contain finite width/height".to_owned(),
                );
            }
            for entry in value.boxes {
                let ParsedPixelSuggestionItem {
                    x,
                    y,
                    w,
                    h,
                    confidence,
                } = entry;
                if !(x.is_finite() && y.is_finite() && w.is_finite() && h.is_finite()) {
                    invalid_count += 1;
                    continue;
                }
                if w <= 0.0 || h <= 0.0 {
                    invalid_count += 1;
                    continue;
                }
                out.push(SuggestionBox {
                    bbox: [
                        x.clamp(0.0, width.max(0.0)),
                        y.clamp(0.0, height.max(0.0)),
                        w.clamp(0.0, width.max(0.0)),
                        h.clamp(0.0, height.max(0.0)),
                    ],
                    confidence,
                    source: "llm".to_owned(),
                });
            }
        }
        ParsedSuggestions::Boxes(entries) => {
            for entry in entries {
                let ParsedSuggestionItem {
                    xmin,
                    ymin,
                    xmax,
                    ymax,
                    confidence,
                } = entry;
                if !(xmin.is_finite() && ymin.is_finite() && xmax.is_finite() && ymax.is_finite()) {
                    invalid_count += 1;
                    continue;
                }
                let clamped_xmin = xmin.clamp(0.0, 1.0);
                let clamped_ymin = ymin.clamp(0.0, 1.0);
                let clamped_xmax = xmax.clamp(0.0, 1.0);
                let clamped_ymax = ymax.clamp(0.0, 1.0);
                if clamped_xmax <= clamped_xmin || clamped_ymax <= clamped_ymin {
                    invalid_count += 1;
                    continue;
                }

                let clamped_x = clamped_xmin * width.max(0.0);
                let clamped_y = clamped_ymin * height.max(0.0);
                let clamped_w = (clamped_xmax - clamped_xmin) * width.max(0.0);
                let clamped_h = (clamped_ymax - clamped_ymin) * height.max(0.0);
                out.push(SuggestionBox {
                    bbox: [clamped_x, clamped_y, clamped_w, clamped_h],
                    confidence,
                    source: "llm".to_owned(),
                });
            }
        }
        ParsedSuggestions::NoDefects(_) => {
            return Err(
                "provider response string must be exactly `No defects detected` for negative cases"
                    .to_owned(),
            )
        }
    }

    out.sort_by(|a, b| {
        b.confidence
            .unwrap_or(0.0)
            .total_cmp(&a.confidence.unwrap_or(0.0))
            .then_with(|| a.bbox[1].total_cmp(&b.bbox[1]))
            .then_with(|| a.bbox[0].total_cmp(&b.bbox[0]))
    });

    if invalid_count > 0 {
        return Err(format!(
            "provider response contained {invalid_count} invalid bbox entr{}; refusing partial parse",
            if invalid_count == 1 { "y" } else { "ies" }
        ));
    }

    Ok(out)
}

fn code_execution_enabled() -> bool {
    std::env::var(CODE_EXECUTION_ENABLED_ENV)
        .ok()
        .map(|value| !(value == "0" || value.eq_ignore_ascii_case("false")))
        .unwrap_or(true)
}

fn reasoning_budget(preset: &str) -> serde_json::Value {
    match preset {
        "low" => serde_json::json!({"effort": "low"}),
        "balanced" => serde_json::json!({"effort": "medium"}),
        _ => serde_json::json!({"effort": "high"}),
    }
}

fn anthropic_thinking(preset: &str) -> serde_json::Value {
    match preset {
        "low" => serde_json::json!({"type": "enabled", "budget_tokens": 1024}),
        "balanced" => serde_json::json!({"type": "enabled", "budget_tokens": 2048}),
        _ => serde_json::json!({"type": "enabled", "budget_tokens": 4096}),
    }
}

fn extract_openai_text(value: &serde_json::Value) -> Option<String> {
    let output = value.get("output")?.as_array()?;
    for item in output {
        if item.get("type").and_then(|v| v.as_str()) != Some("message") {
            continue;
        }
        let content = item.get("content")?.as_array()?;
        for part in content {
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                return Some(text.to_owned());
            }
        }
    }
    None
}

fn extract_anthropic_text(value: &serde_json::Value) -> Option<String> {
    let content = value.get("content")?.as_array()?;
    let mut first_text: Option<String> = None;
    for part in content {
        let part_type = part
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        if part_type != "text" {
            if cfg!(debug_assertions) {
                eprintln!("anthropic non-text content block: {part}");
            }
            continue;
        }
        if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
            if first_text.is_none() {
                first_text = Some(text.to_owned());
            }
            let trimmed = text.trim();
            if trimmed.starts_with('{')
                || trimmed.starts_with('[')
                || trimmed == "\"No defects detected\""
            {
                return Some(text.to_owned());
            }
        }
    }
    first_text
}

fn run_openai(
    api_key: &str,
    model: &str,
    prompt: &str,
    image_b64: &str,
    timeout: Duration,
    reasoning_preset: &str,
) -> Result<String, String> {
    let code_exec_enabled = code_execution_enabled();
    let tool_choice_required = std::env::var(TOOL_CHOICE_REQUIRED_ENV)
        .ok()
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let body = build_openai_response_body(
        model,
        prompt,
        image_b64,
        reasoning_preset,
        code_exec_enabled,
        tool_choice_required,
    );

    let value = post_openai_response(api_key, timeout, &body)?;
    extract_openai_text(&value)
        .ok_or_else(|| "openai response did not contain message text".to_owned())
}

fn build_openai_response_body(
    model: &str,
    prompt: &str,
    image_b64: &str,
    reasoning_preset: &str,
    code_exec_enabled: bool,
    tool_choice_required: bool,
) -> serde_json::Value {
    // Responses multimodal format (Vision guide): input = [{ role, content: [input_text, input_image] }]
    // https://developers.openai.com/api/docs/guides/images-vision/
    // Code Interpreter tool shape + container settings:
    // https://developers.openai.com/api/docs/guides/tools-code-interpreter/
    let mut body = serde_json::json!({
        "model": model,
        "reasoning": reasoning_budget(reasoning_preset),
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": format!("data:image/png;base64,{image_b64}")}
            ]
        }]
    });
    if code_exec_enabled {
        body["tools"] = serde_json::json!([{
            "type": "code_interpreter",
            "container": {
                "type": "auto",
                "memory_limit": CODE_INTERPRETER_MEMORY_LIMIT
            }
        }]);
    }
    if tool_choice_required {
        body["tool_choice"] = serde_json::Value::String("required".to_owned());
    }
    body
}

fn post_openai_response(
    api_key: &str,
    timeout: Duration,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(OPENAI_URL)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .map_err(|source| format!("openai request failed: {source}"))?;

    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .map_err(|source| format!("openai response parse failed: {source}"))?;
    if !status.is_success() {
        return Err(format!("openai returned HTTP {status}: {value}"));
    }
    Ok(value)
}

fn build_anthropic_message_body(
    model: &str,
    prompt: &str,
    image_b64: &str,
    image_media_type: &str,
    reasoning_preset: &str,
    code_exec_enabled: bool,
) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "max_tokens": 1200,
        "thinking": anthropic_thinking(reasoning_preset),
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image_media_type,
                        "data": image_b64
                    }
                }
            ]
        }],
        "tools": if code_exec_enabled {
            serde_json::json!([{"type": "code_execution_20250825", "name": "code_execution"}])
        } else {
            serde_json::json!([])
        }
    })
}

fn run_anthropic(
    api_key: &str,
    model: &str,
    prompt: &str,
    image_b64: &str,
    image_media_type: &str,
    timeout: Duration,
    reasoning_preset: &str,
) -> Result<String, String> {
    let client = Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let code_exec_enabled = code_execution_enabled();
    let body = build_anthropic_message_body(
        model,
        prompt,
        image_b64,
        image_media_type,
        reasoning_preset,
        code_exec_enabled,
    );
    let response = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|source| format!("anthropic request failed: {source}"))?;

    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .map_err(|source| format!("anthropic response parse failed: {source}"))?;
    if !status.is_success() {
        return Err(format!("anthropic returned HTTP {status}: {value}"));
    }

    extract_anthropic_text(&value)
        .ok_or_else(|| "anthropic response did not contain text content".to_owned())
}

fn selected_provider(
    settings: &LlmSettings,
) -> Result<(&'static str, &LlmProviderSettings), String> {
    if settings.openai.enabled {
        return Ok(("openai", &settings.openai));
    }
    if settings.anthropic.enabled {
        return Ok(("anthropic", &settings.anthropic));
    }
    Err("no LLM provider is enabled in settings".to_owned())
}

fn sanitize_error(error: &str, secrets: &[String]) -> String {
    let mut redacted = error.to_owned();
    for secret in secrets {
        if !secret.is_empty() {
            redacted = redacted.replace(secret, "[REDACTED]");
        }
    }
    redacted
}

pub fn generate_suggestions_with_retry(
    app: &AppHandle,
    settings: &LlmSettings,
    face: &FaceView,
    dataset_root: &str,
    openai_key: Option<&str>,
    anthropic_key: Option<&str>,
    timeout_ms: Option<u64>,
) -> Result<SuggestionResponse, String> {
    let (provider_id, provider_settings) = selected_provider(settings)?;
    let model = provider_settings.model.trim();
    if model.is_empty() {
        return Err(format!("{provider_id} model is not configured"));
    }

    let prompt = prompt_text(app)?;
    let (image_b64, image_media_type, [width, height]) = build_face_context(dataset_root, face)?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));

    let mut attempts = 0usize;
    let mut last_error = String::new();
    let keys = vec![
        openai_key.unwrap_or_default().to_owned(),
        anthropic_key.unwrap_or_default().to_owned(),
    ];

    for backoff_ms in [0_u64, 400, 1200] {
        if backoff_ms > 0 {
            std::thread::sleep(Duration::from_millis(backoff_ms));
        }
        attempts += 1;
        let result = match provider_id {
            "openai" => {
                let key =
                    openai_key.ok_or_else(|| "OpenAI API key is not configured".to_owned())?;
                run_openai(
                    key,
                    model,
                    &prompt,
                    &image_b64,
                    &image_media_type,
                    timeout,
                    settings.reasoning_preset.as_str(),
                )
            }
            "anthropic" => {
                let key = anthropic_key
                    .ok_or_else(|| "Anthropic API key is not configured".to_owned())?;
                run_anthropic(
                    key,
                    model,
                    &prompt,
                    &image_b64,
                    &image_media_type,
                    timeout,
                    settings.reasoning_preset.as_str(),
                )
            }
            _ => Err(format!("unsupported provider `{provider_id}`")),
        };

        match result {
            Ok(raw_text) => {
                let suggestions = parse_json_suggestions(&raw_text, width, height)?;
                return Ok(SuggestionResponse {
                    face_id: face.face_id.clone(),
                    provider: provider_id.to_owned(),
                    model: model.to_owned(),
                    suggestions,
                    attempts,
                });
            }
            Err(error) => {
                last_error = sanitize_error(&error, &keys);
                let lower = last_error.to_lowercase();
                let retryable = lower.contains("timeout")
                    || lower.contains("429")
                    || lower.contains("rate")
                    || lower.contains("500")
                    || lower.contains("502")
                    || lower.contains("503")
                    || lower.contains("504");
                if !retryable {
                    break;
                }
            }
        }
    }

    Err(format!(
        "suggestion request failed after {attempts} attempt(s): {last_error}"
    ))
}

#[cfg(test)]
mod tests {
    use super::{build_openai_response_body, parse_json_suggestions, SuggestionQueue};
    use std::time::Duration;

    fn response_has_code_interpreter_output(value: &serde_json::Value) -> bool {
        let output = match value.get("output").and_then(|v| v.as_array()) {
            Some(items) => items,
            None => return false,
        };
        output.iter().any(|item| {
            item.get("type").and_then(|v| v.as_str()) == Some("code_interpreter_call")
                || item.get("tool_name").and_then(|v| v.as_str()) == Some("code_interpreter")
        })
    }

    const TEST_IMAGE_B64_PNG_1X1: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W7xkAAAAASUVORK5CYII=";

    #[test]
    fn parser_converts_normalized_boxes_and_sorts() {
        let raw = r#"[{"xmin":-0.2,"ymin":0.5,"xmax":1.2,"ymax":1.0,"confidence":0.2},{"xmin":0.25,"ymin":0.25,"xmax":0.75,"ymax":0.75,"confidence":0.9}]"#;
        let parsed = parse_json_suggestions(raw, 20.0, 20.0).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].bbox, [5.0, 5.0, 10.0, 10.0]);
        assert_eq!(parsed[1].bbox, [0.0, 10.0, 20.0, 10.0]);
    }

    #[test]
    fn parser_handles_no_defects_response() {
        let parsed = parse_json_suggestions(r#""No defects detected""#, 20.0, 20.0).unwrap();
        assert!(parsed.is_empty());
    }

    #[test]
    fn parser_rejects_non_json() {
        let err = parse_json_suggestions("not json", 20.0, 20.0).unwrap_err();
        assert!(err.contains("not valid suggestion JSON"));
    }

    #[test]
    fn parser_rejects_any_invalid_bbox_entry() {
        let raw = r#"[{"xmin":0.1,"ymin":0.1,"xmax":0.2,"ymax":0.2},{"xmin":0.8,"ymin":0.8,"xmax":0.7,"ymax":0.9}]"#;
        let err = parse_json_suggestions(raw, 20.0, 20.0).unwrap_err();
        assert!(err.contains("invalid bbox"));
    }

    #[test]
    fn queue_state_is_scoped_by_dataset_root() {
        let mut queue = SuggestionQueue::new();
        queue.states.insert(
            ("/dataset-a".to_owned(), "face-001".to_owned()),
            "ready".to_owned(),
        );

        let response_a = queue.state("/dataset-a", &["face-001".to_owned()]);
        assert_eq!(response_a.items[0].status, "ready");

        let response_b = queue.state("/dataset-b", &["face-001".to_owned()]);
        assert_eq!(response_b.items[0].status, "unseen");
    }

    #[test]
    fn openai_payload_matches_responses_multimodal_tool_format() {
        let payload = build_openai_response_body(
            "gpt-5.2",
            "find boxes",
            TEST_IMAGE_B64_PNG_1X1,
            "high",
            true,
            false,
        );
        assert_eq!(payload["input"][0]["role"], "user");
        assert_eq!(payload["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(payload["input"][0]["content"][1]["type"], "input_image");
        assert_eq!(payload["tools"][0]["type"], "code_interpreter");
        assert_eq!(payload["tools"][0]["container"]["type"], "auto");
        assert_eq!(payload["tools"][0]["container"]["memory_limit"], "4g");
        assert!(payload.get("tool_choice").is_none());
    }

    #[test]
    fn openai_payload_can_require_tool_choice_for_debug_smoke() {
        let payload = build_openai_response_body(
            "gpt-5.2",
            "run python",
            TEST_IMAGE_B64_PNG_1X1,
            "high",
            true,
            true,
        );
        assert_eq!(payload["tool_choice"], "required");
    }

    #[test]
    fn openai_payload_golden_json() {
        let payload = build_openai_response_body(
            "gpt-5.2",
            "find boxes",
            TEST_IMAGE_B64_PNG_1X1,
            "low",
            true,
            false,
        );
        let actual = serde_json::to_string_pretty(&payload).expect("payload should serialize");
        let expected = r#"{
  "input": [
    {
      "content": [
        {
          "text": "find boxes",
          "type": "input_text"
        },
        {
          "image_url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W7xkAAAAASUVORK5CYII=",
          "type": "input_image"
        }
      ],
      "role": "user"
    }
  ],
  "model": "gpt-5.2",
  "reasoning": {
    "effort": "low"
  },
  "tools": [
    {
      "container": {
        "memory_limit": "4g",
        "type": "auto"
      },
      "type": "code_interpreter"
    }
  ]
}"#;
        assert_eq!(actual, expected);
    }

    #[test]
    fn openai_payload_can_disable_code_execution_tool() {
        let payload = build_openai_response_body(
            "gpt-5.2",
            "find boxes",
            TEST_IMAGE_B64_PNG_1X1,
            "low",
            false,
            false,
        );
        assert!(payload.get("tools").is_none());
    }

    #[test]
    fn parser_accepts_object_box_schema() {
        let raw = r#"{"boxes":[{"x":5,"y":6,"w":7,"h":8,"confidence":0.7}],"image_size":{"width":20,"height":10}}"#;
        let parsed = parse_json_suggestions(raw, 20.0, 10.0).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].bbox, [5.0, 6.0, 7.0, 8.0]);
    }

    #[test]
    fn extract_anthropic_text_prefers_json_block() {
        let response = serde_json::json!({
            "content": [
                {"type": "tool_use", "id": "tool_1"},
                {"type": "text", "text": "thinking..."},
                {"type": "text", "text": "{\"boxes\":[],\"image_size\":{\"width\":1,\"height\":1}}"}
            ]
        });
        let text = super::extract_anthropic_text(&response).expect("text expected");
        assert!(text.contains("\"boxes\""));
    }

    #[test]
    fn anthropic_payload_uses_base64_block_and_code_execution_tool() {
        let payload = super::build_anthropic_message_body(
            "claude-sonnet-4-6",
            "find boxes",
            TEST_IMAGE_B64_PNG_1X1,
            "image/png",
            "low",
            true,
        );
        assert_eq!(payload["messages"][0]["content"][0]["type"], "text");
        assert_eq!(payload["messages"][0]["content"][1]["type"], "image");
        assert_eq!(
            payload["messages"][0]["content"][1]["source"]["type"],
            "base64"
        );
        assert_eq!(
            payload["messages"][0]["content"][1]["source"]["media_type"],
            "image/png"
        );
        assert_eq!(
            payload["messages"][0]["content"][1]["source"]["data"],
            TEST_IMAGE_B64_PNG_1X1
        );
        assert_eq!(payload["tools"][0]["type"], "code_execution_20250825");
        assert_eq!(payload["tools"][0]["name"], "code_execution");
    }

    #[test]
    fn detects_code_interpreter_output_items() {
        let response = serde_json::json!({
            "output": [
                {"type": "message", "content": [{"type": "output_text", "text": "ok"}]},
                {"type": "code_interpreter_call", "id": "tool_123"}
            ]
        });
        assert!(response_has_code_interpreter_output(&response));
    }

    #[test]
    #[ignore = "requires OPENAI_API_KEY and network access"]
    fn code_interpreter_smoke_executes_python_when_required() {
        let api_key = std::env::var("OPENAI_API_KEY").expect("OPENAI_API_KEY must be set");
        let body = build_openai_response_body(
            "gpt-5.2",
            "Run Python to compute the sum of [2, 3, 5], then respond with just the integer result.",
            TEST_IMAGE_B64_PNG_1X1,
            "low",
            true,
            true,
        );
        let response = super::post_openai_response(&api_key, Duration::from_secs(45), &body)
            .expect("responses API request should succeed");
        assert!(
            response_has_code_interpreter_output(&response),
            "expected code interpreter output item in response: {response}"
        );
    }

    #[test]
    #[ignore = "requires ANTHROPIC_API_KEY, ANTHROPIC_SMOKE_IMAGE_PATH and network access"]
    fn anthropic_vision_code_execution_smoke() {
        let api_key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY must be set");
        let image_path = std::env::var("ANTHROPIC_SMOKE_IMAGE_PATH")
            .expect("ANTHROPIC_SMOKE_IMAGE_PATH must be set to a local image path");
        let image_bytes = std::fs::read(&image_path).expect("image path should be readable");
        use base64::Engine;
        let image_b64 = base64::engine::general_purpose::STANDARD.encode(image_bytes);

        let prompt = r#"Return strict JSON only in this exact shape:
{"boxes":[{"x":0,"y":0,"w":0,"h":0}],"image_size":{"width":0,"height":0}}
Find a single obvious object and provide exactly one bounding box. You may use the code_execution tool to validate that IoU((0,0,10,10),(0,0,5,5)) = 0.25."#;
        let text = super::run_anthropic(
            &api_key,
            "claude-sonnet-4-6",
            prompt,
            &image_b64,
            "image/png",
            Duration::from_secs(45),
            "low",
        )
        .expect("anthropic request should succeed");
        println!("raw anthropic response text: {text}");
        let parsed: serde_json::Value =
            serde_json::from_str(&text).expect("response should parse as json");
        println!("parsed anthropic json: {parsed}");
    }
}
