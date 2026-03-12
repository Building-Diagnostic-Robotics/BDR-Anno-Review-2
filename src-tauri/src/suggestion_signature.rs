use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionSignatureInput {
    pub provider_id: String,
    pub model_id: String,
    pub prompt_template_version: String,
    pub preprocessing_version: String,
    pub generation_params: Value,
}

fn canonicalize_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                if let Some(entry) = map.get(key) {
                    out.insert(key.clone(), canonicalize_value(entry));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_value).collect()),
        _ => value.clone(),
    }
}

pub fn compute_suggestion_signature(input: &SuggestionSignatureInput) -> Result<String, String> {
    let canonical_input = SuggestionSignatureInput {
        provider_id: input.provider_id.clone(),
        model_id: input.model_id.clone(),
        prompt_template_version: input.prompt_template_version.clone(),
        preprocessing_version: input.preprocessing_version.clone(),
        generation_params: canonicalize_value(&input.generation_params),
    };
    let canonical_json = serde_json::to_string(&canonical_input)
        .map_err(|source| format!("failed to serialize suggestion signature input: {source}"))?;

    let mut hasher = Sha256::new();
    hasher.update(canonical_json.as_bytes());
    let digest = hasher.finalize();
    Ok(format!("{:x}", digest))
}

#[cfg(test)]
mod tests {
    use super::{compute_suggestion_signature, SuggestionSignatureInput};

    #[test]
    fn signature_is_stable_for_key_order_variants() {
        let left = SuggestionSignatureInput {
            provider_id: "openai".to_owned(),
            model_id: "gpt-5.4".to_owned(),
            prompt_template_version: "suggest_boxes_v1".to_owned(),
            preprocessing_version: "faces_v1".to_owned(),
            generation_params: serde_json::json!({
                "temperature": 0,
                "nested": {
                    "b": 2,
                    "a": 1
                }
            }),
        };
        let right = SuggestionSignatureInput {
            provider_id: "openai".to_owned(),
            model_id: "gpt-5.4".to_owned(),
            prompt_template_version: "suggest_boxes_v1".to_owned(),
            preprocessing_version: "faces_v1".to_owned(),
            generation_params: serde_json::json!({
                "nested": {
                    "a": 1,
                    "b": 2
                },
                "temperature": 0
            }),
        };

        let left_hash = compute_suggestion_signature(&left).expect("left signature");
        let right_hash = compute_suggestion_signature(&right).expect("right signature");
        assert_eq!(left_hash, right_hash);
    }
}
