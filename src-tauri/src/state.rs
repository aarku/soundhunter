use crate::scanner;
use crate::search::{SearchEngine, SearchResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlaylistCopyOptions {
    pub rename: bool,
    #[serde(rename = "baseName", default)]
    pub base_name: String,
    #[serde(default)]
    pub pad: u8,
    #[serde(default)]
    pub start: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub items: Vec<String>, // file paths
    #[serde(default)]
    pub last_copy_dest: Option<String>,
    #[serde(default)]
    pub copy_options: Option<PlaylistCopyOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stats {
    pub total_files: usize,
    pub total_folders: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedData {
    folders: Vec<String>,
    playlists: Vec<Playlist>,
}

/// Cached audio embeddings keyed by file path.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct EmbeddingCache {
    embeddings: HashMap<String, Vec<f32>>,
}

pub struct AppState {
    data_dir: PathBuf,
    folders: Vec<String>,
    playlists: Vec<Playlist>,
    search_engine: SearchEngine,
    file_count: usize,
    embedding_cache: EmbeddingCache,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let index_path = data_dir.join("search_index");
        let search_engine = SearchEngine::new(&index_path)?;

        let persisted = Self::load_persisted(&data_dir);
        let file_count = search_engine.doc_count();
        let embedding_cache = Self::load_embedding_cache(&data_dir);

        Ok(Self {
            folders: persisted.folders,
            playlists: persisted.playlists,
            search_engine,
            file_count,
            data_dir,
            embedding_cache,
        })
    }

    fn embedding_cache_path(data_dir: &PathBuf) -> PathBuf {
        data_dir.join("clap_embeddings.json")
    }

    fn load_embedding_cache(data_dir: &PathBuf) -> EmbeddingCache {
        let path = Self::embedding_cache_path(data_dir);
        if path.exists() {
            if let Ok(data) = std::fs::read_to_string(&path) {
                if let Ok(cache) = serde_json::from_str::<EmbeddingCache>(&data) {
                    return cache;
                }
            }
        }
        EmbeddingCache::default()
    }

    fn save_embedding_cache(&self) -> Result<(), Box<dyn std::error::Error>> {
        let json = serde_json::to_string(&self.embedding_cache)?;
        std::fs::write(Self::embedding_cache_path(&self.data_dir), json)?;
        Ok(())
    }

    fn persisted_path(data_dir: &PathBuf) -> PathBuf {
        data_dir.join("soundhunter_data.json")
    }

    fn load_persisted(data_dir: &PathBuf) -> PersistedData {
        let path = Self::persisted_path(data_dir);
        if path.exists() {
            if let Ok(data) = std::fs::read_to_string(&path) {
                if let Ok(persisted) = serde_json::from_str::<PersistedData>(&data) {
                    return persisted;
                }
            }
        }
        PersistedData {
            folders: Vec::new(),
            playlists: Vec::new(),
        }
    }

    fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        let persisted = PersistedData {
            folders: self.folders.clone(),
            playlists: self.playlists.clone(),
        };
        let json = serde_json::to_string_pretty(&persisted)?;
        std::fs::write(Self::persisted_path(&self.data_dir), json)?;
        Ok(())
    }

    pub fn add_folder(&mut self, path: String) -> Result<(), Box<dyn std::error::Error>> {
        if !self.folders.contains(&path) {
            self.folders.push(path);
            self.save()?;
        }
        Ok(())
    }

    pub fn remove_folder(&mut self, path: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.folders.retain(|f| f != path);
        self.save()?;
        // Re-index without the removed folder
        self.scan_and_index()?;
        Ok(())
    }

    pub fn get_folders(&self) -> Vec<String> {
        self.folders.clone()
    }

    /// Fast scan: keyword index only. Returns immediately.
    pub fn scan_and_index(&mut self) -> Result<usize, Box<dyn std::error::Error>> {
        let mut all_files = Vec::new();
        for folder in &self.folders {
            let files = scanner::scan_folder(folder);
            all_files.extend(files);
        }

        let count = all_files.len();

        // Use any existing CLAP embeddings from cache
        let mut audio_embeddings: Vec<Vec<f32>> = Vec::new();
        let mut audio_paths: Vec<String> = Vec::new();
        for file in &all_files {
            if let Some(emb) = self.embedding_cache.embeddings.get(&file.path) {
                audio_paths.push(file.path.clone());
                audio_embeddings.push(emb.clone());
            }
        }

        self.search_engine.reindex(&all_files, &audio_paths, &audio_embeddings)?;
        self.file_count = count;
        Ok(count)
    }

    /// Snapshot of which paths are already embedded. Used by the background
    /// embedder to collect work outside the state lock.
    pub fn embedded_paths_snapshot(&self) -> std::collections::HashSet<String> {
        self.embedding_cache.embeddings.keys().cloned().collect()
    }

    /// Store an embedding in memory only. Persist is deferred — call
    /// `persist_embedding_cache` periodically from the caller.
    pub fn store_embedding(&mut self, path: String, embedding: Vec<f32>) {
        self.embedding_cache.embeddings.insert(path, embedding);
    }

    /// Flush the in-memory embedding cache to disk.
    pub fn persist_embedding_cache(&self) -> Result<(), Box<dyn std::error::Error>> {
        self.save_embedding_cache()
    }

    /// Push the current embedding cache into the search engine's semantic-search
    /// arrays. Does NOT touch the tantivy keyword index, so this is cheap and
    /// safe to call frequently during background embedding.
    pub fn refresh_embeddings(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let mut audio_paths: Vec<String> = Vec::with_capacity(self.embedding_cache.embeddings.len());
        let mut audio_embeddings: Vec<Vec<f32>> = Vec::with_capacity(self.embedding_cache.embeddings.len());
        for (path, emb) in &self.embedding_cache.embeddings {
            if !emb.is_empty() {
                audio_paths.push(path.clone());
                audio_embeddings.push(emb.clone());
            }
        }
        self.search_engine.set_embeddings(audio_paths, audio_embeddings);
        Ok(())
    }

    pub fn search(
        &self,
        query: &str,
        limit: usize,
        query_embedding: Option<&[f32]>,
    ) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
        self.search_engine.search(query, limit, query_embedding)
    }

    pub fn get_stats(&self) -> Stats {
        Stats {
            total_files: self.file_count,
            total_folders: self.folders.len(),
        }
    }

    // Playlist management
    pub fn get_playlists(&self) -> Vec<Playlist> {
        self.playlists.clone()
    }

    pub fn create_playlist(&mut self, name: String) -> Result<(), Box<dyn std::error::Error>> {
        let id = format!("pl_{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis());
        self.playlists.push(Playlist {
            id,
            name,
            items: Vec::new(),
            last_copy_dest: None,
            copy_options: None,
        });
        self.save()?;
        Ok(())
    }

    pub fn delete_playlist(&mut self, id: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.playlists.retain(|p| p.id != id);
        self.save()?;
        Ok(())
    }

    pub fn rename_playlist(
        &mut self,
        id: &str,
        name: String,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == id) {
            p.name = name;
        }
        self.save()?;
        Ok(())
    }

    pub fn reorder_playlists(
        &mut self,
        ids: Vec<String>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut reordered = Vec::new();
        for id in &ids {
            if let Some(pos) = self.playlists.iter().position(|p| p.id == *id) {
                reordered.push(self.playlists[pos].clone());
            }
        }
        self.playlists = reordered;
        self.save()?;
        Ok(())
    }

    pub fn add_to_playlist(
        &mut self,
        playlist_id: &str,
        file_path: String,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == playlist_id) {
            // Remove from old position if already present (move, not duplicate)
            p.items.retain(|i| i != &file_path);
            p.items.push(file_path);
        }
        self.save()?;
        Ok(())
    }

    pub fn remove_from_playlist(
        &mut self,
        playlist_id: &str,
        file_path: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == playlist_id) {
            p.items.retain(|i| i != file_path);
        }
        self.save()?;
        Ok(())
    }

    pub fn get_playlist_items(
        &self,
        playlist_id: &str,
    ) -> Result<Vec<String>, Box<dyn std::error::Error>> {
        if let Some(p) = self.playlists.iter().find(|p| p.id == playlist_id) {
            Ok(p.items.clone())
        } else {
            Err("Playlist not found".into())
        }
    }

    pub fn reorder_playlist(
        &mut self,
        playlist_id: &str,
        items: Vec<String>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == playlist_id) {
            p.items = items;
        }
        self.save()?;
        Ok(())
    }

    pub fn set_playlist_last_copy_dest(
        &mut self,
        playlist_id: &str,
        path: String,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == playlist_id) {
            p.last_copy_dest = Some(path);
        }
        self.save()?;
        Ok(())
    }

    pub fn set_playlist_copy_options(
        &mut self,
        playlist_id: &str,
        options: Option<PlaylistCopyOptions>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == playlist_id) {
            p.copy_options = options;
        }
        self.save()?;
        Ok(())
    }

    pub fn get_playlist_copy_options(
        &self,
        playlist_id: &str,
    ) -> Option<PlaylistCopyOptions> {
        self.playlists
            .iter()
            .find(|p| p.id == playlist_id)
            .and_then(|p| p.copy_options.clone())
    }
}
