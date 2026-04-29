use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Per-copy cancellation flags, keyed by copy_id. The copy worker checks the
/// flag between files so a cancel request exits cleanly on the next file
/// boundary.
pub type CancelFlags = Mutex<HashMap<String, Arc<AtomicBool>>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightResult {
    #[serde(rename = "requiredBytes")]
    pub required_bytes: u64,
    #[serde(rename = "availableBytes")]
    pub available_bytes: u64,
    #[serde(rename = "sourcePaths")]
    pub source_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartResult {
    #[serde(rename = "copyId")]
    pub copy_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenamedEntry {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorEntry {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CopyResult {
    pub copied: u64,
    pub canceled: bool,
    pub skipped: Vec<String>,
    pub renamed: Vec<RenamedEntry>,
    pub missing: Vec<String>,
    pub errors: Vec<ErrorEntry>,
}

/// Optional renumber-on-copy: replace each source filename with
/// `{base_name}{sep}{NNNN}.{ext}` where NNNN is `start + index` zero-padded
/// to `pad` digits. `pad = 0` means no padding (just the integer).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameOptions {
    #[serde(rename = "baseName")]
    pub base_name: String,
    pub pad: u8,
    pub start: u32,
}

pub fn new_copy_id() -> String {
    format!(
        "cp_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

/// Returns (required_bytes, available_bytes_at_dest). missing source files
/// contribute 0 bytes to required_bytes.
pub fn preflight(sources: &[String], dest: &Path) -> PreflightResult {
    let mut required_bytes: u64 = 0;
    for s in sources {
        if let Ok(meta) = std::fs::metadata(s) {
            required_bytes = required_bytes.saturating_add(meta.len());
        }
    }
    let available_bytes = available_at(dest);
    PreflightResult {
        required_bytes,
        available_bytes,
        source_paths: sources.to_vec(),
    }
}

/// Find the available space at the filesystem containing `dest`. Uses sysinfo
/// and picks the mount point with the longest prefix match of the destination.
fn available_at(dest: &Path) -> u64 {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let dest_norm = normalize_path(dest);
    let mut best: Option<(usize, u64)> = None;
    for d in disks.list() {
        let mount = normalize_path(d.mount_point());
        if dest_norm.starts_with(&mount) {
            let len = mount.as_os_str().len();
            if best.map(|(l, _)| len > l).unwrap_or(true) {
                best = Some((len, d.available_space()));
            }
        }
    }
    best.map(|(_, b)| b).unwrap_or(0)
}

fn normalize_path(p: &Path) -> PathBuf {
    // On Windows mount points come back as "C:\" while user paths may be
    // "C:\Users\...". Canonicalize-lite via lowercasing drive letter only; a
    // full canonicalize could fail for non-existent paths.
    PathBuf::from(p.to_string_lossy().to_lowercase())
}

/// Runs the copy to completion (or cancellation). Returns the result.
pub fn run_copy(
    sources: Vec<String>,
    dest: &Path,
    rename: Option<RenameOptions>,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(u64, u64, &str),
) -> CopyResult {
    let mut result = CopyResult::default();
    let total = sources.len() as u64;

    // Track filenames we've produced in this run so two sources with the same
    // filename get " (2)", " (3)", etc.
    let mut produced_this_run: HashSet<String> = HashSet::new();

    for (i, src) in sources.iter().enumerate() {
        if cancel.load(Ordering::Acquire) {
            result.canceled = true;
            break;
        }

        let src_path = Path::new(src);
        let src_meta = match std::fs::metadata(src_path) {
            Ok(m) => m,
            Err(_) => {
                result.missing.push(src.clone());
                on_progress(i as u64 + 1, total, "");
                continue;
            }
        };
        let src_size = src_meta.len();

        let original_filename = match src_path.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => {
                result.errors.push(ErrorEntry {
                    path: src.clone(),
                    message: "could not determine filename".into(),
                });
                on_progress(i as u64 + 1, total, "");
                continue;
            }
        };

        // If renaming is active, build the renumbered filename (preserving the
        // source extension); otherwise keep the original. Either way,
        // pick_dest_name then handles run-level + on-disk collisions.
        let proposed = match &rename {
            Some(opts) => renumbered_name(opts, i, &original_filename),
            None => original_filename.clone(),
        };

        let (final_name, status) = pick_dest_name(dest, &proposed, src_size, &produced_this_run);
        produced_this_run.insert(final_name.clone());

        match status {
            NameStatus::Skip => {
                result.skipped.push(original_filename.clone());
                on_progress(i as u64 + 1, total, &original_filename);
                continue;
            }
            NameStatus::Renamed => {
                result.renamed.push(RenamedEntry {
                    from: original_filename.clone(),
                    to: final_name.clone(),
                });
            }
            NameStatus::AsIs => {
                if final_name != original_filename {
                    // Renumber rewrote the name without a collision conflict.
                    result.renamed.push(RenamedEntry {
                        from: original_filename.clone(),
                        to: final_name.clone(),
                    });
                }
            }
        }

        let dest_path = dest.join(&final_name);
        on_progress(i as u64, total, &final_name);

        if let Err(e) = std::fs::copy(src_path, &dest_path) {
            result.errors.push(ErrorEntry {
                path: src.clone(),
                message: e.to_string(),
            });
            on_progress(i as u64 + 1, total, &final_name);
            continue;
        }

        result.copied += 1;
        on_progress(i as u64 + 1, total, &final_name);
    }

    result
}

enum NameStatus {
    AsIs,
    Renamed,
    Skip,
}

fn pick_dest_name(
    dest: &Path,
    filename: &str,
    src_size: u64,
    produced_this_run: &HashSet<String>,
) -> (String, NameStatus) {
    let on_disk = dest.join(filename);
    let disk_conflict = std::fs::metadata(&on_disk).ok();
    let run_conflict = produced_this_run.contains(filename);

    if !run_conflict {
        match disk_conflict {
            None => return (filename.to_string(), NameStatus::AsIs),
            Some(m) if m.len() == src_size => return (filename.to_string(), NameStatus::Skip),
            Some(_) => { /* fall through to rename */ }
        }
    }

    // Need a new name with " (N)" suffix.
    let (stem, ext) = split_name(filename);
    let mut n: u32 = 2;
    loop {
        let candidate = if ext.is_empty() {
            format!("{stem} ({n})")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        let on_disk = dest.join(&candidate);
        if !produced_this_run.contains(&candidate) && !on_disk.exists() {
            return (candidate, NameStatus::Renamed);
        }
        n += 1;
        if n > 10_000 {
            // Pathological case — just return the candidate and let the copy
            // attempt fail with an I/O error if it collides.
            return (candidate, NameStatus::Renamed);
        }
    }
}

fn split_name(filename: &str) -> (&str, &str) {
    match filename.rfind('.') {
        Some(i) if i > 0 => (&filename[..i], &filename[i + 1..]),
        _ => (filename, ""),
    }
}

fn renumbered_name(opts: &RenameOptions, index: usize, original: &str) -> String {
    let (_, ext) = split_name(original);
    let n = opts.start.saturating_add(index as u32);
    let pad = opts.pad as usize;
    let number = if pad == 0 {
        n.to_string()
    } else {
        format!("{:0>width$}", n, width = pad)
    };
    let base = opts.base_name.trim();
    let stem = if base.is_empty() {
        number
    } else {
        format!("{base} {number}")
    };
    if ext.is_empty() {
        stem
    } else {
        format!("{stem}.{ext}")
    }
}
