use std::fs;
use std::path::PathBuf;

use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "llm-settings.json";
const KEYRING_SERVICE: &str = "bdr-anno-review";
const OPENAI_USER: &str = "openai_api_key";
const ANTHROPIC_USER: &str = "anthropic_api_key";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProviderSettings {
    pub enabled: bool,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettings {
    pub llm_suggestions_enabled: bool,
    pub reasoning_preset: String,
    pub prefetch_buffer_size: usize,
    pub openai: LlmProviderSettings,
    pub anthropic: LlmProviderSettings,
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            llm_suggestions_enabled: true,
            reasoning_preset: "high".to_owned(),
            prefetch_buffer_size: 12,
            openai: LlmProviderSettings {
                enabled: true,
                model: "gpt-5.2".to_owned(),
            },
            anthropic: LlmProviderSettings {
                enabled: false,
                model: "claude-sonnet-4-6".to_owned(),
            },
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLlmSettingsRequest {
    pub llm_suggestions_enabled: bool,
    pub reasoning_preset: String,
    pub prefetch_buffer_size: usize,
    pub openai: LlmProviderSettings,
    pub anthropic: LlmProviderSettings,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeyRequest {
    pub provider: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProviderKeyRequest {
    pub provider: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProviderSettingsResponse {
    pub enabled: bool,
    pub model: String,
    pub has_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettingsResponse {
    pub llm_suggestions_enabled: bool,
    pub reasoning_preset: String,
    pub prefetch_buffer_size: usize,
    pub openai: LlmProviderSettingsResponse,
    pub anthropic: LlmProviderSettingsResponse,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|source| format!("failed to resolve app config dir: {source}"))?;
    fs::create_dir_all(&dir).map_err(|source| {
        format!(
            "failed to create app config dir `{}`: {source}",
            dir.display()
        )
    })?;
    Ok(dir.join(SETTINGS_FILE))
}

pub fn load_settings(app: &AppHandle) -> Result<LlmSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(LlmSettings::default());
    }
    let raw = fs::read_to_string(&path).map_err(|source| {
        format!(
            "failed to read settings file `{}`: {source}",
            path.display()
        )
    })?;
    serde_json::from_str(&raw).map_err(|source| {
        format!(
            "failed to parse settings file `{}`: {source}",
            path.display()
        )
    })
}

pub fn save_settings(app: &AppHandle, settings: &LlmSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|source| format!("failed to serialize settings: {source}"))?;
    fs::write(&path, raw).map_err(|source| {
        format!(
            "failed to write settings file `{}`: {source}",
            path.display()
        )
    })
}

fn load_key(username: &str, provider: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(KEYRING_SERVICE, username)
        .map_err(|source| format!("failed to create secure key entry for {provider}: {source}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(source) => {
            if is_missing_key_error(&source) {
                Ok(None)
            } else {
                Err(format!(
                    "failed to read secure key for {provider}; check keychain availability/unlock state: {source}"
                ))
            }
        }
    }
}

fn is_missing_key_error(error: &keyring::Error) -> bool {
    if matches!(error, keyring::Error::NoEntry) {
        return true;
    }

    let text = error.to_string();
    let normalized = text.to_lowercase();
    normalized.contains("no entry")
        || normalized.contains("credential not found")
        || normalized.contains("no matching entry found")
        || normalized.contains("no such item in keychain")
        || normalized.contains("cannot find the credential")
}

fn set_key(username: &str, value: &str) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, username).map_err(|source| source.to_string())?;
    entry
        .set_password(value)
        .map_err(|source| format!("failed to persist secure key: {source}"))
}

fn clear_key(username: &str) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, username).map_err(|source| source.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(source) => {
            let text = source.to_string();
            if text.to_lowercase().contains("no entry") {
                Ok(())
            } else {
                Err(format!("failed to clear secure key: {source}"))
            }
        }
    }
}

pub fn openai_key() -> Result<Option<String>, String> {
    load_key(OPENAI_USER, "OpenAI")
}

pub fn anthropic_key() -> Result<Option<String>, String> {
    load_key(ANTHROPIC_USER, "Anthropic")
}

pub fn get_settings_response(app: &AppHandle) -> Result<LlmSettingsResponse, String> {
    let settings = load_settings(app)?;
    let openai_has_key = openai_key()?.is_some();
    let anthropic_has_key = anthropic_key()?.is_some();

    Ok(LlmSettingsResponse {
        llm_suggestions_enabled: settings.llm_suggestions_enabled,
        reasoning_preset: settings.reasoning_preset,
        prefetch_buffer_size: settings.prefetch_buffer_size,
        openai: LlmProviderSettingsResponse {
            enabled: settings.openai.enabled,
            model: settings.openai.model,
            has_key: openai_has_key,
        },
        anthropic: LlmProviderSettingsResponse {
            enabled: settings.anthropic.enabled,
            model: settings.anthropic.model,
            has_key: anthropic_has_key,
        },
    })
}

