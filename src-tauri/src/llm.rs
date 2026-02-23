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
    pub states: HashMap<String, String>,
}

impl SuggestionQueue {
    pub fn new() -> Self {
        Self {
            states: HashMap::new(),
        }
    }

    pub fn state(&self, face_ids: &[String]) -> QueueStateResponse {
        let mut items = Vec::with_capacity(face_ids.len());
        for face_id in face_ids {
            items.push(QueueStateItem {
                face_id: face_id.clone(),
                status: self
                    .states
                    .get(face_id)
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
    Boxes(Vec<ParsedSuggestionItem>),
    NoDefects(String),
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
) -> Result<(String, [f64; 2]), String> {
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
    let dimensions = image::image_dimensions(&image_path).map_err(|source| {
        format!(
            "failed to determine image dimensions for `{}`: {source}",
            image_path.display()
        )
    })?;
    Ok((base64_image, [dimensions.0 as f64, dimensions.1 as f64]))
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

    let entries =
        match parsed {
            ParsedSuggestions::Boxes(entries) => entries,
            ParsedSuggestions::NoDefects(_) => return Err(
                "provider response string must be exactly `No defects detected` for negative cases"
                    .to_owned(),
            ),
        };

    let mut out = Vec::new();
    for entry in entries {
        let ParsedSuggestionItem {
            xmin,
            ymin,
            xmax,
            ymax,
            confidence,
        } = entry;
        if !(xmin.is_finite() && ymin.is_finite() && xmax.is_finite() && ymax.is_finite()) {
            continue;
        }
        let clamped_xmin = xmin.clamp(0.0, 1.0);
        let clamped_ymin = ymin.clamp(0.0, 1.0);
        let clamped_xmax = xmax.clamp(0.0, 1.0);
        let clamped_ymax = ymax.clamp(0.0, 1.0);
        if clamped_xmax <= clamped_xmin || clamped_ymax <= clamped_ymin {
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

    out.sort_by(|a, b| {
        b.confidence
            .unwrap_or(0.0)
            .total_cmp(&a.confidence.unwrap_or(0.0))
            .then_with(|| a.bbox[1].total_cmp(&b.bbox[1]))
            .then_with(|| a.bbox[0].total_cmp(&b.bbox[0]))
    });

    Ok(out)
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
    for part in content {
        if part.get("type").and_then(|v| v.as_str()) != Some("text") {
            continue;
        }
        if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
            return Some(text.to_owned());
        }
    }
    None
}

fn run_openai(
    api_key: &str,
    model: &str,
    prompt: &str,
    image_b64: &str,
    timeout: Duration,
    reasoning_preset: &str,
) -> Result<String, String> {
    let client = Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::json!({
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

    extract_openai_text(&value)
        .ok_or_else(|| "openai response did not contain message text".to_owned())
}

fn run_anthropic(
    api_key: &str,
    model: &str,
    prompt: &str,
    image_b64: &str,
    timeout: Duration,
    reasoning_preset: &str,
) -> Result<String, String> {
    let client = Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::json!({
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
                        "media_type": "image/png",
                        "data": image_b64
                    }
                }
            ]
        }]
    });
    let response = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
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
    let (image_b64, [width, height]) = build_face_context(dataset_root, face)?;
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
    use super::parse_json_suggestions;

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
}
