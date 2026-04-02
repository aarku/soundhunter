use serde::{Deserialize, Serialize};
use std::path::Path;
use walkdir::WalkDir;

const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "mp3", "ogg", "flac", "aif", "aiff", "m4a", "wma", "aac",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioFile {
    pub path: String,
    pub filename: String,
    pub folder: String,
    pub parent_folder: String,
    /// The parent folder name with publisher prefix stripped (e.g. "3maze - Interference" -> "Interference")
    pub parent_folder_clean: String,
    /// Tokenized/cleaned name for indexing
    pub tokens: Vec<String>,
    pub extension: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioMetadata {
    pub path: String,
    pub filename: String,
    pub size_bytes: u64,
    pub extension: String,
    pub parent_folder: String,
}

pub fn get_metadata(path: &str) -> Result<AudioMetadata, Box<dyn std::error::Error>> {
    let p = Path::new(path);
    let meta = std::fs::metadata(p)?;
    Ok(AudioMetadata {
        path: path.to_string(),
        filename: p.file_name().unwrap_or_default().to_string_lossy().to_string(),
        size_bytes: meta.len(),
        extension: p.extension().unwrap_or_default().to_string_lossy().to_string(),
        parent_folder: p.parent()
            .and_then(|p| p.file_name())
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
    })
}

pub fn scan_folder(folder: &str) -> Vec<AudioFile> {
    let mut files = Vec::new();
    let folder_path = Path::new(folder);

    for entry in WalkDir::new(folder_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        if !AUDIO_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }

        let filename = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let parent_folder = path
            .parent()
            .and_then(|p| p.file_name())
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let parent_folder_clean = strip_publisher_prefix(&parent_folder);
        let tokens = tokenize_filename(&filename);

        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);

        files.push(AudioFile {
            path: path.to_string_lossy().to_string(),
            filename,
            folder: folder.to_string(),
            parent_folder,
            parent_folder_clean,
            tokens,
            extension: ext,
            size_bytes,
        });
    }

    files
}

/// Tokenize a filename into searchable words.
/// Handles: underscores, hyphens, commas, camelCase, numbering, prefixes, etc.
fn tokenize_filename(name: &str) -> Vec<String> {
    let mut tokens = Vec::new();

    // Replace common delimiters with spaces
    let cleaned = name
        .replace('_', " ")
        .replace('-', " ")
        .replace(',', " ")
        .replace('.', " ")
        .replace('(', " ")
        .replace(')', " ")
        .replace('[', " ")
        .replace(']', " ");

    // Split on whitespace
    for word in cleaned.split_whitespace() {
        // Split camelCase
        let camel_split = split_camel_case(word);
        for part in camel_split {
            let lower = part.to_lowercase();
            if !lower.is_empty() && lower.len() > 1 {
                tokens.push(lower);
            }
        }
    }

    tokens
}

/// Strip publisher/maker prefix from folder names.
/// "3maze - Interference" -> "Interference"
/// "Sonniss.com - GDC 2019 - Game Audio Bundle" -> "GDC 2019 - Game Audio Bundle"
/// If there's no " - " separator, returns the original string unchanged.
fn strip_publisher_prefix(folder: &str) -> String {
    if let Some(idx) = folder.find(" - ") {
        folder[idx + 3..].to_string()
    } else {
        folder.to_string()
    }
}

fn split_camel_case(s: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();

    for ch in s.chars() {
        if ch.is_uppercase() && !current.is_empty() {
            parts.push(current.clone());
            current.clear();
        }
        current.push(ch);
    }
    if !current.is_empty() {
        parts.push(current);
    }

    parts
}
