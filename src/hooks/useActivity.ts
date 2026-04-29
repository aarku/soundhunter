import { create } from "zustand";

export type Activity = {
  id: string;
  label: string;
  progress?: number;
  onCancel?: () => void;
  cancelConfirm?: {
    title: string;
    description?: string;
    confirmLabel?: string;
  };
};

export type StartActivityOptions = Omit<Activity, "id"> & { id?: string };
export type UpdateActivityOptions = Partial<Omit<Activity, "id">>;

type Store = {
  activities: Activity[];
  start: (opts: StartActivityOptions) => string;
  update: (id: string, patch: UpdateActivityOptions) => void;
  end: (id: string) => void;
};

let nextAutoId = 1;

const useStore = create<Store>((set) => ({
  activities: [],
  start: (opts) => {
    const id = opts.id ?? `activity-${nextAutoId++}`;
    set((state) => {
      const activity: Activity = { ...opts, id };
      const existing = state.activities.findIndex((a) => a.id === id);
      if (existing >= 0) {
        const next = state.activities.slice();
        next[existing] = activity;
        return { activities: next };
      }
      return { activities: [...state.activities, activity] };
    });
    return id;
  },
  update: (id, patch) =>
    set((state) => {
      const idx = state.activities.findIndex((a) => a.id === id);
      if (idx < 0) return state;
      const next = state.activities.slice();
      next[idx] = { ...next[idx], ...patch };
      return { activities: next };
    }),
  end: (id) =>
    set((state) => ({
      activities: state.activities.filter((a) => a.id !== id),
    })),
}));

export function useActivity() {
  const start = useStore((s) => s.start);
  const update = useStore((s) => s.update);
  const end = useStore((s) => s.end);
  return { start, update, end };
}

export function useActivities(): Activity[] {
  return useStore((s) => s.activities);
}
