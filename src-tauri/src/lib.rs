mod clap;
mod copy;
mod scanner;
mod search;
mod state;

use clap::ClapPool;
use state::AppState;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::Manager;

/// Guard ensuring only one embedding background thread runs at a time.
/// Wrapped in a named struct so it can be retrieved from Tauri state.
pub struct EmbeddingRunning(pub AtomicBool);

/// Lazily-initialized pool of CLAP workers. Wrapped in `Mutex<Option<...>>` so
/// the first `start_embedding` call can build it (which may take seconds on
/// first run because it downloads models and loads N ONNX sessions).
pub type ClapPoolState = Mutex<Option<ClapPool>>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Allow tests to override the data directory so they don't clobber
            // the user's production state (embeddings, folder list, search index).
            let data_dir = match std::env::var("SOUNDHUNTER_E2E_DATA_DIR") {
                Ok(path) => std::path::PathBuf::from(path),
                Err(_) => app
                    .path()
                    .app_data_dir()
                    .expect("failed to resolve app data dir"),
            };
            std::fs::create_dir_all(&data_dir).ok();

            let app_state = AppState::new(data_dir.clone()).expect("failed to initialize app state");
            app.manage(Mutex::new(app_state));
            // Lazily-built pool of CLAP workers. Constructed on first embedding run.
            app.manage(Mutex::new(None::<ClapPool>));
            app.manage(EmbeddingRunning(AtomicBool::new(false)));
            app.manage(data_dir);
            app.manage(copy::CancelFlags::new(HashMap::new()));
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
            commands::preflight_copy,
            commands::start_copy,
            commands::cancel_copy,
            commands::set_playlist_last_copy_dest,
            commands::set_playlist_copy_options,
            commands::get_playlist_copy_options,
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
        clap_state: State<'_, Mutex<Option<super::clap::ClapPool>>>,
        query: String,
        limit: Option<usize>,
    ) -> Result<Vec<super::search::SearchResult>, String> {
        // Try to get a CLAP text embedding from the pool's dedicated text worker.
        // Non-blocking: if the pool hasn't been built yet (no embeddings exist)
        // or the text worker is busy, fall back to keyword-only search.
        let query_embedding = match clap_state.try_lock() {
            Ok(pool_lock) => pool_lock.as_ref().and_then(|pool| pool.try_embed_text(&query)),
            Err(_) => None,
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

    /// Spawn a background orchestrator thread that submits all unembedded files
    /// to the CLAP pool and drains completions, emitting progress along the way.
    ///
    /// Emits "embedding-progress" events with { done, total } and
    /// "embedding-complete" when finished.
    ///
    /// Returns immediately — folder walking, WAV parsing, and ONNX inference all
    /// happen on pool worker threads, so the Tauri command thread stays free.
    #[tauri::command]
    pub fn start_embedding(
        app: tauri::AppHandle,
        state: State<'_, Mutex<AppState>>,
        clap_state: State<'_, Mutex<Option<super::clap::ClapPool>>>,
        running: State<'_, super::EmbeddingRunning>,
        data_dir: State<'_, std::path::PathBuf>,
    ) -> Result<(), String> {
        use std::sync::atomic::Ordering;

        // If an embedding run is already in progress, this is a no-op. Prevents
        // overlapping runs (e.g. startup auto-start + user rescan) from emitting
        // conflicting {done,total} progress events.
        if running
            .0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(());
        }

        // Cheap snapshots under a brief lock. No disk I/O here.
        let (folders, already_embedded) = {
            let s = state.lock().map_err(|e| {
                running.0.store(false, Ordering::Release);
                e.to_string()
            })?;
            (s.get_folders(), s.embedded_paths_snapshot())
        };

        // Build the CLAP pool on first use. On first run this both downloads
        // the model files and spins up N worker threads with their own ONNX
        // sessions, which can take seconds.
        {
            let mut pool_lock = clap_state.lock().map_err(|e| {
                running.0.store(false, Ordering::Release);
                e.to_string()
            })?;
            if pool_lock.is_none() {
                eprintln!("Initializing CLAP pool...");
                match super::clap::ClapPool::new(&data_dir) {
                    Ok(pool) => *pool_lock = Some(pool),
                    Err(e) => {
                        running.0.store(false, Ordering::Release);
                        return Err(e.to_string());
                    }
                }
                eprintln!("CLAP pool ready.");
            }
        }

        let app_handle = app.clone();

        std::thread::spawn(move || {
            let running_ref = app_handle.state::<super::EmbeddingRunning>();

            // Walk folders off the main thread. For 18k+ files this can take
            // tens of seconds — doing it here keeps AppState unlocked for
            // search, stats, etc. during the walk.
            let mut paths_to_embed: Vec<String> = Vec::new();
            for folder in &folders {
                for f in super::scanner::scan_folder(folder) {
                    if !already_embedded.contains(&f.path) {
                        paths_to_embed.push(f.path);
                    }
                }
            }

            if paths_to_embed.is_empty() {
                running_ref.0.store(false, Ordering::Release);
                let _ = app_handle.emit("embedding-complete", serde_json::json!({ "total": 0 }));
                return;
            }

            let total = paths_to_embed.len();
            let state_ref = app_handle.state::<Mutex<AppState>>();
            let pool_ref = app_handle.state::<Mutex<Option<super::clap::ClapPool>>>();

            // Grab the completion receiver and a cloned submit-sender. Both are
            // taken under a single brief lock so the search path's text-embed
            // mutex-try_lock stays responsive while embedding runs.
            let (receiver, submit_tx) = {
                let mut pool_lock = pool_ref.lock().unwrap();
                let pool = pool_lock.as_mut().unwrap();
                let rx = pool.take_receiver().expect("pool receiver already taken");
                let tx = pool.submitter().expect("pool already shut down");
                (rx, tx)
            };

            // Submitter thread: pushes all paths into the pool's job channel.
            // Separated so the orchestrator can start draining completions
            // immediately instead of waiting until every path is queued.
            {
                let submitter_paths = paths_to_embed;
                std::thread::spawn(move || {
                    for path in submitter_paths {
                        if submit_tx.send(path).is_err() {
                            break;
                        }
                    }
                });
            }

            // Drain completions.
            let mut done: usize = 0;
            let mut since_persist = 0;
            let mut since_refresh = 0;

            while done < total {
                let result = match receiver.recv() {
                    Ok(r) => r,
                    Err(_) => break, // senders all dropped — pool shut down
                };

                {
                    let mut s = state_ref.lock().unwrap();
                    s.store_embedding(result.path, result.embedding);
                }

                done += 1;
                since_persist += 1;
                since_refresh += 1;

                let _ = app_handle.emit("embedding-progress", serde_json::json!({
                    "done": done,
                    "total": total,
                }));

                if since_refresh >= 100 {
                    let mut s = state_ref.lock().unwrap();
                    let _ = s.refresh_embeddings();
                    since_refresh = 0;
                }

                if since_persist >= 200 {
                    let s = state_ref.lock().unwrap();
                    let _ = s.persist_embedding_cache();
                    since_persist = 0;
                }
            }

            {
                let mut s = state_ref.lock().unwrap();
                let _ = s.refresh_embeddings();
                let _ = s.persist_embedding_cache();
            }

            // Return the receiver so the next embedding run can use the pool.
            {
                let mut pool_lock = pool_ref.lock().unwrap();
                if let Some(pool) = pool_lock.as_mut() {
                    pool.return_receiver(receiver);
                }
            }

            running_ref.0.store(false, Ordering::Release);
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

    #[tauri::command]
    pub fn preflight_copy(
        state: State<'_, Mutex<AppState>>,
        playlist_id: String,
        dest: String,
    ) -> Result<super::copy::PreflightResult, String> {
        let items = {
            let s = state.lock().map_err(|e| e.to_string())?;
            s.get_playlist_items(&playlist_id).map_err(|e| e.to_string())?
        };
        let dest_path = std::path::Path::new(&dest);
        Ok(super::copy::preflight(&items, dest_path))
    }

    #[tauri::command]
    pub fn start_copy(
        app: tauri::AppHandle,
        state: State<'_, Mutex<AppState>>,
        cancels: State<'_, super::copy::CancelFlags>,
        playlist_id: String,
        dest: String,
        copy_id: Option<String>,
        rename: Option<super::copy::RenameOptions>,
    ) -> Result<super::copy::StartResult, String> {
        use std::sync::Arc;
        use std::sync::atomic::AtomicBool;

        let items = {
            let s = state.lock().map_err(|e| e.to_string())?;
            s.get_playlist_items(&playlist_id).map_err(|e| e.to_string())?
        };

        let copy_id = copy_id.unwrap_or_else(super::copy::new_copy_id);
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut m = cancels.lock().map_err(|e| e.to_string())?;
            m.insert(copy_id.clone(), flag.clone());
        }

        let dest_path = std::path::PathBuf::from(&dest);
        if let Err(e) = std::fs::create_dir_all(&dest_path) {
            return Err(format!("could not create destination: {e}"));
        }

        let copy_id_thread = copy_id.clone();
        let app_handle = app.clone();

        std::thread::spawn(move || {
            let total = items.len() as u64;
            let _ = app_handle.emit(
                "copy-progress",
                serde_json::json!({
                    "copyId": copy_id_thread,
                    "done": 0u64,
                    "total": total,
                    "currentFile": "",
                }),
            );

            let cancel_ref = app_handle.state::<super::copy::CancelFlags>();
            let flag_for_run = flag.clone();

            let app_for_progress = app_handle.clone();
            let copy_id_for_progress = copy_id_thread.clone();
            let result = super::copy::run_copy(
                items,
                &dest_path,
                rename,
                flag_for_run,
                move |done, total, current| {
                    let _ = app_for_progress.emit(
                        "copy-progress",
                        serde_json::json!({
                            "copyId": copy_id_for_progress,
                            "done": done,
                            "total": total,
                            "currentFile": current,
                        }),
                    );
                },
            );

            {
                if let Ok(mut m) = cancel_ref.lock() {
                    m.remove(&copy_id_thread);
                }
            }

            let _ = app_handle.emit(
                "copy-complete",
                serde_json::json!({
                    "copyId": copy_id_thread,
                    "result": result,
                }),
            );
        });

        Ok(super::copy::StartResult { copy_id })
    }

    #[tauri::command]
    pub fn cancel_copy(
        cancels: State<'_, super::copy::CancelFlags>,
        copy_id: String,
    ) -> Result<(), String> {
        use std::sync::atomic::Ordering;
        let m = cancels.lock().map_err(|e| e.to_string())?;
        if let Some(flag) = m.get(&copy_id) {
            flag.store(true, Ordering::Release);
        }
        Ok(())
    }

    #[tauri::command]
    pub fn set_playlist_last_copy_dest(
        state: State<'_, Mutex<AppState>>,
        playlist_id: String,
        path: String,
    ) -> Result<(), String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.set_playlist_last_copy_dest(&playlist_id, path)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn set_playlist_copy_options(
        state: State<'_, Mutex<AppState>>,
        playlist_id: String,
        options: Option<super::state::PlaylistCopyOptions>,
    ) -> Result<(), String> {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.set_playlist_copy_options(&playlist_id, options)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn get_playlist_copy_options(
        state: State<'_, Mutex<AppState>>,
        playlist_id: String,
    ) -> Result<Option<super::state::PlaylistCopyOptions>, String> {
        let s = state.lock().map_err(|e| e.to_string())?;
        Ok(s.get_playlist_copy_options(&playlist_id))
    }
}
