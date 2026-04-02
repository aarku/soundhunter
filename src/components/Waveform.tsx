import { useEffect, useRef, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";

interface WaveformProps {
  filePath: string;
  width?: number;
  height?: number;
  isPlaying?: boolean;
  className?: string;
}

// Cache decoded waveform data so we don't re-decode
const waveformCache = new Map<string, number[]>();

// Shared AudioContext
let audioContext: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

async function decodeWaveform(filePath: string, barCount: number): Promise<number[]> {
  const cached = waveformCache.get(filePath);
  if (cached && cached.length === barCount) return cached;

  const data = await readFile(filePath);
  const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

  const ctx = getAudioContext();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

  const channelData = audioBuffer.getChannelData(0);
  const samplesPerBar = Math.floor(channelData.length / barCount);
  const bars: number[] = [];

  for (let i = 0; i < barCount; i++) {
    let sum = 0;
    const start = i * samplesPerBar;
    const end = Math.min(start + samplesPerBar, channelData.length);
    for (let j = start; j < end; j++) {
      sum += Math.abs(channelData[j]);
    }
    bars.push(sum / (end - start));
  }

  // Normalize to 0-1
  const max = Math.max(...bars, 0.001);
  const normalized = bars.map((b) => b / max);

  waveformCache.set(filePath, normalized);
  return normalized;
}

export function Waveform({
  filePath,
  width = 120,
  height = 28,
  isPlaying = false,
  className = "",
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [bars, setBars] = useState<number[] | null>(null);
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Intersection observer: only decode when visible
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Decode when visible
  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    const barCount = Math.floor(width / 3); // ~3px per bar

    decodeWaveform(filePath, barCount)
      .then((data) => {
        if (!cancelled) setBars(data);
      })
      .catch(() => {
        // Silently fail for unsupported formats
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, visible, width]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bars) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const barWidth = 2;
    const gap = 1;
    const barCount = bars.length;
    const midY = height / 2;

    for (let i = 0; i < barCount; i++) {
      const x = i * (barWidth + gap);
      const barHeight = Math.max(1, bars[i] * (height - 2));
      const halfBar = barHeight / 2;

      if (isPlaying) {
        // Cyan/primary color when playing
        ctx.fillStyle = "oklch(0.7 0.15 200 / 0.9)";
      } else {
        // Muted when not playing
        ctx.fillStyle = "oklch(0.5 0 0 / 0.4)";
      }

      ctx.beginPath();
      ctx.roundRect(x, midY - halfBar, barWidth, barHeight, 1);
      ctx.fill();
    }
  }, [bars, width, height, isPlaying]);

  return (
    <div ref={containerRef} className={className} style={{ width, height }}>
      <canvas
        ref={canvasRef}
        style={{ width, height }}
      />
    </div>
  );
}
