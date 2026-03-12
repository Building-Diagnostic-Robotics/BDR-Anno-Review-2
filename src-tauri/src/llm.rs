use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

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
const DEFAULT_CODE_EXECUTION_ENABLED: bool = true;
pub const DEFAULT_SUGGESTION_TIMEOUT_MS: u64 = 180_000;
const OPENAI_CONNECT_TIMEOUT_SECS: u64 = 10;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<SuggestionDiagnostics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionDiagnostics {
    pub tool_enabled: bool,
    pub output_mode: String,
    pub provider_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_response_id: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuggestionFailureCategory {
    Authentication,
    Configuration,
    ProviderContract,
    RateLimit,
    Refusal,
    Server,
    StructuredOutput,
    Transport,
    Unknown,
}

impl SuggestionFailureCategory {
    pub fn is_retryable(self) -> bool {
        matches!(
            self,
            SuggestionFailureCategory::RateLimit
                | SuggestionFailureCategory::Server
                | SuggestionFailureCategory::Transport
        )
    }

    pub fn should_persist_failure(self) -> bool {
        true
    }
}

#[derive(Debug, Clone)]
pub struct SuggestionGenerationError {
    pub category: SuggestionFailureCategory,
    pub message: String,
}

impl std::fmt::Display for SuggestionGenerationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SuggestionGenerationError {}

#[derive(Debug, Clone)]
struct ProviderExecutionContext<'a> {
    provider_id: &'static str,
    model: &'a str,
    prompt: &'a str,
    image_b64: &'a str,
    image_media_type: &'a str,
    timeout: Duration,
    reasoning_preset: &'a str,
    width: f64,
    height: f64,
    tool_enabled: bool,
}

#[derive(Debug, Clone)]
struct ProviderExecutionSuccess {
    suggestions: Vec<SuggestionBox>,
    metadata: SuggestionDiagnostics,
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
        base64::engine::general_purpose::STANDARD.encode(&bytes)
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
            if value.image_size.width <= 0.0 || value.image_size.height <= 0.0 {
                return Err(
                    "provider response image_size must contain positive width/height".to_owned(),
                );
            }
            if value.image_size.width != width || value.image_size.height != height {
                return Err(format!(
                    "provider response image_size ({}, {}) did not match actual image size ({width}, {height})",
                    value.image_size.width, value.image_size.height
                ));
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
                let clamped_x = x.clamp(0.0, width.max(0.0));
                let clamped_y = y.clamp(0.0, height.max(0.0));
                let max_w = (width - clamped_x).max(0.0);
                let max_h = (height - clamped_y).max(0.0);
                let clamped_w = w.clamp(0.0, max_w);
                let clamped_h = h.clamp(0.0, max_h);
                if clamped_w <= 0.0 || clamped_h <= 0.0 {
                    invalid_count += 1;
                    continue;
                }
                out.push(SuggestionBox {
                    bbox: [clamped_x, clamped_y, clamped_w, clamped_h],
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
        .unwrap_or(DEFAULT_CODE_EXECUTION_ENABLED)
}

pub fn suggestion_tool_settings(provider_id: &str) -> serde_json::Value {
    let tool_choice_required = openai_tool_choice_required();
    serde_json::json!({
        "codeExecutionEnabled": code_execution_enabled(),
        "toolChoiceRequired": provider_id == "openai" && tool_choice_required,
    })
}

fn openai_tool_choice_required() -> bool {
    let tool_choice_required = std::env::var(TOOL_CHOICE_REQUIRED_ENV)
        .ok()
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    tool_choice_required
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

fn suggestion_output_schema() -> serde_json::Value {
    serde_json::json!({
        "anyOf": [
            {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "boxes": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "x": { "type": "number" },
                                "y": { "type": "number" },
                                "w": { "type": "number" },
                                "h": { "type": "number" }
                            },
                            "required": ["x", "y", "w", "h"]
                        }
                    },
                    "image_size": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                            "width": { "type": "number" },
                            "height": { "type": "number" }
                        },
                        "required": ["width", "height"]
                    }
                },
                "required": ["boxes", "image_size"]
            },
            {
                "type": "string",
                "const": "No defects detected"
            }
        ]
    })
}

