use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Suggestion {
    pub bbox: [f32; 4],
    pub confidence: Option<f32>,
    pub source: String,
}

pub trait SuggestionProvider {
    fn suggest(&self, _image_bytes: &[u8]) -> Vec<Suggestion> {
        Vec::new()
    }
}
