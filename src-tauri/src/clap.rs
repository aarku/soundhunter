//! CLAP (Contrastive Language-Audio Pretraining) embedding engine.
//!
//! Embeds both audio files and text queries into the same 512-dim vector space
//! using the LAION CLAP model (Xenova/clap-htsat-unfused quantized ONNX).
//!
//! Architecture:
//!   * `ClapShared`   — immutable, Arc-shared: tokenizer, mel filterbank, model dir.
//!   * `ClapWorker`   — per-thread: owns its own audio + text ONNX sessions and
//!                      FFT planner. Not Sync. Each worker thread holds one.
//!   * `ClapPool`     — manages N audio-embedding workers behind a job channel
//!                      for parallel batch embedding, plus one text worker
//!                      behind a mutex for user search queries.

use crossbeam_channel::{unbounded, Receiver, Sender};
use ndarray::Array;
use ort::{session::Session, value::Value};
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use rustfft::{num_complex::Complex, FftPlanner};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use tokenizers::Tokenizer;

const SAMPLE_RATE: usize = 48000;
const N_FFT: usize = 1024;
const HOP_LENGTH: usize = 480;
const N_MELS: usize = 64;
const MEL_FMIN: f32 = 50.0;
const MEL_FMAX: f32 = 14000.0;
const MAX_LENGTH_S: f32 = 10.0;
const MAX_SAMPLES: usize = (SAMPLE_RATE as f32 * MAX_LENGTH_S) as usize; // 480000

/// Rough per-worker memory cost (audio + text quantized models + overhead).
const APPROX_BYTES_PER_WORKER: u64 = 250 * 1024 * 1024; // 250 MB

/// Immutable state shared by every worker via Arc.
pub struct ClapShared {
    model_dir: PathBuf,
    tokenizer: Tokenizer,
    mel_filterbank: Vec<Vec<f32>>,
}

impl ClapShared {
    pub fn new(cache_dir: &Path) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let model_dir = cache_dir.join("clap_model");
        std::fs::create_dir_all(&model_dir)?;
        Self::ensure_models(&model_dir)?;

        let tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json"))
            .map_err(|e| format!("Failed to load tokenizer: {}", e))?;

        let mel_filterbank = create_mel_filterbank();

        Ok(Arc::new(Self {
            model_dir,
            tokenizer,
            mel_filterbank,
        }))
    }

    fn ensure_models(model_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let base = "https://huggingface.co/Xenova/clap-htsat-unfused/resolve/main";
        let files = [
            ("audio_model_quantized.onnx", format!("{}/onnx/audio_model_quantized.onnx", base)),
            ("text_model_quantized.onnx", format!("{}/onnx/text_model_quantized.onnx", base)),
            ("tokenizer.json", format!("{}/tokenizer.json", base)),
        ];

        for (filename, url) in &files {
            let path = model_dir.join(filename);
            if !path.exists() {
                eprintln!("Downloading CLAP model: {}...", filename);
                let resp = ureq::get(url).call()?;
                let mut reader = resp.into_reader();
                let mut file = std::fs::File::create(&path)?;
                std::io::copy(&mut reader, &mut file)?;
                eprintln!("Downloaded {}", filename);
            }
        }
        Ok(())
    }
}

/// One worker owning its own ONNX sessions. Not Sync: confined to a single thread.
pub struct ClapWorker {
    shared: Arc<ClapShared>,
    audio_session: Session,
    text_session: Session,
    fft_planner: FftPlanner<f32>,
}

impl ClapWorker {
    /// Build a worker with `intra_threads` internal ONNX threads.
    pub fn new(shared: Arc<ClapShared>, intra_threads: usize) -> Result<Self, Box<dyn std::error::Error>> {
        let audio_session = Session::builder()?
            .with_intra_threads(intra_threads)?
            .commit_from_file(shared.model_dir.join("audio_model_quantized.onnx"))?;

        let text_session = Session::builder()?
            .with_intra_threads(intra_threads)?
            .commit_from_file(shared.model_dir.join("text_model_quantized.onnx"))?;

        Ok(Self {
            shared,
            audio_session,
            text_session,
            fft_planner: FftPlanner::new(),
        })
    }

