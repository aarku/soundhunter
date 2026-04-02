import { useRef, useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

const SHORT_SOUND_THRESHOLD = 2; // seconds
const LOOP_PAUSE_MS = 1000;

export function useAudioPreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const [currentlyPlaying, setCurrentlyPlaying] = useState<string | null>(null);

  const stop = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    setCurrentlyPlaying(null);
  }, []);

  const play = useCallback(
    (filePath: string) => {
      stop();
      setCurrentlyPlaying(filePath);

      const audio = audioRef.current || new Audio();
      audioRef.current = audio;
      audio.volume = 0.7;

      const handleEnded = () => {
        if (audio.duration < SHORT_SOUND_THRESHOLD) {
          timeoutRef.current = window.setTimeout(() => {
            audio.currentTime = 0;
            audio.play().catch(() => {});
          }, LOOP_PAUSE_MS);
        } else {
          audio.currentTime = 0;
          audio.play().catch(() => {});
        }
      };

      audio.onended = handleEnded;

      // Use asset protocol - streams directly, no need to read entire file
      const url = convertFileSrc(filePath);
      audio.src = url;
      audio.play().catch((err) => {
        console.error("Failed to play audio:", err);
        setCurrentlyPlaying(null);
      });
    },
    [stop]
  );

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return { play, stop, currentlyPlaying };
}