fn truncate_for_error(text: &str, max_len: usize) -> String {
    let mut out = String::new();
    for ch in text.chars().take(max_len) {
        out.push(ch);
    }
    if text.chars().count() > max_len {
        out.push_str("...");
    }
    out
}

fn provider_status_from_response(value: &serde_json::Value, fallback: &str) -> String {
    value
        .get("status")
        .and_then(|raw| raw.as_str())
        .or_else(|| value.get("stop_reason").and_then(|raw| raw.as_str()))
        .unwrap_or(fallback)
        .to_owned()
}

fn provider_response_id(value: &serde_json::Value) -> Option<String> {
    value
        .get("id")
        .and_then(|raw| raw.as_str())
        .map(|value| value.to_owned())
}

fn suggestion_diagnostics(
    tool_enabled: bool,
    output_mode: &str,
    provider_status: String,
    provider_response_id: Option<String>,
) -> SuggestionDiagnostics {
    SuggestionDiagnostics {
        tool_enabled,
        output_mode: output_mode.to_owned(),
        provider_status,
        provider_response_id,
    }
}

fn generation_error(
    category: SuggestionFailureCategory,
    message: impl Into<String>,
) -> SuggestionGenerationError {
    SuggestionGenerationError {
        category,
        message: message.into(),
    }
}

fn parse_provider_suggestions(
    provider: &str,
    raw: &str,
    width: f64,
    height: f64,
    diagnostics: &SuggestionDiagnostics,
) -> Result<Vec<SuggestionBox>, SuggestionGenerationError> {
    parse_json_suggestions(raw, width, height).map_err(|source| {
        generation_error(
            SuggestionFailureCategory::StructuredOutput,
            format!(
                "{provider} structured output failed validation (status={}, mode={}): {source}",
                diagnostics.provider_status, diagnostics.output_mode
            ),
        )
    })
}

fn openai_message_text(
    value: &serde_json::Value,
) -> Result<(&serde_json::Value, &'static str), SuggestionGenerationError> {
    if let Some(error) = value.get("error").filter(|entry| !entry.is_null()) {
        return Err(generation_error(
            SuggestionFailureCategory::ProviderContract,
            format!("openai response included an error payload: {error}"),
        ));
    }

    let status = provider_status_from_response(value, "unknown");
    if status == "failed" {
        return Err(generation_error(
            SuggestionFailureCategory::Server,
            format!("openai response status was `failed`: {value}"),
        ));
    }
    if status == "incomplete" {
        let details = value
            .get("incomplete_details")
            .map(|entry| entry.to_string())
            .unwrap_or_else(|| "missing incomplete_details".to_owned());
        return Err(generation_error(
            SuggestionFailureCategory::ProviderContract,
            format!("openai response was incomplete: {details}"),
        ));
    }

    let output = value
        .get("output")
        .and_then(|entry| entry.as_array())
        .ok_or_else(|| {
            generation_error(
                SuggestionFailureCategory::ProviderContract,
                format!("openai response did not contain an output array (status={status})"),
            )
        })?;

    for item in output {
        if item.get("type").and_then(|entry| entry.as_str()) != Some("message") {
            continue;
        }
        let Some(content) = item.get("content").and_then(|entry| entry.as_array()) else {
            continue;
        };
        for part in content {
            if part.get("type").and_then(|entry| entry.as_str()) == Some("refusal") {
                let refusal = part
                    .get("refusal")
                    .or_else(|| part.get("text"))
                    .map(|entry| entry.to_string())
                    .unwrap_or_else(|| "model refused".to_owned());
                return Err(generation_error(
                    SuggestionFailureCategory::Refusal,
                    format!("openai refused the request: {refusal}"),
                ));
            }
            if let Some(structured) = part.get("json").or_else(|| part.get("parsed")) {
                return Ok((structured, "structured_output"));
            }
        }
        for part in content {
            if part
                .get("output_text")
                .and_then(|entry| entry.as_str())
                .or_else(|| part.get("text").and_then(|entry| entry.as_str()))
                .is_some()
            {
                return Ok((part, "text_fallback"));
            }
        }
    }

    if value
        .get("output_text")
        .and_then(|entry| entry.as_str())
        .is_some()
    {
        return Ok((value.get("output_text").unwrap_or(value), "text_fallback"));
    }

    Err(generation_error(
        SuggestionFailureCategory::ProviderContract,
        format!("openai response did not contain message content (status={status})"),
    ))
}

