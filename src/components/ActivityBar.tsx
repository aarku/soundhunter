import { Loader2, X } from "lucide-react";
import { useActivities, useActivity, type Activity } from "@/hooks/useActivity";
import { useConfirm } from "@/hooks/useConfirm";

export function ActivityBar() {
  const activities = useActivities();

  if (activities.length === 0) return null;

  return (
    <div className="border-t border-border bg-card/80 backdrop-blur-sm px-3 py-1.5">
      <div className="flex flex-wrap gap-2">
        {activities.map((a) => (
          <ActivityPill key={a.id} activity={a} />
        ))}
      </div>
    </div>
  );
}

function ActivityPill({ activity }: { activity: Activity }) {
  const confirm = useConfirm();
  const { end } = useActivity();

  const handleCancel = async () => {
    if (!activity.onCancel) return;
    const opts = activity.cancelConfirm ?? {
      title: "Cancel this operation?",
      confirmLabel: "Cancel",
    };
    const ok = await confirm({
      title: opts.title,
      description: opts.description,
      confirmLabel: opts.confirmLabel ?? "Cancel",
      cancelLabel: "Keep running",
      destructive: true,
    });
    if (!ok) return;
    activity.onCancel();
    end(activity.id);
  };

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-secondary text-xs text-foreground">
      <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0" />
      <span className="truncate max-w-80" title={activity.label}>
        {activity.label}
      </span>
      {typeof activity.progress === "number" && (
        <div className="w-16 h-1 rounded bg-background overflow-hidden shrink-0">
          <div
            className="h-full bg-primary transition-all"
            style={{
              width: `${Math.max(0, Math.min(1, activity.progress)) * 100}%`,
            }}
          />
        </div>
      )}
      {activity.onCancel && (
        <button
          className="text-muted-foreground hover:text-destructive shrink-0"
          onClick={handleCancel}
          title="Cancel"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