    pub fn embed_text(&mut self, text: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let encoding = self.shared.tokenizer.encode(text, true)
            .map_err(|e| format!("Tokenization failed: {}", e))?;

        let input_ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
        let attention_mask: Vec<i64> = encoding.get_attention_mask().iter().map(|&m| m as i64).collect();
        let seq_len = input_ids.len();

        let ids_array = Array::from_shape_vec((1, seq_len), input_ids)?;
        let mask_array = Array::from_shape_vec((1, seq_len), attention_mask)?;

        let outputs = self.text_session.run(ort::inputs![
            "input_ids" => Value::from_array(ids_array)?,
            "attention_mask" => Value::from_array(mask_array)?,
        ])?;

        let value = outputs.iter().next().map(|(_, v)| v).ok_or("No output")?;
        let (_shape, data) = value.try_extract_tensor::<f32>()?;
        Ok(normalize(&data.to_vec()))
    }

    pub fn embed_audio(&mut self, path: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let samples = self.load_audio_mono_48k(path)?;

        let padded = if samples.len() >= MAX_SAMPLES {
            samples[..MAX_SAMPLES].to_vec()
        } else {
            let mut p = Vec::with_capacity(MAX_SAMPLES);
            while p.len() < MAX_SAMPLES {
                let take = (MAX_SAMPLES - p.len()).min(samples.len());
                p.extend_from_slice(&samples[..take]);
            }
            p
        };

        let mel = self.compute_mel_spectrogram(&padded);
        let time_steps = mel.len() / N_MELS;

        let mel_array = Array::from_shape_vec((1, 1, time_steps, N_MELS), mel)?;

        let outputs = self.audio_session.run(ort::inputs![
            "input_features" => Value::from_array(mel_array)?,
        ])?;

        let value = outputs.iter().next().map(|(_, v)| v).ok_or("No output")?;
        let (_shape, data) = value.try_extract_tensor::<f32>()?;
        Ok(normalize(&data.to_vec()))
    }

