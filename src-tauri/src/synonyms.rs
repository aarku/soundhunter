use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use std::sync::{Mutex, OnceLock};

static MODEL: OnceLock<Mutex<TextEmbedding>> = OnceLock::new();

fn get_model() -> &'static Mutex<TextEmbedding> {
    MODEL.get_or_init(|| {
        let model = TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::AllMiniLML6V2Q)
                .with_show_download_progress(true),
        )
        .expect("Failed to initialize embedding model");
        Mutex::new(model)
    })
}

/// Embed a list of texts. Returns a Vec of embedding vectors.
pub fn embed_texts(texts: &[String]) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
    let mut model = get_model().lock().map_err(|e| e.to_string())?;
    let refs: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();
    let embeddings = model.embed(refs, None)?;
    Ok(embeddings)
}

/// Embed a single query string.
pub fn embed_query(query: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    let mut model = get_model().lock().map_err(|e| e.to_string())?;
    let embeddings = model.embed(vec![query], None)?;
    Ok(embeddings.into_iter().next().unwrap_or_default())
}

/// Compute cosine similarity (vectors are normalized, so dot product suffices).
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}