fn anthropic_message_text(value: &serde_json::Value) -> Result<String, SuggestionGenerationError> {
    if let Some(error) = value.get("error").filter(|entry| !entry.is_null()) {
        return Err(generation_error(
            SuggestionFailureCategory::ProviderContract,
            format!("anthropic response included an error payload: {error}"),
        ));
    }

    let content = value
        .get("content")
        .and_then(|entry| entry.as_array())
        .ok_or_else(|| {
            generation_error(
                SuggestionFailureCategory::ProviderContract,
                "anthropic response did not contain a content array",
            )
        })?;

    let mut first_text: Option<String> = None;
    for part in content {
        let part_type = part
            .get("type")
            .and_then(|entry| entry.as_str())
            .unwrap_or("unknown");
        if part_type != "text" {
            if cfg!(debug_assertions) {
                eprintln!("anthropic non-text content block: {part}");
            }
            continue;
        }
        if let Some(text) = part.get("text").and_then(|entry| entry.as_str()) {
            if first_text.is_none() {
                first_text = Some(text.to_owned());
            }
            let trimmed = text.trim();
            if trimmed.starts_with('{')
                || trimmed.starts_with('[')
                || trimmed == "\"No defects detected\""
            {
                return Ok(text.to_owned());
            }
        }
    }

    let preview = first_text
        .map(|text| truncate_for_error(&text, 160))
        .unwrap_or_else(|| "no text blocks".to_owned());
    Err(generation_error(
        SuggestionFailureCategory::ProviderContract,
        format!(
            "anthropic response did not contain JSON suggestion text; first text block: {preview}"
        ),
    ))
}

fn value_to_output_text(
    value: &serde_json::Value,
    category: SuggestionFailureCategory,
    provider: &str,
) -> Result<String, SuggestionGenerationError> {
    match value {
        serde_json::Value::String(_) => serde_json::to_string(value).map_err(|source| {
            generation_error(
                category,
                format!("{provider} response could not be serialized for parsing: {source}"),
            )
        }),
        serde_json::Value::Object(map) => {
            if let Some(text) = map
                .get("output_text")
                .and_then(|entry| entry.as_str())
                .or_else(|| map.get("text").and_then(|entry| entry.as_str()))
            {
                return Ok(text.to_owned());
            }
            serde_json::to_string(value).map_err(|source| {
                generation_error(
                    category,
                    format!("{provider} response could not be serialized for parsing: {source}"),
                )
            })
        }
        serde_json::Value::Array(_) => serde_json::to_string(value).map_err(|source| {
            generation_error(
                category,
                format!("{provider} response could not be serialized for parsing: {source}"),
            )
        }),
        _ => Err(generation_error(
            category,
            format!("{provider} response did not contain a JSON object/array/string payload"),
        )),
    }
}

fn format_error_chain(error: &dyn std::error::Error) -> String {
    let mut out = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        out.push_str("\ncaused by: ");
        out.push_str(&cause.to_string());
        source = cause.source();
    }
    out
}