    fn load_audio_mono_48k(&self, path: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        use std::io::{Read, Seek, SeekFrom};

        let mut file = std::fs::File::open(path)?;
        let mut riff_header = [0u8; 12];
        file.read_exact(&mut riff_header)?;

        if &riff_header[0..4] != b"RIFF" || &riff_header[8..12] != b"WAVE" {
            return Err("Not a WAV file".into());
        }

        let mut num_channels: u16 = 0;
        let mut sample_rate: u32 = 0;
        let mut bits_per_sample: u16 = 0;
        let mut data_bytes = Vec::new();

        let mut chunk_header = [0u8; 8];
        loop {
            if file.read_exact(&mut chunk_header).is_err() { break; }
            let chunk_id = [chunk_header[0], chunk_header[1], chunk_header[2], chunk_header[3]];
            let chunk_size = u32::from_le_bytes([
                chunk_header[4], chunk_header[5], chunk_header[6], chunk_header[7],
            ]) as usize;

            if &chunk_id == b"fmt " {
                let mut fmt = vec![0u8; chunk_size.min(40)];
                file.read_exact(&mut fmt)?;
                if fmt.len() >= 16 {
                    num_channels = u16::from_le_bytes([fmt[2], fmt[3]]);
                    sample_rate = u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]);
                    bits_per_sample = u16::from_le_bytes([fmt[14], fmt[15]]);
                }
                let remaining = chunk_size - fmt.len();
                if remaining > 0 { file.seek(SeekFrom::Current(remaining as i64))?; }
            } else if &chunk_id == b"data" {
                // Limit to ~30s of audio
                let max_read = (SAMPLE_RATE * 30 * num_channels.max(1) as usize * (bits_per_sample.max(16) as usize / 8)).min(chunk_size);
                data_bytes.resize(max_read, 0);
                file.read_exact(&mut data_bytes)?;
                break;
            } else {
                let skip = if chunk_size % 2 == 1 { chunk_size + 1 } else { chunk_size };
                file.seek(SeekFrom::Current(skip as i64))?;
            }
        }

        if data_bytes.is_empty() || sample_rate == 0 {
            return Err("Invalid WAV".into());
        }

        let all_samples: Vec<f32> = match bits_per_sample {
            16 => data_bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect(),
            24 => data_bytes.chunks_exact(3).map(|b| {
                let val = ((b[2] as i32) << 24) | ((b[1] as i32) << 16) | ((b[0] as i32) << 8);
                val as f32 / 2147483648.0
            }).collect(),
            32 => data_bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect(),
            _ => data_bytes.iter().map(|&b| (b as f32 - 128.0) / 128.0).collect(),
        };

        let mono: Vec<f32> = if num_channels > 1 {
            let nc = num_channels as usize;
            all_samples.chunks(nc).map(|f| f.iter().sum::<f32>() / nc as f32).collect()
        } else {
            all_samples
        };

        if sample_rate as usize == SAMPLE_RATE {
            Ok(mono)
        } else {
            resample(&mono, sample_rate as usize, SAMPLE_RATE)
        }
    }

    fn compute_mel_spectrogram(&mut self, samples: &[f32]) -> Vec<f32> {
        let fft = self.fft_planner.plan_fft_forward(N_FFT);

        let window: Vec<f32> = (0..N_FFT)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / N_FFT as f32).cos()))
            .collect();

        let num_frames = 1 + samples.len().saturating_sub(N_FFT) / HOP_LENGTH;
        let mut mel_spec = Vec::with_capacity(num_frames * N_MELS);

        for frame_idx in 0..num_frames {
            let start = frame_idx * HOP_LENGTH;
            let mut fft_input: Vec<Complex<f32>> = (0..N_FFT)
                .map(|i| {
                    let s = if start + i < samples.len() { samples[start + i] } else { 0.0 };
                    Complex::new(s * window[i], 0.0)
                })
                .collect();

            fft.process(&mut fft_input);

            let power: Vec<f32> = fft_input[..N_FFT / 2 + 1].iter().map(|c| c.norm_sqr()).collect();

            for mel_bin in 0..N_MELS {
                let energy: f32 = power.iter().zip(self.shared.mel_filterbank[mel_bin].iter()).map(|(p, f)| p * f).sum();
                mel_spec.push((energy + 1e-10).log10());
            }
        }

        mel_spec
    }
}

fn resample(input: &[f32], from_rate: usize, to_rate: usize) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let chunk_size = 1024;
    let mut resampler = SincFixedIn::<f32>::new(
        to_rate as f64 / from_rate as f64,
        2.0,
        params,
        chunk_size,
        1,
    )?;

    let mut output = Vec::new();
    let mut pos = 0;
    while pos < input.len() {
        let end = (pos + chunk_size).min(input.len());
        let mut chunk = input[pos..end].to_vec();
        if chunk.len() < chunk_size { chunk.resize(chunk_size, 0.0); }
        let result = resampler.process(&[&chunk], None)?;
        output.extend_from_slice(&result[0]);
        pos += chunk_size;
    }

    let expected = (input.len() as f64 * to_rate as f64 / from_rate as f64) as usize;
    output.truncate(expected);
    Ok(output)
}

