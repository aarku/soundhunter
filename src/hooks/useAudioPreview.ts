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

      const src = convertFileSrc(filePath);
      const audio = audioRef.current || new Audio();
      audioRef.current = audio;

      audio.src = src;
      audio.volume = 0.7;
      setCurrentlyPlaying(filePath);

      const handleEnded = () => {
        // If the sound is short, add a pause before looping
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
      audio.play().catch(() => {});
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
