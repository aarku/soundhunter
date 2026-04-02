import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface WaveformProps {
  filePath: string;
  width?: number;
  height?: number;
  isPlaying?: boolean;
  className?: string;
}

// Cache waveform peaks so we don't re-generate
const waveformCache = new Map<string, number[]>();

export function Waveform({
  filePath,
  width = 80,
  height = 24,
  isPlaying = false,
  className = "",
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [bars, setBars] = useState<number[] | null>(null);
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Intersection observer: only generate when visible
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

  // Generate peaks when visible (Rust does the heavy lifting off-thread)
  useEffect(() => {
    if (!visible) return;

    const cached = waveformCache.get(filePath);
    if (cached) {
      setBars(cached);
      return;
    }

    let cancelled = false;
    const barCount = Math.floor(width / 3);

    invoke<number[]>("generate_waveform", { path: filePath, barCount })
      .then((peaks) => {
        if (!cancelled) {
          waveformCache.set(filePath, peaks);
          setBars(peaks);
        }
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
    const midY = height / 2;

    for (let i = 0; i < bars.length; i++) {
      const x = i * (barWidth + gap);
      const barHeight = Math.max(1, bars[i] * (height - 2));
      const halfBar = barHeight / 2;

      ctx.fillStyle = isPlaying
        ? "oklch(0.7 0.15 200 / 0.9)"
        : "oklch(0.5 0 0 / 0.4)";

      ctx.beginPath();
      ctx.roundRect(x, midY - halfBar, barWidth, barHeight, 1);
      ctx.fill();
    }
  }, [bars, width, height, isPlaying]);

  return (
    <div ref={containerRef} className={className} style={{ width, height }}>
      <canvas ref={canvasRef} style={{ width, height }} />
    </div>
  );
}