fn reqwest_error_tags(error: &reqwest::Error) -> Vec<&'static str> {
    let mut tags = Vec::new();
    if error.is_builder() {
        tags.push("builder");
    }
    if error.is_request() {
        tags.push("request");
    }
    if error.is_timeout() {
        tags.push("timeout");
    }
    if error.is_connect() {
        tags.push("connect");
    }
    if error.is_redirect() {
        tags.push("redirect");
    }
    if error.is_status() {
        tags.push("status");
    }
    if error.is_body() {
        tags.push("body");
    }
    if error.is_decode() {
        tags.push("decode");
    }
    tags
}

fn proxy_mode_hint() -> String {
    let has_https = std::env::var("HTTPS_PROXY").is_ok() || std::env::var("https_proxy").is_ok();
    let has_http = std::env::var("HTTP_PROXY").is_ok() || std::env::var("http_proxy").is_ok();
    let has_all = std::env::var("ALL_PROXY").is_ok() || std::env::var("all_proxy").is_ok();
    let has_no_proxy = std::env::var("NO_PROXY").is_ok() || std::env::var("no_proxy").is_ok();

    let mut sources = Vec::new();
    if has_https {
        sources.push("https");
    }
    if has_http {
        sources.push("http");
    }
    if has_all {
        sources.push("all");
    }
    if sources.is_empty() {
        if has_no_proxy {
            "direct_or_platform_default(no_proxy_set)".to_owned()
        } else {
            "direct_or_platform_default".to_owned()
        }
    } else if has_no_proxy {
        format!("env_proxy({})+no_proxy_set", sources.join("|"))
    } else {
        format!("env_proxy({})", sources.join("|"))
    }
}

fn provider_status_error_category(status: reqwest::StatusCode) -> SuggestionFailureCategory {
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        SuggestionFailureCategory::Authentication
    } else if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        SuggestionFailureCategory::RateLimit
    } else if status.is_server_error() {
        SuggestionFailureCategory::Server
    } else {
        SuggestionFailureCategory::ProviderContract
    }
}

fn provider_http_client(
    provider: &str,
    timeout: Duration,
) -> Result<Client, SuggestionGenerationError> {
    let proxy_mode = proxy_mode_hint();

    Client::builder()
        .connect_timeout(Duration::from_secs(OPENAI_CONNECT_TIMEOUT_SECS))
        .timeout(timeout)
        .build()
        .map_err(|source| {
            generation_error(
                SuggestionFailureCategory::Transport,
                format!(
                    "{provider} client init failed (proxy_mode={proxy_mode}): {}",
                    format_error_chain(&source)
                ),
            )
        })
}

