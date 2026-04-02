import { useRef, useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

const SHORT_SOUND_THRESHOLD = 2; // seconds
const LOOP_PAUSE_MS = 1000;

export function useAudioPreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const [currentlyPlaying, setCurrentlyPlaying] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const stopProgressLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setProgress(0);
  }, []);

  const startProgressLoop = useCallback(() => {
    const tick = () => {
      const audio = audioRef.current;
      if (audio && audio.duration && !audio.paused) {
        setProgress(audio.currentTime / audio.duration);
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stop = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    stopProgressLoop();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    setCurrentlyPlaying(null);
  }, [stopProgressLoop]);

  const play = useCallback(
    (filePath: string) => {
      stop();
      setCurrentlyPlaying(filePath);

      const audio = audioRef.current || new Audio();
      audioRef.current = audio;
      audio.volume = 0.7;

      const handleEnded = () => {
        stopProgressLoop();
        if (audio.duration < SHORT_SOUND_THRESHOLD) {
          timeoutRef.current = window.setTimeout(() => {
            audio.currentTime = 0;
            setProgress(0);
            audio.play().catch(() => {});
            startProgressLoop();
          }, LOOP_PAUSE_MS);
        } else {
          audio.currentTime = 0;
          setProgress(0);
          audio.play().catch(() => {});
          startProgressLoop();
        }
      };

      audio.onended = handleEnded;
      audio.onplay = () => startProgressLoop();

      const url = convertFileSrc(filePath);
      audio.src = url;
      audio.play().catch((err) => {
        console.error("Failed to play audio:", err);
        setCurrentlyPlaying(null);
      });
    },
    [stop, stopProgressLoop, startProgressLoop]
  );

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return { play, stop, currentlyPlaying, progress };
}
