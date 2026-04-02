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
    pub duration_seconds: f32,
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
        let path_str = path.to_string_lossy().to_string();
        let duration_seconds = get_wav_duration(&path_str).unwrap_or(0.0);

        files.push(AudioFile {
            path: path_str,
            filename,
            folder: folder.to_string(),
            parent_folder,
            parent_folder_clean,
            tokens,
            extension: ext,
            size_bytes,
            duration_seconds,
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
/// Get duration of a WAV file from its header without reading the whole file.
fn get_wav_duration(path: &str) -> Result<f32, Box<dyn std::error::Error>> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)?;
    let mut header = [0u8; 44];
    file.read_exact(&mut header)?;

    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Ok(0.0);
    }

    let num_channels = u16::from_le_bytes([header[22], header[23]]) as u32;
    let sample_rate = u32::from_le_bytes([header[24], header[25], header[26], header[27]]);
    let bits_per_sample = u16::from_le_bytes([header[34], header[35]]) as u32;

    if sample_rate == 0 || num_channels == 0 || bits_per_sample == 0 {
        return Ok(0.0);
    }

    // Find "data" chunk to get actual data size
    file.seek(SeekFrom::Start(12))?;
    let mut chunk_header = [0u8; 8];
    loop {
        if file.read_exact(&mut chunk_header).is_err() {
            break;
        }
        let chunk_id = &chunk_header[0..4];
        let chunk_size = u32::from_le_bytes([
            chunk_header[4], chunk_header[5], chunk_header[6], chunk_header[7],
        ]);
        if chunk_id == b"data" {
            let bytes_per_frame = num_channels * bits_per_sample / 8;
            if bytes_per_frame > 0 {
                let total_frames = chunk_size / bytes_per_frame;
                return Ok(total_frames as f32 / sample_rate as f32);
            }
            break;
        }
        file.seek(SeekFrom::Current(chunk_size as i64))?;
    }

    Ok(0.0)
}

/// Generate waveform peaks by seeking across a WAV file.
/// Reads small sample windows at evenly-spaced positions across the file.
pub fn generate_waveform_peaks(
    path: &str,
    bar_count: usize,
) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)?;
    let file_size = file.metadata()?.len() as usize;

    if file_size < 44 {
        return Ok(vec![0.5; bar_count]);
    }

    // Read WAV header
    let mut header = [0u8; 44];
    file.read_exact(&mut header)?;

    // Parse basic WAV info
    let riff = &header[0..4];
    if riff != b"RIFF" {
        // Not a WAV - return flat waveform
        return Ok(vec![0.5; bar_count]);
    }

    let num_channels = u16::from_le_bytes([header[22], header[23]]) as usize;
    let bits_per_sample = u16::from_le_bytes([header[34], header[35]]) as usize;
    let bytes_per_sample = bits_per_sample / 8;
    let frame_size = bytes_per_sample * num_channels;

    // Find "data" chunk
    let mut data_start: usize = 12;
    let mut data_size: usize = 0;
    file.seek(SeekFrom::Start(12))?;

    let mut chunk_header = [0u8; 8];
    loop {
        if file.read_exact(&mut chunk_header).is_err() {
            break;
        }
        let chunk_id = &chunk_header[0..4];
        let chunk_size = u32::from_le_bytes([
            chunk_header[4],
            chunk_header[5],
            chunk_header[6],
            chunk_header[7],
        ]) as usize;

        if chunk_id == b"data" {
            data_start = file.stream_position()? as usize;
            data_size = chunk_size;
            break;
        }
        // Skip chunk
        file.seek(SeekFrom::Current(chunk_size as i64))?;
    }

    if data_size == 0 || frame_size == 0 {
        return Ok(vec![0.5; bar_count]);
    }

    let total_frames = data_size / frame_size;
    if total_frames < bar_count {
        return Ok(vec![0.5; bar_count]);
    }

    // Sample evenly across the file: read a small window at each bar position
    let samples_per_window = 512.min(total_frames / bar_count);
    let window_bytes = samples_per_window * frame_size;
    let mut buf = vec![0u8; window_bytes];
    let mut peaks = Vec::with_capacity(bar_count);

    for i in 0..bar_count {
        let frame_offset = (i as u64 * total_frames as u64) / bar_count as u64;
        let byte_offset = data_start as u64 + frame_offset * frame_size as u64;

        if file.seek(SeekFrom::Start(byte_offset)).is_err() {
            peaks.push(0.0);
            continue;
        }

        let read = match file.read(&mut buf) {
            Ok(n) => n,
            Err(_) => {
                peaks.push(0.0);
                continue;
            }
        };

        let frames_read = read / frame_size;
        if frames_read == 0 {
            peaks.push(0.0);
            continue;
        }

        let mut peak: f32 = 0.0;
        for f in 0..frames_read {
            let offset = f * frame_size;
            let sample = match bits_per_sample {
                16 => {
                    if offset + 1 < read {
                        i16::from_le_bytes([buf[offset], buf[offset + 1]]) as f32 / 32768.0
                    } else {
                        0.0
                    }
                }
                24 => {
                    if offset + 2 < read {
                        let val =
                            ((buf[offset + 2] as i32) << 24)
                            | ((buf[offset + 1] as i32) << 16)
                            | ((buf[offset] as i32) << 8);
                        (val as f32) / 2147483648.0
                    } else {
                        0.0
                    }
                }
                32 => {
                    if offset + 3 < read {
                        f32::from_le_bytes([buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]])
                    } else {
                        0.0
                    }
                }
                _ => {
                    // 8-bit unsigned
                    if offset < read {
                        (buf[offset] as f32 - 128.0) / 128.0
                    } else {
                        0.0
                    }
                }
            };

            let abs = sample.abs();
            if abs > peak {
                peak = abs;
            }
        }

        peaks.push(peak);
    }

    // Normalize
    let max = peaks.iter().cloned().fold(0.001f32, f32::max);
    Ok(peaks.iter().map(|p| p / max).collect())
}

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
