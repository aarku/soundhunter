import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface WaveformProps {
  filePath: string;
  width?: number;
  height?: number;
  isPlaying?: boolean;
  /** 0.0 - 1.0 playback progress */
  progress?: number;
  /** Called with 0.0-1.0 position when user clicks on the waveform */
  onSeek?: (position: number) => void;
  onMouseEnter?: () => void;
  className?: string;
}

// Cache waveform peaks so we don't re-generate
const waveformCache = new Map<string, number[]>();

export function Waveform({
  filePath,
  width = 240,
  height = 24,
  isPlaying = false,
  progress = 0,
  onSeek,
  onMouseEnter,
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

  // Generate peaks when visible
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
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [filePath, visible, width]);

  // Draw - re-renders on progress change for playhead
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
    const step = barWidth + gap;
    const midY = height / 2;
    const progressX = isPlaying ? progress * width : 0;

    for (let i = 0; i < bars.length; i++) {
      const x = i * step;
      const barHeight = Math.max(1, bars[i] * (height - 2));
      const halfBar = barHeight / 2;

      // Bars before the playhead are "played" (bright), after are dim
      if (isPlaying && x + barWidth <= progressX) {
        ctx.fillStyle = "oklch(0.7 0.15 200 / 0.95)";
      } else if (isPlaying && x < progressX) {
        // Partially filled bar at the playhead edge
        ctx.fillStyle = "oklch(0.7 0.15 200 / 0.7)";
      } else {
        ctx.fillStyle = "oklch(0.5 0 0 / 0.35)";
      }

      ctx.beginPath();
      ctx.roundRect(x, midY - halfBar, barWidth, barHeight, 1);
      ctx.fill();
    }
  }, [bars, width, height, isPlaying, progress]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSeek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const position = Math.max(0, Math.min(1, x / rect.width));
    onSeek(position);
    e.stopPropagation();
  };

  return (
    <div ref={containerRef} className={className} style={{ width, height }} onMouseEnter={onMouseEnter}>
      <canvas
        ref={canvasRef}
        style={{ width, height, cursor: onSeek ? "pointer" : undefined }}
        onClick={handleClick}
      />
    </div>
  );
}
