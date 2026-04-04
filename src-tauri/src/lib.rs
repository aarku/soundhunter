mod clap;
mod scanner;
mod search;
mod state;

use clap::ClapEngine;
use state::AppState;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).ok();

            let app_state = AppState::new(data_dir.clone()).expect("failed to initialize app state");
            app.manage(Mutex::new(app_state));
            // ClapEngine managed separately so embedding doesn't block everything
            app.manage(Mutex::new(None::<ClapEngine>));
            app.manage(data_dir);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_folder,
            commands::remove_folder,
            commands::get_folders,
            commands::scan_folders,
            commands::search,
            commands::get_stats,
            commands::reveal_in_explorer,
            commands::get_playlists,
            commands::create_playlist,
            commands::delete_playlist,
            commands::rename_playlist,
            commands::add_to_playlist,
            commands::remove_from_playlist,
            commands::get_playlist_items,
            commands::reorder_playlist,
            commands::reorder_playlists,
            commands::get_audio_metadata,
            commands::generate_waveform,
            commands::start_embedding,
            commands::refresh_embeddings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

mod commands {
    use super::state::AppState;
    use std::sync::Mutex;
    use tauri::{Emitter, Manager, State};

    #[tauri::command]
    pub fn add_folder(
        state: State<'_, Mutex<AppState>>,
        path: String,
    ) -> Result<Vec<String>, String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.add_folder(path).map_err(|e| e.to_string())?;
        Ok(s.get_folders())
    }

    #[tauri::command]
    pub fn remove_folder(
        state: State<'_, Mutex<AppState>>,
        path: String,
    ) -> Result<Vec<String>, String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.remove_folder(&path).map_err(|e| e.to_string())?;
        Ok(s.get_folders())
    }

    #[tauri::command]
    pub fn get_folders(state: State<'_, Mutex<AppState>>) -> Result<Vec<String>, String> {
        let s = state.lock().map_err(|e| e.to_string())?;
        Ok(s.get_folders())
    }

    #[tauri::command]
    pub fn scan_folders(state: State<'_, Mutex<AppState>>) -> Result<usize, String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.scan_and_index().map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn search(
        state: State<'_, Mutex<AppState>>,
        clap_state: State<'_, Mutex<Option<super::clap::ClapEngine>>>,
        query: String,
        limit: Option<usize>,
    ) -> Result<Vec<super::search::SearchResult>, String> {
        // Try to get CLAP text embedding (non-blocking: skip if clap lock is held)
        let query_embedding = match clap_state.try_lock() {
            Ok(mut clap_lock) => {
                if let Some(ref mut clap) = *clap_lock {
                    clap.embed_text(&query).ok()
                } else {
                    None
                }
            }
            Err(_) => None, // CLAP is busy embedding audio, skip semantic search
        };

        let s = state.lock().map_err(|e| e.to_string())?;
        s.search(&query, limit.unwrap_or(200), query_embedding.as_deref())
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn get_stats(state: State<'_, Mutex<AppState>>) -> Result<super::state::Stats, String> {
        let s = state.lock().map_err(|e| e.to_string())?;
        Ok(s.get_stats())
    }

    #[tauri::command]
    pub fn reveal_in_explorer(path: String) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
                .args(["/select,", &path])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .args(["-R", &path])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "linux")]
        {
            if let Some(parent) = std::path::Path::new(&path).parent() {
                opener::open(parent).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    #[tauri::command]
    pub fn get_playlists(
        state: State<'_, Mutex<AppState>>,
    ) -> Result<Vec<super::state::Playlist>, String> {
        let s = state.lock().map_err(|e| e.to_string())?;
        Ok(s.get_playlists())
    }

    #[tauri::command]
    pub fn create_playlist(
        state: State<'_, Mutex<AppState>>,
        name: String,
    ) -> Result<Vec<super::state::Playlist>, String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.create_playlist(name).map_err(|e| e.to_string())?;
        Ok(s.get_playlists())
    }

    #[tauri::command]
    pub fn delete_playlist(
        state: State<'_, Mutex<AppState>>,
        id: String,
    ) -> Result<Vec<super::state::Playlist>, String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.delete_playlist(&id).map_err(|e| e.to_string())?;
        Ok(s.get_playlists())
    }

    #[tauri::command]
    pub fn rename_playlist(
        state: State<'_, Mutex<AppState>>,
        id: String,
        name: String,
    ) -> Result<Vec<super::state::Playlist>, String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.rename_playlist(&id, name).map_err(|e| e.to_string())?;
        Ok(s.get_playlists())
    }

    #[tauri::command]
    pub fn add_to_playlist(
        state: State<'_, Mutex<AppState>>,
        playlist_id: String,
        file_path: String,
    ) -> Result<(), String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.add_to_playlist(&playlist_id, file_path)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn remove_from_playlist(
        state: State<'_, Mutex<AppState>>,
        playlist_id: String,
        file_path: String,
    ) -> Result<(), String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.remove_from_playlist(&playlist_id, &file_path)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn get_playlist_items(
        state: State<'_, Mutex<AppState>>,
        playlist_id: String,
    ) -> Result<Vec<String>, String> {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.get_playlist_items(&playlist_id)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn reorder_playlist(
        state: State<'_, Mutex<AppState>>,
        playlist_id: String,
        items: Vec<String>,
    ) -> Result<(), String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.reorder_playlist(&playlist_id, items)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn reorder_playlists(
        state: State<'_, Mutex<AppState>>,
        ids: Vec<String>,
    ) -> Result<Vec<super::state::Playlist>, String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.reorder_playlists(ids).map_err(|e| e.to_string())?;
        Ok(s.get_playlists())
    }

    #[tauri::command]
    pub fn get_audio_metadata(
        path: String,
    ) -> Result<super::scanner::AudioMetadata, String> {
        super::scanner::get_metadata(&path).map_err(|e| e.to_string())
    }

    /// Spawn a background thread to embed all unprocessed audio files.
    /// Emits "embedding-progress" events with { done, total } and
    /// "embedding-complete" when finished.
    #[tauri::command]
    pub fn start_embedding(
        app: tauri::AppHandle,
        state: State<'_, Mutex<AppState>>,
        clap_state: State<'_, Mutex<Option<super::clap::ClapEngine>>>,
        data_dir: State<'_, std::path::PathBuf>,
    ) -> Result<(), String> {
        // Collect all paths needing embedding (quick lock)
        let paths_to_embed: Vec<String> = {
            let s = state.lock().map_err(|e| e.to_string())?;
            let mut paths = Vec::new();
            for folder in &s.get_folders() {
                let files = super::scanner::scan_folder(folder);
                for f in files {
                    if s.next_unembedded_path_check(&f.path) {
                        paths.push(f.path);
                    }
                }
            }
            paths
        };

        if paths_to_embed.is_empty() {
            let _ = app.emit("embedding-complete", ());
            return Ok(());
        }

        // Ensure CLAP is initialized before spawning thread
        {
            let mut clap_lock = clap_state.lock().map_err(|e| e.to_string())?;
            if clap_lock.is_none() {
                eprintln!("Initializing CLAP engine...");
                *clap_lock = Some(
                    super::clap::ClapEngine::new(&data_dir)
                        .map_err(|e| e.to_string())?,
                );
                eprintln!("CLAP engine ready.");
            }
        }

        let total = paths_to_embed.len();
        let app_handle = app.clone();

        std::thread::spawn(move || {
            let state_ref = app_handle.state::<Mutex<AppState>>();
            let clap_ref = app_handle.state::<Mutex<Option<super::clap::ClapEngine>>>();

            let mut done = 0;
            for path in &paths_to_embed {
                let embedding = {
                    let mut clap_lock = clap_ref.lock().unwrap();
                    let clap = clap_lock.as_mut().unwrap();
                    match clap.embed_audio(path) {
                        Ok(emb) => emb,
                        Err(e) => {
                            eprintln!("Failed to embed {}: {}", path, e);
                            Vec::new()
                        }
                    }
                };

                {
                    let mut s = state_ref.lock().unwrap();
                    let _ = s.store_embedding(path.clone(), embedding);
                }

                done += 1;
                let _ = app_handle.emit("embedding-progress", serde_json::json!({
                    "done": done,
                    "total": total,
                }));

                if done % 20 == 0 {
                    let mut s = state_ref.lock().unwrap();
                    let _ = s.refresh_embeddings();
                }
            }

            {
                let mut s = state_ref.lock().unwrap();
                let _ = s.refresh_embeddings();
            }
            let _ = app_handle.emit("embedding-complete", serde_json::json!({ "total": done }));
            eprintln!("Embedding complete: {} files", done);
        });

        Ok(())
    }

    /// Refresh search engine with latest CLAP embeddings.
    #[tauri::command]
    pub fn refresh_embeddings(
        state: State<'_, Mutex<AppState>>,
    ) -> Result<(), String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.refresh_embeddings().map_err(|e| e.to_string())
    }

    /// Generate waveform peaks by seeking across a WAV file.
    /// Reads small chunks at evenly-spaced positions - works on huge files.
    /// Returns normalized peak values (0.0-1.0).
    #[tauri::command]
    pub fn generate_waveform(path: String, bar_count: usize) -> Result<Vec<f32>, String> {
        super::scanner::generate_waveform_peaks(&path, bar_count)
            .map_err(|e| e.to_string())
    }
}
