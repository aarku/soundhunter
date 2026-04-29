import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PlaylistCopyOptions } from "@/hooks/useTauri";

export type CopyOptionsRequest = {
  playlistId: string;
  playlistName: string;
  sampleFilenames: string[];
  initial: PlaylistCopyOptions | null;
};

const PAD_MAX = 4;

export function CopyOptionsDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: CopyOptionsRequest | null;
  onCancel: () => void;
  onConfirm: (options: PlaylistCopyOptions) => void;
}) {
  const open = request !== null;
  const [rename, setRename] = useState(false);
  const [baseName, setBaseName] = useState("");
  const [pad, setPad] = useState(3);
  const [start, setStart] = useState(1);

  useEffect(() => {
    if (!request) return;
    const init = request.initial;
    if (init) {
      setRename(init.rename);
      setBaseName(init.baseName || request.playlistName);
      setPad(clamp(init.pad, 0, PAD_MAX));
      setStart(init.start === 0 ? 0 : 1);
    } else {
      setRename(false);
      setBaseName(request.playlistName);
      setPad(3);
      setStart(1);
    }
  }, [request]);

  const preview = useMemo(() => {
    if (!request) return [];
    return request.sampleFilenames.slice(0, 3).map((src, i) => {
      if (!rename) return src;
      const ext = extOf(src);
      const n = start + i;
      const num = pad === 0 ? String(n) : String(n).padStart(pad, "0");
      const trimmed = baseName.trim();
      const stem = trimmed ? `${trimmed} ${num}` : num;
      return ext ? `${stem}.${ext}` : stem;
    });
  }, [request, rename, baseName, pad, start]);

  const handleConfirm = () => {
    onConfirm({
      rename,
      baseName: baseName.trim(),
      pad,
      start,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Copy options</DialogTitle>
          <DialogDescription>
            Optionally rename files as they are copied.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={rename}
              onChange={(e) => setRename(e.target.checked)}
            />
            Rename files
          </label>

          <fieldset
            disabled={!rename}
            className="space-y-3 disabled:opacity-50"
          >
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                Base name
              </label>
              <Input
                value={baseName}
                onChange={(e) => setBaseName(e.target.value)}
                placeholder="e.g. Footstep"
              />
            </div>

            <div className="flex gap-3">
              <div className="space-y-1 flex-1">
                <label className="text-xs text-muted-foreground">
                  Zero-padding (0–{PAD_MAX})
                </label>
                <Input
                  type="number"
                  min={0}
                  max={PAD_MAX}
                  value={pad}
                  onChange={(e) =>
                    setPad(clamp(parseInt(e.target.value || "0", 10), 0, PAD_MAX))
                  }
                />
              </div>
              <div className="space-y-1 flex-1">
                <label className="text-xs text-muted-foreground">
                  Start at
                </label>
                <div className="flex gap-3 pt-2">
                  <label className="flex items-center gap-1 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="start-index"
                      checked={start === 0}
                      onChange={() => setStart(0)}
                    />
                    0
                  </label>
                  <label className="flex items-center gap-1 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="start-index"
                      checked={start === 1}
                      onChange={() => setStart(1)}
                    />
                    1
                  </label>
                </div>
              </div>
            </div>
          </fieldset>

          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Preview</div>
            <ul className="text-xs font-mono bg-muted/40 rounded px-2 py-1.5 space-y-0.5 min-h-[3.5rem]">
              {preview.length === 0 ? (
                <li className="text-muted-foreground italic">
                  (list is empty)
                </li>
              ) : (
                preview.map((p, i) => (
                  <li key={i} className="truncate" title={p}>
                    {p}
                  </li>
                ))
              )}
              {request && request.sampleFilenames.length > preview.length && (
                <li className="text-muted-foreground">
                  …and {request.sampleFilenames.length - preview.length} more
                </li>
              )}
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>Choose folder…</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(i + 1) : "";
}