fn create_mel_filterbank() -> Vec<Vec<f32>> {
    let n_freqs = N_FFT / 2 + 1;
    let hz_to_mel = |f: f32| -> f32 { 2595.0 * (1.0 + f / 700.0).log10() };
    let mel_to_hz = |m: f32| -> f32 { 700.0 * (10.0_f32.powf(m / 2595.0) - 1.0) };

    let mel_min = hz_to_mel(MEL_FMIN);
    let mel_max = hz_to_mel(MEL_FMAX);
    let mel_points: Vec<f32> = (0..N_MELS + 2)
        .map(|i| mel_min + (mel_max - mel_min) * i as f32 / (N_MELS + 1) as f32)
        .collect();
    let hz_points: Vec<f32> = mel_points.iter().map(|&m| mel_to_hz(m)).collect();
    let freq_bins: Vec<f32> = (0..n_freqs).map(|i| i as f32 * SAMPLE_RATE as f32 / N_FFT as f32).collect();

    (0..N_MELS).map(|m| {
        let (fl, fc, fr) = (hz_points[m], hz_points[m + 1], hz_points[m + 2]);
        let filter: Vec<f32> = freq_bins.iter().map(|&f| {
            if f >= fl && f <= fc {
                if fc == fl { 0.0 } else { (f - fl) / (fc - fl) }
            } else if f > fc && f <= fr {
                if fr == fc { 0.0 } else { (fr - f) / (fr - fc) }
            } else { 0.0 }
        }).collect();
        let area = 2.0 / (hz_points[m + 2] - hz_points[m]);
        filter.iter().map(|&v| v * area).collect()
    }).collect()
}