fn validate_provider_selection(
    llm_suggestions_enabled: bool,
    openai_enabled: bool,
    anthropic_enabled: bool,
) -> Result<(), String> {
    if !llm_suggestions_enabled {
        return Ok(());
    }

    let provider_count = usize::from(openai_enabled) + usize::from(anthropic_enabled);
    if provider_count == 0 {
        return Err(
            "LLM suggestions are enabled but no provider is enabled. Enable OpenAI or Anthropic, or disable suggestions."
                .to_owned(),
        );
    }
    if provider_count > 1 {
        return Err(
            "LLM suggestions require exactly one enabled provider. Disable one provider before saving."
                .to_owned(),
        );
    }

    Ok(())
}

fn validate_llm_settings_request(request: &SaveLlmSettingsRequest) -> Result<(), String> {
    if request.reasoning_preset != "high"
        && request.reasoning_preset != "balanced"
        && request.reasoning_preset != "low"
    {
        return Err("reasoningPreset must be one of high, balanced, low".to_owned());
    }

    if request.openai.model.trim().is_empty() {
        return Err("OpenAI model is required".to_owned());
    }
    if request.anthropic.model.trim().is_empty() {
        return Err("Anthropic model is required".to_owned());
    }

    validate_provider_selection(
        request.llm_suggestions_enabled,
        request.openai.enabled,
        request.anthropic.enabled,
    )
}

pub fn save_settings_request(
    app: &AppHandle,
    request: SaveLlmSettingsRequest,
) -> Result<LlmSettingsResponse, String> {
    validate_llm_settings_request(&request)?;

    let settings = LlmSettings {
        llm_suggestions_enabled: request.llm_suggestions_enabled,
        reasoning_preset: request.reasoning_preset,
        prefetch_buffer_size: request.prefetch_buffer_size.clamp(1, 32),
        openai: request.openai,
        anthropic: request.anthropic,
    };
    save_settings(app, &settings)?;

    get_settings_response(app)
}

pub fn clear_provider_key(request: ProviderKeyRequest) -> Result<(), String> {
    match request.provider.as_str() {
        "openai" => clear_key(OPENAI_USER),
        "anthropic" => clear_key(ANTHROPIC_USER),
        _ => Err("provider must be `openai` or `anthropic`".to_owned()),
    }
}

pub fn set_provider_key(request: SetProviderKeyRequest) -> Result<(), String> {
    let api_key = request.api_key.trim();
    if api_key.is_empty() {
        return Err("apiKey is required".to_owned());
    }

    match request.provider.as_str() {
        "openai" => set_key(OPENAI_USER, api_key),
        "anthropic" => set_key(ANTHROPIC_USER, api_key),
        _ => Err("provider must be `openai` or `anthropic`".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_missing_key_error, validate_provider_selection};
    use keyring::Error;

    #[test]
    fn provider_selection_rejects_none_enabled_with_suggestions() {
        let error = validate_provider_selection(true, false, false)
            .expect_err("expected provider validation to fail");
        assert!(error.contains("no provider is enabled"));
    }

    #[test]
    fn provider_selection_rejects_multiple_enabled_with_suggestions() {
        let error = validate_provider_selection(true, true, true)
            .expect_err("expected provider validation to fail");
        assert!(error.contains("exactly one enabled provider"));
    }

    #[test]
    fn provider_selection_allows_none_enabled_when_suggestions_disabled() {
        let result = validate_provider_selection(false, false, false);
        assert!(result.is_ok());
    }

    #[test]
    fn missing_key_classifier_handles_secure_storage_variants() {
        assert!(is_missing_key_error(&Error::NoEntry));
        assert!(is_missing_key_error(&Error::PlatformFailure(
            "No entry found".into()
        )));
        assert!(is_missing_key_error(&Error::PlatformFailure(
            "credential not found".into()
        )));
        assert!(is_missing_key_error(&Error::PlatformFailure(
            "No matching entry found in secure storage".into()
        )));
        assert!(is_missing_key_error(&Error::PlatformFailure(
            "No such item in keychain".into()
        )));
        assert!(is_missing_key_error(&Error::PlatformFailure(
            "Cannot find the credential".into()
        )));
        assert!(!is_missing_key_error(&Error::PlatformFailure(
            "keychain is locked".into()
        )));
        assert!(!is_missing_key_error(&Error::PlatformFailure(
            "permission denied".into()
        )));
        assert!(!is_missing_key_error(&Error::PlatformFailure(
            "secret service not found".into()
        )));
        assert!(!is_missing_key_error(&Error::PlatformFailure(
            "No such object path '/org/freedesktop/secrets/collection/login'".into()
        )));
    }
}