fn build_openai_response_body(
    model: &str,
    prompt: &str,
    image_b64: &str,
    image_media_type: &str,
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
        "text": {
            "format": {
                "type": "json_schema",
                "name": "roof_defect_boxes",
                "strict": true,
                "schema": suggestion_output_schema()
            }
        },
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": format!("data:{image_media_type};base64,{image_b64}")}
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
) -> Result<serde_json::Value, SuggestionGenerationError> {
    let client = provider_http_client("openai", timeout)?;

    let proxy_mode = proxy_mode_hint();
    let started_at = Instant::now();

    let response = client
        .post(OPENAI_URL)
        .bearer_auth(api_key)
        .json(body)
        .send()
        .map_err(|source| {
            let tags = reqwest_error_tags(&source);
            let tags_text = if tags.is_empty() {
                "none".to_owned()
            } else {
                tags.join(",")
            };
            let detail = format_error_chain(&source);
            let elapsed_ms = started_at.elapsed().as_millis();
            let category = if source.is_timeout() || source.is_connect() || source.is_request() {
                SuggestionFailureCategory::Transport
            } else {
                SuggestionFailureCategory::Unknown
            };
            generation_error(
                category,
                format!(
                    "openai request failed (class={tags_text}, proxy_mode={proxy_mode}, elapsed_ms={elapsed_ms}): {detail}"
                ),
            )
        })?;

    let status = response.status();
    let elapsed_ms = started_at.elapsed().as_millis();
    let value: serde_json::Value = response.json().map_err(|source| {
        generation_error(
            SuggestionFailureCategory::ProviderContract,
            format!(
                "openai response parse failed (proxy_mode={proxy_mode}, elapsed_ms={elapsed_ms}): {}",
                format_error_chain(&source)
            ),
        )
    })?;
    if !status.is_success() {
        return Err(generation_error(
            provider_status_error_category(status),
            format!(
                "openai returned HTTP {status} (proxy_mode={proxy_mode}, elapsed_ms={elapsed_ms}): {value}"
            ),
        ));
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

fn run_openai(
    api_key: &str,
    context: &ProviderExecutionContext<'_>,
) -> Result<ProviderExecutionSuccess, SuggestionGenerationError> {
    let tool_choice_required = openai_tool_choice_required();
    let body = build_openai_response_body(
        context.model,
        context.prompt,
        context.image_b64,
        context.image_media_type,
        context.reasoning_preset,
        context.tool_enabled,
        tool_choice_required,
    );
    let value = post_openai_response(api_key, context.timeout, &body)?;
    let response_status = provider_status_from_response(&value, "completed");
    let response_id = provider_response_id(&value);
    let (payload, output_mode) = openai_message_text(&value)?;
    let diagnostics = suggestion_diagnostics(
        context.tool_enabled,
        output_mode,
        response_status,
        response_id,
    );
    let raw_text = value_to_output_text(
        payload,
        SuggestionFailureCategory::ProviderContract,
        "openai",
    )?;
    let suggestions = parse_provider_suggestions(
        "openai",
        &raw_text,
        context.width,
        context.height,
        &diagnostics,
    )?;
    Ok(ProviderExecutionSuccess {
        suggestions,
        metadata: diagnostics,
    })
}

fn run_anthropic(
    api_key: &str,
    context: &ProviderExecutionContext<'_>,
) -> Result<ProviderExecutionSuccess, SuggestionGenerationError> {
    let client = provider_http_client("anthropic", context.timeout)?;
    let body = build_anthropic_message_body(
        context.model,
        context.prompt,
        context.image_b64,
        context.image_media_type,
        context.reasoning_preset,
        context.tool_enabled,
    );
    let response = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|source| {
            let category = if source.is_timeout() || source.is_connect() || source.is_request() {
                SuggestionFailureCategory::Transport
            } else {
                SuggestionFailureCategory::Unknown
            };
            generation_error(
                category,
                format!("anthropic request failed: {}", format_error_chain(&source)),
            )
        })?;

    let status = response.status();
    let value: serde_json::Value = response.json().map_err(|source| {
        generation_error(
            SuggestionFailureCategory::ProviderContract,
            format!(
                "anthropic response parse failed: {}",
                format_error_chain(&source)
            ),
        )
    })?;
    if !status.is_success() {
        return Err(generation_error(
            provider_status_error_category(status),
            format!("anthropic returned HTTP {status}: {value}"),
        ));
    }

    let response_status = provider_status_from_response(&value, "ok");
    let response_id = provider_response_id(&value);
    let diagnostics = suggestion_diagnostics(
        context.tool_enabled,
        "best_effort_text",
        response_status,
        response_id,
    );
    let raw_text = anthropic_message_text(&value)?;
    let suggestions = parse_provider_suggestions(
        "anthropic",
        &raw_text,
        context.width,
        context.height,
        &diagnostics,
    )?;
    Ok(ProviderExecutionSuccess {
        suggestions,
        metadata: diagnostics,
    })
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
) -> Result<SuggestionResponse, SuggestionGenerationError> {
    let (provider_id, provider_settings) = selected_provider(settings)
        .map_err(|source| generation_error(SuggestionFailureCategory::Configuration, source))?;
    let model = provider_settings.model.trim();
    if model.is_empty() {
        return Err(generation_error(
            SuggestionFailureCategory::Configuration,
            format!("{provider_id} model is not configured"),
        ));
    }

    let prompt = prompt_text(app)
        .map_err(|source| generation_error(SuggestionFailureCategory::Configuration, source))?;
    let (image_b64, image_media_type, [width, height]) = build_face_context(dataset_root, face)
        .map_err(|source| generation_error(SuggestionFailureCategory::Configuration, source))?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_SUGGESTION_TIMEOUT_MS));
    let context = ProviderExecutionContext {
        provider_id,
        model,
        prompt: &prompt,
        image_b64: &image_b64,
        image_media_type: &image_media_type,
        timeout,
        reasoning_preset: settings.reasoning_preset.as_str(),
        width,
        height,
        tool_enabled: code_execution_enabled(),
    };

    let mut attempts = 0usize;
    let mut last_error = String::new();
    let mut last_category = SuggestionFailureCategory::Unknown;
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
                let key = openai_key.ok_or_else(|| {
                    generation_error(
                        SuggestionFailureCategory::Configuration,
                        "OpenAI API key is not configured",
                    )
                })?;
                run_openai(key, &context)
            }
            "anthropic" => {
                let key = anthropic_key.ok_or_else(|| {
                    generation_error(
                        SuggestionFailureCategory::Configuration,
                        "Anthropic API key is not configured",
                    )
                })?;
                run_anthropic(key, &context)
            }
            _ => Err(generation_error(
                SuggestionFailureCategory::Configuration,
                format!("unsupported provider `{provider_id}`"),
            )),
        };

        match result {
            Ok(success) => {
                return Ok(SuggestionResponse {
                    face_id: face.face_id.clone(),
                    provider: context.provider_id.to_owned(),
                    model: model.to_owned(),
                    suggestions: success.suggestions,
                    attempts,
                    diagnostics: Some(success.metadata),
                });
            }
            Err(error) => {
                last_category = error.category;
                last_error = sanitize_error(&error.message, &keys);
                if !error.category.is_retryable() {
                    break;
                }
            }
        }
    }

    Err(generation_error(
        last_category,
        format!("suggestion request failed after {attempts} attempt(s): {last_error}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        anthropic_message_text, build_openai_response_body, openai_message_text,
        parse_json_suggestions, value_to_output_text, ProviderExecutionContext,
        SuggestionFailureCategory, SuggestionQueue,
    };
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
            "gpt-5.4",
            "find boxes",
            TEST_IMAGE_B64_PNG_1X1,
            "image/png",
            "high",
            true,
            false,
        );
        assert_eq!(payload["input"][0]["role"], "user");
        assert_eq!(payload["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(payload["input"][0]["content"][1]["type"], "input_image");
        assert_eq!(payload["text"]["format"]["type"], "json_schema");
        assert_eq!(payload["text"]["format"]["name"], "roof_defect_boxes");
        assert_eq!(
            payload["text"]["format"]["schema"]["anyOf"][1]["const"],
            "No defects detected"
        );
        assert_eq!(payload["tools"][0]["type"], "code_interpreter");
        assert_eq!(payload["tools"][0]["container"]["type"], "auto");
        assert_eq!(payload["tools"][0]["container"]["memory_limit"], "4g");
        assert!(payload.get("tool_choice").is_none());
    }

    #[test]
    fn openai_payload_can_require_tool_choice_for_debug_smoke() {
        let payload = build_openai_response_body(
            "gpt-5.4",
            "run python",
            TEST_IMAGE_B64_PNG_1X1,
            "image/png",
            "high",
            true,
            true,
        );
        assert_eq!(payload["tool_choice"], "required");
    }

    #[test]
    fn openai_payload_golden_json() {
        let payload = build_openai_response_body(
            "gpt-5.4",
            "find boxes",
            TEST_IMAGE_B64_PNG_1X1,
            "image/png",
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
  "model": "gpt-5.4",
  "reasoning": {
    "effort": "low"
  },
  "text": {
    "format": {
      "name": "roof_defect_boxes",
      "schema": {
        "anyOf": [
          {
            "additionalProperties": false,
            "properties": {
              "boxes": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "h": {
                      "type": "number"
                    },
                    "w": {
                      "type": "number"
                    },
                    "x": {
                      "type": "number"
                    },
                    "y": {
                      "type": "number"
                    }
                  },
                  "required": [
                    "x",
                    "y",
                    "w",
                    "h"
                  ],
                  "type": "object"
                },
                "type": "array"
              },
              "image_size": {
                "additionalProperties": false,
                "properties": {
                  "height": {
                    "type": "number"
                  },
                  "width": {
                    "type": "number"
                  }
                },
                "required": [
                  "width",
                  "height"
                ],
                "type": "object"
              }
            },
            "required": [
              "boxes",
              "image_size"
            ],
            "type": "object"
          },
          {
            "const": "No defects detected",
            "type": "string"
          }
        ]
      },
      "strict": true,
      "type": "json_schema"
    }
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
            "gpt-5.4",
            "find boxes",
            TEST_IMAGE_B64_PNG_1X1,
            "image/png",
            "low",
            false,
            false,
        );
        assert!(payload.get("tools").is_none());
    }

    #[test]
    fn openai_message_text_accepts_structured_json_payloads() {
        let response = serde_json::json!({
            "output": [
                {
                    "type": "message",
                    "content": [
                        {
                            "type": "output_json",
                            "json": {
                                "boxes": [],
                                "image_size": { "width": 1, "height": 1 }
                            }
                        }
                    ]
                }
            ]
        });
        let (payload, mode) = openai_message_text(&response).expect("structured payload expected");
        assert_eq!(mode, "structured_output");
        let text = value_to_output_text(
            payload,
            SuggestionFailureCategory::ProviderContract,
            "openai",
        )
        .expect("structured text expected");
        assert!(text.contains("\"boxes\":[]"));
        assert!(text.contains("\"width\":1"));
    }

    #[test]
    fn openai_message_text_preserves_structured_string_json_quoting() {
        let response = serde_json::json!({
            "output": [
                {
                    "type": "message",
                    "content": [
                        {
                            "type": "output_json",
                            "json": "No defects detected"
                        }
                    ]
                }
            ]
        });
        let (payload, mode) = openai_message_text(&response).expect("structured payload expected");
        assert_eq!(mode, "structured_output");
        let text = value_to_output_text(
            payload,
            SuggestionFailureCategory::ProviderContract,
            "openai",
        )
        .expect("structured text expected");
        assert_eq!(text, r#""No defects detected""#);
    }

    #[test]
    fn openai_message_text_rejects_refusals() {
        let response = serde_json::json!({
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{
                    "type": "refusal",
                    "refusal": "I can't help with that"
                }]
            }]
        });
        let err = openai_message_text(&response).expect_err("refusal should fail");
        assert_eq!(err.category, SuggestionFailureCategory::Refusal);
        assert!(err.message.contains("refused"));
    }

    #[test]
    fn openai_message_text_rejects_incomplete_states() {
        let response = serde_json::json!({
            "status": "incomplete",
            "incomplete_details": { "reason": "max_output_tokens" },
            "output": []
        });
        let err = openai_message_text(&response).expect_err("incomplete response should fail");
        assert_eq!(err.category, SuggestionFailureCategory::ProviderContract);
        assert!(err.message.contains("incomplete"));
    }

    #[test]
    fn openai_message_text_rejects_error_payloads() {
        let response = serde_json::json!({
            "status": "completed",
            "error": { "message": "boom" },
            "output": []
        });
        let err = openai_message_text(&response).expect_err("error payload should fail");
        assert_eq!(err.category, SuggestionFailureCategory::ProviderContract);
        assert!(err.message.contains("error payload"));
    }

    #[test]
    fn default_suggestion_timeout_is_extended_for_tool_enabled_requests() {
        assert_eq!(super::DEFAULT_SUGGESTION_TIMEOUT_MS, 180_000);
    }

    #[test]
    fn parser_accepts_object_box_schema() {
        let raw = r#"{"boxes":[{"x":5,"y":6,"w":7,"h":8,"confidence":0.7}],"image_size":{"width":20,"height":10}}"#;
        let parsed = parse_json_suggestions(raw, 20.0, 10.0).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].bbox, [5.0, 6.0, 7.0, 4.0]);
    }

    #[test]
    fn parser_rejects_object_schema_size_mismatch() {
        let raw =
            r#"{"boxes":[{"x":5,"y":6,"w":7,"h":8}],"image_size":{"width":1024,"height":1024}}"#;
        let err = parse_json_suggestions(raw, 2048.0, 1024.0).unwrap_err();
        assert!(err.contains("did not match actual image size"));
    }

    #[test]
    fn parser_clamps_object_box_to_remaining_bounds() {
        let raw = r#"{"boxes":[{"x":900,"y":500,"w":300,"h":700}],"image_size":{"width":1024,"height":768}}"#;
        let parsed = parse_json_suggestions(raw, 1024.0, 768.0).unwrap();
        assert_eq!(parsed[0].bbox, [900.0, 500.0, 124.0, 268.0]);
    }

    #[test]
    fn anthropic_message_text_prefers_json_block() {
        let response = serde_json::json!({
            "content": [
                {"type": "tool_use", "id": "tool_1"},
                {"type": "text", "text": "thinking..."},
                {"type": "text", "text": "{\"boxes\":[],\"image_size\":{\"width\":1,\"height\":1}}"}
            ]
        });
        let text = anthropic_message_text(&response).expect("text expected");
        assert!(text.contains("\"boxes\""));
    }

    #[test]
    fn anthropic_message_text_reports_non_json_chatter() {
        let response = serde_json::json!({
            "content": [
                {"type": "tool_use", "id": "tool_1"},
                {"type": "text", "text": "thinking..."},
                {"type": "text", "text": "maybe there is a defect near the seam"}
            ]
        });
        let err = anthropic_message_text(&response).expect_err("non-json text should fail");
        assert_eq!(err.category, SuggestionFailureCategory::ProviderContract);
        assert!(err.message.contains("did not contain JSON suggestion text"));
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
            "gpt-5.4",
            "Run Python to compute the sum of [2, 3, 5], then respond with just the integer result.",
            TEST_IMAGE_B64_PNG_1X1,
            "image/png",
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
        let dimensions = image::image_dimensions(&image_path).expect("image dimensions available");
        let media_type = match image::guess_format(&image_bytes).expect("image format detected") {
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::Gif => "image/gif",
            image::ImageFormat::WebP => "image/webp",
            other => panic!("unsupported smoke-test image format: {other:?}"),
        };
        use base64::Engine;
        let image_b64 = base64::engine::general_purpose::STANDARD.encode(image_bytes);

        let prompt = r#"Return strict JSON only in this exact shape:
{"boxes":[{"x":0,"y":0,"w":0,"h":0}],"image_size":{"width":0,"height":0}}
Find a single obvious object and provide exactly one bounding box. You may use the code_execution tool to validate that IoU((0,0,10,10),(0,0,5,5)) = 0.25."#;
        let context = ProviderExecutionContext {
            provider_id: "anthropic",
            model: "claude-sonnet-4-6",
            prompt,
            image_b64: &image_b64,
            image_media_type: media_type,
            timeout: Duration::from_secs(45),
            reasoning_preset: "low",
            width: dimensions.0 as f64,
            height: dimensions.1 as f64,
            tool_enabled: true,
        };
        let response =
            super::run_anthropic(&api_key, &context).expect("anthropic request should succeed");
        println!("parsed anthropic suggestions: {:?}", response.suggestions);
    }
}