fn normalize(v: &[f32]) -> Vec<f32> {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 { v.iter().map(|x| x / norm).collect() } else { v.to_vec() }
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

// ======================================================================
// Pool
// ======================================================================

/// Embedding result produced by an audio worker.
pub struct EmbedResult {
    pub path: String,
    pub embedding: Vec<f32>, // empty on failure
}

/// Pool of N audio-embedding workers plus one text-query worker.
pub struct ClapPool {
    #[allow(dead_code)]
    shared: Arc<ClapShared>,
    audio_workers: usize,
    job_tx: Option<Sender<String>>,
    worker_handles: Vec<JoinHandle<()>>,
    /// Completion channel. Background orchestrator drains this.
    result_rx: Option<Receiver<EmbedResult>>,
    /// Single-threaded worker dedicated to low-latency text queries from search.
    text_worker: Mutex<ClapWorker>,
}

impl ClapPool {
    /// Size the pool automatically based on CPU count and available RAM.
    /// Leaves headroom for the UI, search, and OS.
    pub fn new(cache_dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let shared = ClapShared::new(cache_dir)?;

        let logical = thread::available_parallelism().map(|n| n.get()).unwrap_or(4);

        // Use up to half of system RAM for model weights. On 32GB that's 16GB,
        // far more than needed. On 8GB it's 4GB — still room for ~16 workers
        // so the logical-cpu cap wins. On 4GB it would cap at ~8.
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        let total_ram = sys.total_memory(); // bytes
        let ram_budget = total_ram / 2;
        let ram_cap = (ram_budget / APPROX_BYTES_PER_WORKER).max(1) as usize;

        // Reserve ~4 threads for UI/search/OS. Cap at ram_cap. Always at least 2.
        let audio_workers = logical.saturating_sub(4).max(2).min(ram_cap).max(1);

        // Each ONNX session's internal thread pool. Keep small so N workers don't
        // oversubscribe. Roughly: audio_workers * intra_threads ≈ logical.
        let intra_threads = (logical / audio_workers).max(1).min(4);

        eprintln!(
            "CLAP pool: {} audio workers x {} intra threads (logical={}, ram_cap={})",
            audio_workers, intra_threads, logical, ram_cap
        );

        // Audio-embedding pipeline. crossbeam-channel is MPMC: every worker
        // can hold its own Receiver clone and call recv() concurrently without
        // any shared mutex — unlike std::sync::mpsc, which is SPMC and requires
        // serializing receivers through a Mutex (that's a deadlock trap: a
        // worker holds the lock across recv()'s block, serializing all workers).
        let (job_tx, job_rx) = unbounded::<String>();
        let (result_tx, result_rx) = unbounded::<EmbedResult>();

        let mut worker_handles = Vec::with_capacity(audio_workers);
        for worker_id in 0..audio_workers {
            let shared_w = Arc::clone(&shared);
            let job_rx = job_rx.clone();
            let result_tx = result_tx.clone();
            let handle = thread::Builder::new()
                .name(format!("clap-audio-{}", worker_id))
                .spawn(move || {
                    let mut worker = match ClapWorker::new(shared_w, intra_threads) {
                        Ok(w) => w,
                        Err(e) => {
                            eprintln!("ClapWorker {} failed to init: {}", worker_id, e);
                            return;
                        }
                    };
                    while let Ok(path) = job_rx.recv() {
                        let embedding = match worker.embed_audio(&path) {
                            Ok(emb) => emb,
                            Err(e) => {
                                eprintln!("Failed to embed {}: {}", path, e);
                                Vec::new()
                            }
                        };
                        if result_tx.send(EmbedResult { path, embedding }).is_err() {
                            break; // orchestrator dropped the receiver
                        }
                    }
                })?;
            worker_handles.push(handle);
        }
        // Drop the pool's own job_rx clone so the channel closes cleanly once
        // `job_tx` is dropped (on pool shutdown). Workers still hold their
        // individual clones.
        drop(job_rx);
        // Drop our result_tx clone so result_rx returns Err once every worker
        // has exited (not on every normal embedding completion).
        drop(result_tx);

        // Dedicated text worker for user search queries. Small intra-threads
        // budget since it's only used occasionally.
        let text_worker = ClapWorker::new(Arc::clone(&shared), 2)?;

        Ok(Self {
            shared,
            audio_workers,
            job_tx: Some(job_tx),
            worker_handles,
            result_rx: Some(result_rx),
            text_worker: Mutex::new(text_worker),
        })
    }

    pub fn worker_count(&self) -> usize {
        self.audio_workers
    }

    /// Submit a path for audio embedding. Non-blocking (bounded only by OS pipe).
    pub fn submit(&self, path: String) -> Result<(), Box<dyn std::error::Error>> {
        self.job_tx.as_ref().ok_or("pool shut down")?.send(path)?;
        Ok(())
    }

    /// Clone of the submit channel so a caller can enqueue jobs without
    /// holding the pool mutex. Returns None after the pool has been shut down.
    pub fn submitter(&self) -> Option<Sender<String>> {
        self.job_tx.clone()
    }

    /// Take the completion receiver out of the pool. The caller (orchestrator
    /// thread) drains it until all submitted jobs have completed. Only one
    /// consumer is supported; calling this twice returns None.
    pub fn take_receiver(&mut self) -> Option<Receiver<EmbedResult>> {
        self.result_rx.take()
    }

    /// Called after the orchestrator drains the receiver, to put it back so a
    /// subsequent embedding run can reuse the same pool.
    pub fn return_receiver(&mut self, rx: Receiver<EmbedResult>) {
        self.result_rx = Some(rx);
    }

    /// Low-latency text embedding for search queries. Runs on the dedicated
    /// text worker so it doesn't contend with bulk audio embedding.
    pub fn embed_text(&self, text: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let mut w = self.text_worker.lock().map_err(|e| e.to_string())?;
        w.embed_text(text)
    }

    /// Non-blocking variant used by search so a long-running text query can't
    /// freeze the UI. Returns None if the text worker is currently busy.
    pub fn try_embed_text(&self, text: &str) -> Option<Vec<f32>> {
        match self.text_worker.try_lock() {
            Ok(mut w) => w.embed_text(text).ok(),
            Err(_) => None,
        }
    }
}

impl Drop for ClapPool {
    fn drop(&mut self) {
        // Close the job channel so workers exit their recv loops.
        drop(self.job_tx.take());
        for h in self.worker_handles.drain(..) {
            let _ = h.join();
        }
    }
}
