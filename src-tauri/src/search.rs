use crate::scanner::AudioFile;
use crate::synonyms;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, FuzzyTermQuery, Occur, Query, TermQuery};
use tantivy::schema::*;
use tantivy::{self, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub path: String,
    pub filename: String,
    pub parent_folder: String,
    pub score: f32,
    pub extension: String,
    pub size_bytes: u64,
}

pub struct SearchEngine {
    index: Index,
    reader: IndexReader,
    #[allow(dead_code)]
    schema: Schema,
    f_path: Field,
    f_filename: Field,
    f_tokens: Field,
    f_parent_folder: Field,
    f_extension: Field,
    f_size: Field,
    // Semantic search data
    embeddings: Vec<Vec<f32>>,
    file_paths: Vec<String>, // parallel to embeddings, for lookup
}

impl SearchEngine {
    pub fn new(index_path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let mut schema_builder = Schema::builder();

        let f_path = schema_builder.add_text_field("path", STORED | STRING);
        let f_filename = schema_builder.add_text_field("filename", STORED | TEXT);
        let f_tokens = schema_builder.add_text_field("tokens", TEXT);
        let f_parent_folder = schema_builder.add_text_field("parent_folder", STORED | TEXT);
        let f_extension = schema_builder.add_text_field("extension", STORED | STRING);
        let f_size = schema_builder.add_u64_field("size", STORED | INDEXED);

        let schema = schema_builder.build();

        std::fs::create_dir_all(index_path)?;

        let index = if index_path.join("meta.json").exists() {
            Index::open_in_dir(index_path)?
        } else {
            Index::create_in_dir(index_path, schema.clone())?
        };

        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()?;

        Ok(Self {
            index,
            reader,
            schema,
            f_path,
            f_filename,
            f_tokens,
            f_parent_folder,
            f_extension,
            f_size,
            embeddings: Vec::new(),
            file_paths: Vec::new(),
        })
    }

    pub fn reindex(&mut self, files: &[AudioFile]) -> Result<(), Box<dyn std::error::Error>> {
        // Tantivy index
        let mut writer: IndexWriter = self.index.writer(50_000_000)?;
        writer.delete_all_documents()?;
        writer.commit()?;

        for file in files {
            let mut doc = TantivyDocument::default();
            doc.add_text(self.f_path, &file.path);
            doc.add_text(self.f_filename, &file.filename);
            doc.add_text(self.f_tokens, file.tokens.join(" "));
            doc.add_text(self.f_parent_folder, &file.parent_folder);
            doc.add_text(self.f_extension, &file.extension);
            doc.add_u64(self.f_size, file.size_bytes);
            writer.add_document(doc)?;
        }

        writer.commit()?;
        self.reader.reload()?;

        // Semantic embeddings
        // Build search text: combine filename tokens + cleaned parent folder for richer context
        let texts: Vec<String> = files
            .iter()
            .map(|f| {
                let mut text = f.tokens.join(" ");
                if !f.parent_folder_clean.is_empty() {
                    text.push(' ');
                    text.push_str(&f.parent_folder_clean);
                }
                text
            })
            .collect();

        self.file_paths = files.iter().map(|f| f.path.clone()).collect();
        self.embeddings = synonyms::embed_texts(&texts)?;

        Ok(())
    }

    pub fn search(
        &self,
        query_str: &str,
        limit: usize,
    ) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
        let searcher = self.reader.searcher();

        let query_terms: Vec<String> = query_str
            .to_lowercase()
            .split_whitespace()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        if query_terms.is_empty() {
            return Ok(Vec::new());
        }

