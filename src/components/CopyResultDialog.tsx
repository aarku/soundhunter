import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { CopyResult } from "@/hooks/useTauri";

export type CopyResultDialogPayload = {
  result: CopyResult;
  total: number;
  destLabel: string;
};

export function CopyResultDialog({
  payload,
  onClose,
}: {
  payload: CopyResultDialogPayload | null;
  onClose: () => void;
}) {
  const open = payload !== null;
  const result = payload?.result;
  const total = payload?.total ?? 0;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Copy complete</AlertDialogTitle>
        </AlertDialogHeader>
        {result && (
          <div className="space-y-3">
            <div className="text-sm">
              Copied {result.copied} of {total} sound{total === 1 ? "" : "s"}
              {payload?.destLabel ? ` to ${payload.destLabel}` : ""}.
            </div>
            <ScrollArea className="max-h-80 pr-2">
              <div className="space-y-3 text-xs">
                {result.skipped.length > 0 && (
                  <ResultSection
                    title={`Skipped (already in destination): ${result.skipped.length}`}
                    items={result.skipped}
                  />
                )}
                {result.renamed.length > 0 && (
                  <ResultSection
                    title={`Renamed due to collision: ${result.renamed.length}`}
                    items={result.renamed.map((r) => `${r.from} → ${r.to}`)}
                  />
                )}
                {result.missing.length > 0 && (
                  <ResultSection
                    title={`Missing from disk: ${result.missing.length}`}
                    items={result.missing}
                  />
                )}
                {result.errors.length > 0 && (
                  <ResultSection
                    title={`Errors: ${result.errors.length}`}
                    items={result.errors.map(
                      (e) =>
                        `${basename(e.path)} — ${e.message}`
                    )}
                  />
                )}
              </div>
            </ScrollArea>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogAction onClick={onClose}>Close</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ResultSection({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="font-medium text-foreground mb-1">{title}</div>
      <ul className="space-y-0.5 text-muted-foreground">
        {items.map((it, i) => (
          <li key={i} className="truncate" title={it}>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}
