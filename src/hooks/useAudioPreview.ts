import { useRef, useCallback, useEffect, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";

const SHORT_SOUND_THRESHOLD = 2; // seconds
const LOOP_PAUSE_MS = 1000;

// Cache blob URLs to avoid re-reading files
const blobUrlCache = new Map<string, string>();

function getMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const mimeMap: Record<string, string> = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    flac: "audio/flac",
    aac: "audio/aac",
    m4a: "audio/mp4",
    aif: "audio/aiff",
    aiff: "audio/aiff",
    wma: "audio/x-ms-wma",
  };
  return mimeMap[ext] || "audio/wav";
}

async function getAudioUrl(filePath: string): Promise<string> {
  const cached = blobUrlCache.get(filePath);
  if (cached) return cached;

  const data = await readFile(filePath);
  const blob = new Blob([data], { type: getMimeType(filePath) });
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(filePath, url);
  return url;
}

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

      getAudioUrl(filePath)
        .then((url) => {
          audio.src = url;
          audio.play().catch(() => {});
        })
        .catch((err) => {
          console.error("Failed to load audio:", err);
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
