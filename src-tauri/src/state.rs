use crate::clap::ClapEngine;
use crate::scanner;
use crate::search::{SearchEngine, SearchResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub items: Vec<String>, // file paths
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
    clap_engine: Option<ClapEngine>,
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
            clap_engine: None,
            embedding_cache,
        })
    }

    fn ensure_clap(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if self.clap_engine.is_none() {
            eprintln!("Initializing CLAP engine...");
            self.clap_engine = Some(ClapEngine::new(&self.data_dir)?);
            eprintln!("CLAP engine ready.");
        }
        Ok(())
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

    pub fn scan_and_index(&mut self) -> Result<usize, Box<dyn std::error::Error>> {
        let mut all_files = Vec::new();
        for folder in &self.folders {
            let files = scanner::scan_folder(folder);
            all_files.extend(files);
        }

        let count = all_files.len();

        // Compute CLAP audio embeddings for new files
        self.ensure_clap()?;
        if let Some(ref mut clap) = self.clap_engine {
            let mut new_count = 0;
            for file in &all_files {
                if !self.embedding_cache.embeddings.contains_key(&file.path) {
                    match clap.embed_audio(&file.path) {
                        Ok(embedding) => {
                            self.embedding_cache.embeddings.insert(file.path.clone(), embedding);
                            new_count += 1;
                            if new_count % 10 == 0 {
                                eprintln!("Embedded {}/{} audio files...", new_count, count);
                            }
                        }
                        Err(e) => {
                            eprintln!("Failed to embed {}: {}", file.path, e);
                        }
                    }
                }
            }
            if new_count > 0 {
                eprintln!("Embedded {} new audio files.", new_count);
                self.save_embedding_cache()?;
            }
        }

        // Build file_paths + embeddings vectors for search engine
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

    pub fn search(
        &mut self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
        // Get CLAP text embedding for semantic search
        let query_embedding = if let Some(ref mut clap) = self.clap_engine {
            clap.embed_text(query).ok()
        } else {
            None
        };

        self.search_engine.search(query, limit, query_embedding.as_deref())
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

    pub fn add_to_playlist(
        &mut self,
        playlist_id: &str,
        file_path: String,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == playlist_id) {
            if !p.items.contains(&file_path) {
                p.items.push(file_path);
            }
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
}