        // 1. Tantivy keyword + fuzzy search
        let mut keyword_scores: HashMap<String, f32> = HashMap::new();
        {
            let mut must_clauses: Vec<Box<dyn Query>> = Vec::new();

            for term_str in &query_terms {
                let mut term_variants: Vec<(Occur, Box<dyn Query>)> = Vec::new();

                // Exact on tokens
                let term = tantivy::Term::from_field_text(self.f_tokens, term_str);
                term_variants.push((
                    Occur::Should,
                    Box::new(TermQuery::new(term, IndexRecordOption::WithFreqs)),
                ));

                // Exact on filename
                let term_fn = tantivy::Term::from_field_text(self.f_filename, term_str);
                term_variants.push((
                    Occur::Should,
                    Box::new(TermQuery::new(term_fn, IndexRecordOption::WithFreqs)),
                ));

                // Exact on parent folder
                let term_pf = tantivy::Term::from_field_text(self.f_parent_folder, term_str);
                term_variants.push((
                    Occur::Should,
                    Box::new(TermQuery::new(term_pf, IndexRecordOption::WithFreqs)),
                ));

                // Fuzzy on tokens (distance 1)
                let fuzzy_term = tantivy::Term::from_field_text(self.f_tokens, term_str);
                term_variants.push((
                    Occur::Should,
                    Box::new(FuzzyTermQuery::new(fuzzy_term, 1, true)),
                ));

                // Fuzzy on filename
                let fuzzy_fn = tantivy::Term::from_field_text(self.f_filename, term_str);
                term_variants.push((
                    Occur::Should,
                    Box::new(FuzzyTermQuery::new(fuzzy_fn, 1, true)),
                ));

                must_clauses.push(Box::new(BooleanQuery::new(term_variants)));
            }

            let final_query = BooleanQuery::new(
                must_clauses
                    .into_iter()
                    .map(|q| (Occur::Must, q))
                    .collect(),
            );

            let top_docs = searcher.search(&final_query, &TopDocs::with_limit(limit * 2))?;

            for (score, doc_address) in top_docs {
                let doc: TantivyDocument = searcher.doc(doc_address)?;
                let path = doc
                    .get_first(self.f_path)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                keyword_scores.insert(path, score);
            }
        }

        // 2. Semantic search via embeddings
        let mut semantic_scores: HashMap<String, f32> = HashMap::new();
        if !self.embeddings.is_empty() {
            let query_emb = synonyms::embed_query(query_str)?;

            let mut scored: Vec<(usize, f32)> = self
                .embeddings
                .iter()
                .enumerate()
                .map(|(i, emb)| (i, synonyms::cosine_similarity(emb, &query_emb)))
                .collect();

            scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

            // Take top results with a minimum similarity threshold
            for (i, score) in scored.iter().take(limit * 2) {
                if *score > 0.15 {
                    if let Some(path) = self.file_paths.get(*i) {
                        semantic_scores.insert(path.clone(), *score);
                    }
                }
            }
        }

        // 3. Combine scores: normalize and merge
        let keyword_max = keyword_scores.values().cloned().fold(0.0f32, f32::max);
        let semantic_max = semantic_scores.values().cloned().fold(0.0f32, f32::max);

        let mut combined: HashMap<String, f32> = HashMap::new();

        for (path, score) in &keyword_scores {
            let normalized = if keyword_max > 0.0 {
                score / keyword_max
            } else {
                0.0
            };
            *combined.entry(path.clone()).or_insert(0.0) += normalized * 0.6; // 60% keyword weight
        }

        for (path, score) in &semantic_scores {
            let normalized = if semantic_max > 0.0 {
                score / semantic_max
            } else {
                0.0
            };
            *combined.entry(path.clone()).or_insert(0.0) += normalized * 0.4; // 40% semantic weight
        }

        // Sort by combined score
        let mut sorted: Vec<(String, f32)> = combined.into_iter().collect();
        sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        // Fetch full docs for the top results
        let mut results = Vec::new();
        for (path, score) in sorted.into_iter().take(limit) {
            // Look up the doc in tantivy by path
            let term = tantivy::Term::from_field_text(self.f_path, &path);
            let query = TermQuery::new(term, IndexRecordOption::Basic);
            let top = searcher.search(&query, &TopDocs::with_limit(1))?;

            if let Some((_s, doc_address)) = top.first() {
                let doc: TantivyDocument = searcher.doc(*doc_address)?;

                let filename = doc
                    .get_first(self.f_filename)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let parent_folder = doc
                    .get_first(self.f_parent_folder)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let extension = doc
                    .get_first(self.f_extension)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let size_bytes = doc
                    .get_first(self.f_size)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);

                results.push(SearchResult {
                    path,
                    filename,
                    parent_folder,
                    score,
                    extension,
                    size_bytes,
                });
            }
        }

        Ok(results)
    }

    pub fn doc_count(&self) -> usize {
        let searcher = self.reader.searcher();
        searcher
            .segment_readers()
            .iter()
            .map(|s| s.num_docs() as usize)
            .sum()
    }
}
