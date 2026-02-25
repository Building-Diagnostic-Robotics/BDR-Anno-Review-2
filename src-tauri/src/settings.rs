use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "llm-settings.json";
const KEYRING_SERVICE: &str = "bdr-anno-review";
const OPENAI_USER: &str = "openai_api_key";
const ANTHROPIC_USER: &str = "anthropic_api_key";
const VERIFY_READBACK_ATTEMPTS: usize = 4;
const VERIFY_READBACK_DELAY_MS: u64 = 50;

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
    pub openai_api_key: Option<String>,
    pub anthropic_api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearProviderKeyRequest {
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProviderSettingsResponse {
    pub enabled: bool,
    pub model: String,
    pub api_key_configured: bool,
    pub masked_key_preview: Option<String>,
    pub api_key_status_error: Option<String>,
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

fn mask_key(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() <= 8 {
        return Some("••••••••".to_owned());
    }
    Some(format!(
        "{}...{}",
        &trimmed[0..4],
        &trimmed[trimmed.len() - 4..]
    ))
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

fn verify_saved_key_readback<F>(
    provider: &str,
    expected: &str,
    attempts: usize,
    mut read: F,
) -> Result<(), String>
where
    F: FnMut() -> Result<String, keyring::Error>,
{
    let max_attempts = attempts.max(1);
    let mut saw_no_entry = false;

    for attempt in 1..=max_attempts {
        match read() {
            Ok(readback) if readback == expected => return Ok(()),
            Ok(_) => {
                return Err(format!(
                    "{provider} key save verification failed: readback value does not match written key"
                ))
            }
            Err(error) if is_missing_key_error(&error) => {
                saw_no_entry = true;
                if attempt < max_attempts {
                    thread::sleep(Duration::from_millis(VERIFY_READBACK_DELAY_MS));
                    continue;
                }
            }
            Err(error) => {
                return Err(format!(
                    "{provider} key save verification failed during keychain readback: {error}"
                ))
            }
        }
    }

    if saw_no_entry {
        return Err(format!(
            "{provider} key save verification failed: key missing after immediate keychain readback retries"
        ));
    }

    Err(format!(
        "{provider} key save verification failed: exhausted readback retries"
    ))
}

fn verify_saved_key_with_retry(
    entry: &Entry,
    provider: &str,
    expected: &str,
) -> Result<(), String> {
    verify_saved_key_readback(provider, expected, VERIFY_READBACK_ATTEMPTS, || {
        entry.get_password()
    })
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
    let (openai_key, openai_key_status_error) = match openai_key() {
        Ok(value) => (value, None),
        Err(error) => (None, Some(error)),
    };
    let (anthropic_key, anthropic_key_status_error) = match anthropic_key() {
        Ok(value) => (value, None),
        Err(error) => (None, Some(error)),
    };

    Ok(LlmSettingsResponse {
        llm_suggestions_enabled: settings.llm_suggestions_enabled,
        reasoning_preset: settings.reasoning_preset,
        prefetch_buffer_size: settings.prefetch_buffer_size,
        openai: LlmProviderSettingsResponse {
            enabled: settings.openai.enabled,
            model: settings.openai.model,
            api_key_configured: openai_key.is_some(),
            masked_key_preview: openai_key.and_then(|key| mask_key(&key)),
            api_key_status_error: openai_key_status_error,
        },
        anthropic: LlmProviderSettingsResponse {
            enabled: settings.anthropic.enabled,
            model: settings.anthropic.model,
            api_key_configured: anthropic_key.is_some(),
            masked_key_preview: anthropic_key.and_then(|key| mask_key(&key)),
            api_key_status_error: anthropic_key_status_error,
        },
    })
}

fn validate_provider_selection(request: &SaveLlmSettingsRequest) -> Result<(), String> {
    if !request.llm_suggestions_enabled {
        return Ok(());
    }

    let provider_count =
        usize::from(request.openai.enabled) + usize::from(request.anthropic.enabled);
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

pub fn save_settings_request(
    app: &AppHandle,
    request: SaveLlmSettingsRequest,
) -> Result<LlmSettingsResponse, String> {
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

    validate_provider_selection(&request)?;

    if let Some(key) = request.openai_api_key.as_deref() {
        if !key.trim().is_empty() {
            let trimmed_key = key.trim();
            set_key(OPENAI_USER, trimmed_key)?;
            let entry = Entry::new(KEYRING_SERVICE, OPENAI_USER).map_err(|source| {
                format!("failed to create secure key entry for OpenAI: {source}")
            })?;
            verify_saved_key_with_retry(&entry, "OpenAI", trimmed_key)?;
        }
    }
    if let Some(key) = request.anthropic_api_key.as_deref() {
        if !key.trim().is_empty() {
            let trimmed_key = key.trim();
            set_key(ANTHROPIC_USER, trimmed_key)?;
            let entry = Entry::new(KEYRING_SERVICE, ANTHROPIC_USER).map_err(|source| {
                format!("failed to create secure key entry for Anthropic: {source}")
            })?;
            verify_saved_key_with_retry(&entry, "Anthropic", trimmed_key)?;
        }
    }

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

pub fn clear_provider_key(request: ClearProviderKeyRequest) -> Result<(), String> {
    match request.provider.as_str() {
        "openai" => clear_key(OPENAI_USER),
        "anthropic" => clear_key(ANTHROPIC_USER),
        _ => Err("provider must be `openai` or `anthropic`".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_missing_key_error, validate_provider_selection, verify_saved_key_readback,
        LlmProviderSettings, SaveLlmSettingsRequest,
    };
    use keyring::Error;

    fn run_readback_sequence(
        provider: &str,
        expected: &str,
        reads: Vec<Result<String, Error>>,
    ) -> Result<(), String> {
        let mut reads = reads.into_iter();
        verify_saved_key_readback(provider, expected, 4, || {
            reads
                .next()
                .unwrap_or_else(|| Err(Error::PlatformFailure("read sequence exhausted".into())))
        })
    }

    fn base_request() -> SaveLlmSettingsRequest {
        SaveLlmSettingsRequest {
            llm_suggestions_enabled: true,
            reasoning_preset: "balanced".to_owned(),
            prefetch_buffer_size: 8,
            openai: LlmProviderSettings {
                enabled: true,
                model: "gpt-5.2".to_owned(),
            },
            anthropic: LlmProviderSettings {
                enabled: false,
                model: "claude-sonnet-4-6".to_owned(),
            },
            openai_api_key: None,
            anthropic_api_key: None,
        }
    }

    #[test]
    fn provider_selection_rejects_none_enabled_with_suggestions() {
        let mut request = base_request();
        request.openai.enabled = false;
        request.anthropic.enabled = false;

        let error = validate_provider_selection(&request)
            .expect_err("expected provider validation to fail");
        assert!(error.contains("no provider is enabled"));
    }

    #[test]
    fn provider_selection_rejects_multiple_enabled_with_suggestions() {
        let mut request = base_request();
        request.openai.enabled = true;
        request.anthropic.enabled = true;

        let error = validate_provider_selection(&request)
            .expect_err("expected provider validation to fail");
        assert!(error.contains("exactly one enabled provider"));
    }

    #[test]
    fn provider_selection_allows_none_enabled_when_suggestions_disabled() {
        let mut request = base_request();
        request.llm_suggestions_enabled = false;
        request.openai.enabled = false;
        request.anthropic.enabled = false;

        let result = validate_provider_selection(&request);
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

    #[test]
    fn readback_verification_succeeds_on_immediate_match() {
        let result = run_readback_sequence("OpenAI", "sk-test", vec![Ok("sk-test".to_owned())]);
        assert!(result.is_ok());
    }

    #[test]
    fn readback_verification_fails_on_mismatch() {
        let result = run_readback_sequence("OpenAI", "sk-test", vec![Ok("sk-other".to_owned())])
            .expect_err("expected mismatch failure");
        assert!(result.contains("readback value does not match written key"));
    }

    #[test]
    fn readback_verification_retries_no_entry_then_succeeds() {
        let result = run_readback_sequence(
            "OpenAI",
            "sk-test",
            vec![
                Err(Error::NoEntry),
                Err(Error::NoEntry),
                Ok("sk-test".to_owned()),
            ],
        );
        assert!(result.is_ok());
    }

    #[test]
    fn readback_verification_retries_platform_missing_key_then_succeeds() {
        let result = run_readback_sequence(
            "OpenAI",
            "sk-test",
            vec![
                Err(Error::PlatformFailure("No entry found".into())),
                Ok("sk-test".to_owned()),
            ],
        );
        assert!(result.is_ok());
    }

    #[test]
    fn readback_verification_fails_after_exhausted_no_entry_retries() {
        let result = run_readback_sequence(
            "OpenAI",
            "sk-test",
            vec![
                Err(Error::NoEntry),
                Err(Error::NoEntry),
                Err(Error::NoEntry),
                Err(Error::NoEntry),
            ],
        )
        .expect_err("expected exhausted no-entry failure");
        assert!(result.contains("key missing after immediate keychain readback retries"));
    }

    #[test]
    fn readback_verification_propagates_non_no_entry_backend_errors() {
        let result = run_readback_sequence(
            "OpenAI",
            "sk-test",
            vec![Err(Error::PlatformFailure("keychain is locked".into()))],
        )
        .expect_err("expected backend readback failure");
        assert!(result.contains("during keychain readback"));
        assert!(result.contains("keychain is locked"));
    }
}
