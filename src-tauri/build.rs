use std::fs;
use std::path::PathBuf;

use base64::Engine;

const ICON_PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

fn ensure_icon_png() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR");
    let icons_dir = PathBuf::from(manifest_dir).join("icons");
    let icon_path = icons_dir.join("icon.png");

    if let Err(error) = fs::create_dir_all(&icons_dir) {
        panic!(
            "failed to create icons directory `{}`: {error}",
            icons_dir.display()
        );
    }

    let icon_bytes = base64::engine::general_purpose::STANDARD
        .decode(ICON_PNG_BASE64)
        .expect("invalid ICON_PNG_BASE64 payload");
    if let Err(error) = fs::write(&icon_path, icon_bytes) {
        panic!("failed to write icon `{}`: {error}", icon_path.display());
    }
}

fn main() {
    ensure_icon_png();
    tauri_build::build();
}
