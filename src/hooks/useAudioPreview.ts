import { useRef, useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

const SHORT_SOUND_THRESHOLD = 2; // seconds
const LOOP_PAUSE_MS = 1000;

export function useAudioPreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const currentPathRef = useRef<string | null>(null);
  const [currentlyPlaying, setCurrentlyPlaying] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const stopRaf = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const startRaf = useCallback(() => {
    stopRaf();
    const tick = () => {
      const audio = audioRef.current;
      if (audio && audio.duration > 0 && !audio.paused) {
        setProgress(audio.currentTime / audio.duration);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [stopRaf]);

  const stop = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    stopRaf();
    setProgress(0);
    currentPathRef.current = null;
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    setCurrentlyPlaying(null);
  }, [stopRaf]);

  const play = useCallback(
    (filePath: string) => {
      stop();
      currentPathRef.current = filePath;
      setCurrentlyPlaying(filePath);
      setProgress(0);

      const audio = audioRef.current || new Audio();
      audioRef.current = audio;
      audio.volume = 0.7;

      audio.onended = () => {
        if (currentPathRef.current !== filePath) return;
        stopRaf();
        if (audio.duration < SHORT_SOUND_THRESHOLD) {
          timeoutRef.current = window.setTimeout(() => {
            if (currentPathRef.current !== filePath) return;
            audio.currentTime = 0;
            setProgress(0);
            audio.play().catch(() => {});
            startRaf();
          }, LOOP_PAUSE_MS);
        } else {
          audio.currentTime = 0;
          setProgress(0);
          audio.play().catch(() => {});
        }
      };

      const url = convertFileSrc(filePath);
      audio.src = url;
      startRaf();
      audio.play().catch((err) => {
        if (err.name === "AbortError") return;
        console.error("Failed to play audio:", err);
        if (currentPathRef.current === filePath) {
          setCurrentlyPlaying(null);
        }
      });
    },
    [stop, stopRaf, startRaf]
  );

  const seek = useCallback((position: number) => {
    const audio = audioRef.current;
    if (audio && audio.duration > 0) {
      audio.currentTime = position * audio.duration;
      setProgress(position);
    }
  }, []);

  useEffect(() => {
    return () => { stop(); };
  }, [stop]);

  return { play, stop, seek, currentlyPlaying, progress };
}
