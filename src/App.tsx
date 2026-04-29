import { useState, useEffect, useCallback, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  Search,
  FolderOpen,
  X,
  FolderSearch,
  Loader2,
  Volume2,
  VolumeX,
  ExternalLink,
  ListPlus,
  Plus,
  ChevronRight,
  ChevronDown,
  Music,
  Star,
  GripVertical,
  MoreVertical,
  Copy,
  Pencil,
  Trash2,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Waveform } from "@/components/Waveform";
import { ActivityBar } from "@/components/ActivityBar";
import { useActivity } from "@/hooks/useActivity";
import { useAudioPreview } from "@/hooks/useAudioPreview";
import * as api from "@/hooks/useTauri";
import type { SearchResult, Playlist, CopyResult } from "@/hooks/useTauri";
import { useConfirm } from "@/hooks/useConfirm";
import { CopyResultDialog, type CopyResultDialogPayload } from "@/components/CopyResultDialog";
import { CopyOptionsDialog, type CopyOptionsRequest } from "@/components/CopyOptionsDialog";

function SortablePlaylistItem({
  item,
  currentlyPlaying,
  play,
  stop,
  onRemove,
}: {
  item: string;
  currentlyPlaying: string | null;
  play: (path: string) => void;
  stop: () => void;
  onRemove: (path: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const name = item.split(/[/\\]/).pop() || item;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1 px-1 py-0.5 rounded text-xs hover:bg-accent group/item"
      onMouseEnter={() => play(item)}
      onMouseLeave={() => stop()}
    >
      <button
        className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground shrink-0 p-0.5"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="w-3 h-3" />
      </button>
      <Volume2
        className={`w-3 h-3 shrink-0 ${
          currentlyPlaying === item ? "text-primary" : "text-muted-foreground"
        }`}
      />
      <span className="truncate flex-1" title={item}>
        {name}
      </span>
      <button
        className="opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(item);
        }}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

function SortablePlaylistHeader({
  playlist,
  isActive,
  onSelect,
  onDelete,
  onRename,
  onCopyAll,
  children,
}: {
  playlist: { id: string; name: string; items: string[] };
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  onCopyAll: () => void;
  children?: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: `playlistsort:${playlist.id}` });
  const { setNodeRef: dropRef, isOver } = useDroppable({
    id: `playlist:${playlist.id}`,
    data: { type: "playlist", playlistId: playlist.id },
  });

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(playlist.name);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const handleSubmitRename = () => {
    if (editName.trim() && editName.trim() !== playlist.name) {
      onRename(editName.trim());
    }
    setIsEditing(false);
  };

  const startRename = () => {
    setEditName(playlist.name);
    setIsEditing(true);
  };

  return (
    <div ref={setNodeRef} style={style}>
      <div
        ref={dropRef}
        className={`flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer group ${
          isActive ? "bg-primary/20 text-primary" : "hover:bg-accent"
        } ${isOver ? "ring-1 ring-primary" : ""}`}
        onClick={onSelect}
      >
        <button
          className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground shrink-0 p-0.5"
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="w-3 h-3" />
        </button>
        {isActive ? (
          <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0" />
        )}
        <Music className="w-3 h-3 shrink-0" />
        {isEditing ? (
          <input
            className="flex-1 bg-transparent border-b border-primary outline-none text-xs min-w-0"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleSubmitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmitRename();
              if (e.key === "Escape") setIsEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span
            className="truncate flex-1"
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename();
            }}
          >
            {playlist.name}
          </span>
        )}
        <span className="text-muted-foreground">{playlist.items.length}</span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground data-[state=open]:opacity-100"
              onClick={(e) => e.stopPropagation()}
              title="More actions"
            >
              <MoreVertical className="w-3 h-3" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="bg-popover border border-border rounded-md shadow-lg py-1 z-50 min-w-48"
              sideOffset={4}
              align="end"
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenu.Item
                className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent flex items-center gap-2 cursor-pointer outline-none data-highlighted:bg-accent"
                onSelect={onCopyAll}
              >
                <Copy className="w-3 h-3" />
                Copy all sounds to…
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent flex items-center gap-2 cursor-pointer outline-none data-highlighted:bg-accent"
                onSelect={startRename}
              >
                <Pencil className="w-3 h-3" />
                Rename
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent flex items-center gap-2 cursor-pointer outline-none text-destructive data-highlighted:bg-accent"
                onSelect={onDelete}
              >
                <Trash2 className="w-3 h-3" />
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {children}
    </div>
  );
}

function DraggableResultRow({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `search:${id}`,
    data: { type: "search-result", path: id },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="overflow-hidden"
      style={{ opacity: isDragging ? 0.4 : 1 }}
    >
      {children}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type SidebarView = "search" | "folders" | "playlists";

function App() {
  const [folders, setFolders] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [stats, setStats] = useState<api.Stats>({ total_files: 0, total_folders: 0 });
  const [isScanning, setIsScanning] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>("search");
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [openPlaylists, setOpenPlaylists] = useState<Set<string>>(new Set());
  const [playlistItemsMap, setPlaylistItemsMap] = useState<Map<string, string[]>>(new Map());
  const [newPlaylistName, setNewPlaylistName] = useState("");

  const { play, stop, seek, currentlyPlaying, progress } = useAudioPreview();
  const confirm = useConfirm();
  const activity = useActivity();
  const searchTimeoutRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [draggedItem, setDraggedItem] = useState<string | null>(null);
  const [hiddenPaths, setHiddenPaths] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);

  const [embeddingProgress, setEmbeddingProgress] = useState<string | null>(null);
  const [copyResultPayload, setCopyResultPayload] = useState<CopyResultDialogPayload | null>(null);
  const [copyOptionsRequest, setCopyOptionsRequest] = useState<CopyOptionsRequest | null>(null);
  // Per-copy totals so we can show "X of N" on completion — the event payload
  // carries only the result, not the original total.
  const copyTotalsRef = useRef<Map<string, { total: number; destLabel: string }>>(new Map());

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  const startEmbedding = useCallback(async () => {
    api.startEmbedding().catch(console.error);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDraggedItem(event.active.id as string);
  }, []);

  // Keep a ref so the event handler always sees the latest showToast without
  // re-subscribing (re-subscribing on every render causes duplicate listeners
  // under StrictMode, which makes the progress counter jitter).
  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; }, [showToast]);

  // Listen for embedding progress events from background thread. Subscribe once.
  const activityRef = useRef(activity);
  useEffect(() => { activityRef.current = activity; }, [activity]);

  useEffect(() => {
    let cancelled = false;
    let off1: (() => void) | undefined;
    let off2: (() => void) | undefined;
    const ACTIVITY_ID = "embedding";

    listen<{ done: number; total: number }>("embedding-progress", (event) => {
      const { done, total } = event.payload;
      const label = `Analyzing audio ${done}/${total}…`;
      setEmbeddingProgress(label);
      activityRef.current.start({
        id: ACTIVITY_ID,
        label,
        progress: total > 0 ? done / total : undefined,
      });
    }).then((f) => {
      if (cancelled) f(); else off1 = f;
    });

    listen<{ total: number }>("embedding-complete", (event) => {
      setEmbeddingProgress(null);
      activityRef.current.end(ACTIVITY_ID);
      if (event.payload.total > 0) {
        showToastRef.current(`Analyzed ${event.payload.total} audio files for semantic search`);
      }
    }).then((f) => {
      if (cancelled) f(); else off2 = f;
    });

    return () => {
      cancelled = true;
      off1?.();
      off2?.();
    };
  }, []);

  // Listen for copy progress/complete events. Must live at App level so the
  // copy keeps updating its activity pill even if the playlists tab is closed
  // or the originating header component unmounts.
  useEffect(() => {
    let cancelled = false;
    let offProgress: (() => void) | undefined;
    let offComplete: (() => void) | undefined;

    listen<{ copyId: string; done: number; total: number; currentFile: string }>(
      "copy-progress",
      (event) => {
        const { copyId, done, total } = event.payload;
        const activityId = `copy-${copyId}`;
        activityRef.current.update(activityId, {
          label: `Copying ${done}/${total} sounds…`,
          progress: total > 0 ? done / total : undefined,
        });
      }
    ).then((f) => {
      if (cancelled) f(); else offProgress = f;
    });

    listen<{ copyId: string; result: CopyResult }>("copy-complete", (event) => {
      const { copyId, result } = event.payload;
      const activityId = `copy-${copyId}`;
      activityRef.current.end(activityId);

      const meta = copyTotalsRef.current.get(copyId);
      copyTotalsRef.current.delete(copyId);
      const total = meta?.total ?? result.copied;
      const destLabel = meta?.destLabel ?? "";

      if (result.canceled) {
        showToastRef.current(
          `Copy canceled. ${result.copied} of ${total} sound${total === 1 ? "" : "s"} copied.`
        );
        return;
      }

      const clean =
        result.skipped.length === 0 &&
        result.renamed.length === 0 &&
        result.missing.length === 0 &&
        result.errors.length === 0;

      if (clean) {
        showToastRef.current(
          `Copied ${result.copied} sound${result.copied === 1 ? "" : "s"}${destLabel ? ` to ${destLabel}` : ""}.`
        );
        return;
      }

      setCopyResultPayload({ result, total, destLabel });
    }).then((f) => {
      if (cancelled) f(); else offComplete = f;
    });

    return () => {
      cancelled = true;
      offProgress?.();
      offComplete?.();
    };
  }, []);

  // Load initial data + resume background embedding if needed
  useEffect(() => {
    api.getFolders().then(setFolders).catch(console.error);
    api.getStats().then((s) => {
      setStats(s);
      if (s.total_files > 0) startEmbedding();
    }).catch(console.error);
    api.getPlaylists().then(setPlaylists).catch(console.error);
  }, []);

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    if (!query.trim()) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    searchTimeoutRef.current = window.setTimeout(async () => {
      try {
        const r = await api.search(query, 200);
        setResults(r);
      } catch (e) {
        console.error("Search error:", e);
      } finally {
        setIsSearching(false);
      }
    }, 200);

    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [query]);

  const handleAddFolder = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      const newFolders = await api.addFolder(selected as string);
      setFolders(newFolders);
      setIsScanning(true);
      activity.start({ id: "scan", label: "Scanning folders…" });
      try {
        await api.scanFolders();
        const s = await api.getStats();
        setStats(s);
      } finally {
        setIsScanning(false);
        activity.end("scan");
      }
      // Start CLAP embedding in background
      startEmbedding();
    }
  }, [activity]);

  const handleRemoveFolder = useCallback(async (path: string) => {
    const name = path.split(/[/\\]/).pop() || path;
    const ok = await confirm({
      title: `Remove "${name}" from index?`,
      description:
        "Indexed files from this folder will no longer appear in search. The files on disk are not touched.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    const newFolders = await api.removeFolder(path);
    setFolders(newFolders);
    const s = await api.getStats();
    setStats(s);
  }, [confirm]);

  const handleRescan = useCallback(async () => {
    setIsScanning(true);
    activity.start({ id: "scan", label: "Scanning folders…" });
    try {
      await api.scanFolders();
      const s = await api.getStats();
      setStats(s);
    } finally {
      setIsScanning(false);
      activity.end("scan");
    }
    startEmbedding();
  }, [startEmbedding, activity]);

  const handleReveal = useCallback((path: string) => {
    api.revealInExplorer(path).catch(console.error);
  }, []);

  const handleCreatePlaylist = useCallback(async () => {
    if (!newPlaylistName.trim()) return;
    const pls = await api.createPlaylist(newPlaylistName.trim());
    setPlaylists(pls);
    setNewPlaylistName("");
  }, [newPlaylistName]);

  const refreshPlaylistItems = useCallback(async (id: string) => {
    const items = await api.getPlaylistItems(id);
    setPlaylistItemsMap((prev) => new Map(prev).set(id, items));
  }, []);

  const handleDeletePlaylist = useCallback(async (id: string) => {
    const pl = playlists.find((p) => p.id === id);
    const name = pl?.name ?? "this list";
    const count = pl?.items.length ?? 0;
    const ok = await confirm({
      title: `Delete "${name}"?`,
      description:
        count > 0
          ? `This will permanently delete the list and its ${count} item${count === 1 ? "" : "s"}. This cannot be undone.`
          : "This will permanently delete the list. This cannot be undone.",
      confirmLabel: "Delete list",
      destructive: true,
    });
    if (!ok) return;
    const pls = await api.deletePlaylist(id);
    setPlaylists(pls);
    setOpenPlaylists((prev) => { const s = new Set(prev); s.delete(id); return s; });
    setPlaylistItemsMap((prev) => { const m = new Map(prev); m.delete(id); return m; });
  }, [playlists, confirm]);

  const handleSelectPlaylist = useCallback(async (id: string) => {
    setOpenPlaylists((prev) => {
      const s = new Set(prev);
      if (s.has(id)) { s.delete(id); } else { s.add(id); }
      return s;
    });
    if (!playlistItemsMap.has(id)) {
      refreshPlaylistItems(id);
    }
  }, [playlistItemsMap, refreshPlaylistItems]);

  const handleAddToPlaylist = useCallback(async (playlistId: string, filePath: string) => {
    await api.addToPlaylist(playlistId, filePath);
    const pls = await api.getPlaylists();
    setPlaylists(pls);
    if (openPlaylists.has(playlistId)) {
      refreshPlaylistItems(playlistId);
    }
  }, [openPlaylists, refreshPlaylistItems]);

  const handleRemoveFromPlaylist = useCallback(async (playlistId: string, filePath: string) => {
    const name = filePath.split(/[/\\]/).pop() || filePath;
    const ok = await confirm({
      title: "Remove from list?",
      description: `"${name}" will be removed from this list. The file on disk is not touched.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    await api.removeFromPlaylist(playlistId, filePath);
    const pls = await api.getPlaylists();
    setPlaylists(pls);
    refreshPlaylistItems(playlistId);
  }, [confirm, refreshPlaylistItems]);

  const handleRenamePlaylist = useCallback(async (id: string, name: string) => {
    const pls = await api.renamePlaylist(id, name);
    setPlaylists(pls);
  }, []);

  const handleReorderPlaylists = useCallback(async (ids: string[]) => {
    const pls = await api.reorderPlaylists(ids);
    setPlaylists(pls);
  }, []);

  const handleCopyAll = useCallback(async (playlistId: string) => {
    const pl = playlists.find((p) => p.id === playlistId);
    if (!pl) return;

    let items = playlistItemsMap.get(playlistId);
    if (!items) {
      items = await api.getPlaylistItems(playlistId);
      setPlaylistItemsMap((prev) => new Map(prev).set(playlistId, items!));
    }
    if (items.length === 0) {
      showToast("List is empty.");
      return;
    }

    const sampleFilenames = items.map((p) => p.split(/[/\\]/).pop() || p);
    setCopyOptionsRequest({
      playlistId,
      playlistName: pl.name,
      sampleFilenames,
      initial: pl.copy_options ?? null,
    });
  }, [playlists, playlistItemsMap, showToast]);

  const runCopyWithOptions = useCallback(async (
    playlistId: string,
    options: api.PlaylistCopyOptions,
  ) => {
    const pl = playlists.find((p) => p.id === playlistId);
    if (!pl) return;
    const items = playlistItemsMap.get(playlistId) ?? [];
    if (items.length === 0) {
      showToast("List is empty.");
      return;
    }

    // Persist the chosen options on the playlist for next time.
    try {
      await api.setPlaylistCopyOptions(playlistId, options);
      setPlaylists((prev) =>
        prev.map((p) => (p.id === playlistId ? { ...p, copy_options: options } : p))
      );
    } catch (e) {
      console.error("Failed to persist copy_options", e);
    }

    const defaultPath = pl.last_copy_dest ?? undefined;
    const selected = await open({ directory: true, defaultPath });
    if (!selected) return;
    const dest = selected as string;

    const destLower = dest.replace(/\\/g, "/").toLowerCase();
    const itemsInsideDest = items.some((p) => {
      const parent = p.replace(/\\/g, "/").split("/").slice(0, -1).join("/").toLowerCase();
      return parent === destLower;
    });
    if (itemsInsideDest) {
      const ok = await confirm({
        title: "Destination is inside your library",
        description:
          "The destination is inside your library. Copying here may add duplicate files to your index.",
        confirmLabel: "Copy anyway",
      });
      if (!ok) return;
    }

    let pre: api.PreflightCopyResult;
    try {
      pre = await api.preflightCopy(playlistId, dest);
    } catch (e) {
      await confirm({
        title: "Could not prepare copy",
        description: String(e),
        confirmLabel: "OK",
        cancelLabel: "OK",
      });
      return;
    }
    if (pre.availableBytes < pre.requiredBytes) {
      const needGB = (pre.requiredBytes / 1024 / 1024 / 1024).toFixed(2);
      const haveGB = (pre.availableBytes / 1024 / 1024 / 1024).toFixed(2);
      await confirm({
        title: "Not enough disk space",
        description: `Need ${needGB} GB, only ${haveGB} GB available. Choose a different folder or free up space.`,
        confirmLabel: "OK",
        cancelLabel: "OK",
      });
      return;
    }

    try {
      await api.setPlaylistLastCopyDest(playlistId, dest);
      setPlaylists((prev) =>
        prev.map((p) => (p.id === playlistId ? { ...p, last_copy_dest: dest } : p))
      );
    } catch (e) {
      console.error("Failed to persist last_copy_dest", e);
    }

    // Pre-allocate the copyId and create the activity row BEFORE invoking
    // start_copy, so progress events emitted by the Rust thread can never
    // arrive before the row exists. (useActivity.update is a no-op for
    // missing ids, so a race here would strand the pill at "0/N".)
    const copyId = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const total = items.length;
    const destName = dest.split(/[/\\]/).pop() || dest;
    copyTotalsRef.current.set(copyId, { total, destLabel: destName });

    activity.start({
      id: `copy-${copyId}`,
      label: `Copying 0/${total} sounds…`,
      progress: 0,
      onCancel: () => { api.cancelCopy(copyId).catch(console.error); },
      cancelConfirm: {
        title: "Cancel copy?",
        description: "Files already copied will remain at the destination.",
        confirmLabel: "Cancel copy",
      },
    });

    const renamePayload: api.RenameOptions | null = options.rename
      ? { baseName: options.baseName, pad: options.pad, start: options.start }
      : null;

    try {
      await api.startCopy(playlistId, dest, copyId, renamePayload);
    } catch (e) {
      activity.end(`copy-${copyId}`);
      copyTotalsRef.current.delete(copyId);
      await confirm({
        title: "Could not start copy",
        description: String(e),
        confirmLabel: "OK",
        cancelLabel: "OK",
      });
      return;
    }
  }, [playlists, playlistItemsMap, confirm, showToast, activity]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setDraggedItem(null);
      const { active, over } = event;
      if (!over) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      // Drag search result onto a playlist header
      if (activeId.startsWith("search:") && overId.startsWith("playlist:")) {
        const filePath = active.data.current?.path as string;
        const playlistId = over.data.current?.playlistId as string;
        if (filePath && playlistId) {
          handleAddToPlaylist(playlistId, filePath);
        }
        return;
      }

      // Reorder playlists themselves
      if (activeId.startsWith("playlistsort:") && overId.startsWith("playlistsort:")) {
        const fromId = activeId.replace("playlistsort:", "");
        const toId = overId.replace("playlistsort:", "");
        const oldIndex = playlists.findIndex((p) => p.id === fromId);
        const newIndex = playlists.findIndex((p) => p.id === toId);
        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          const newOrder = arrayMove(playlists, oldIndex, newIndex);
          setPlaylists(newOrder);
          handleReorderPlaylists(newOrder.map((p) => p.id));
        }
        return;
      }

      // Reorder items within a playlist
      for (const [plId, items] of playlistItemsMap) {
        if (items.includes(activeId) && items.includes(overId)) {
          const oldIndex = items.indexOf(activeId);
          const newIndex = items.indexOf(overId);
          if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
            const newItems = arrayMove(items, oldIndex, newIndex);
            setPlaylistItemsMap((prev) => new Map(prev).set(plId, newItems));
            await api.reorderPlaylist(plId, newItems);
          }
          return;
        }
      }
    },
    [playlists, playlistItemsMap, handleAddToPlaylist, handleReorderPlaylists]
  );

  // Keyboard shortcut: focus search with Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        setSidebarView("search");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden select-none">
      <div className="flex flex-1 min-h-0">
      {/* Sidebar */}
      <div className="w-64 border-r border-border flex flex-col bg-card">
        {/* Sidebar tabs */}
        <div className="flex border-b border-border">
          <button
            className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
              sidebarView === "search"
                ? "text-primary border-b-2 border-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setSidebarView("search")}
          >
            <Search className="w-3 h-3 inline mr-1" />
            Search
          </button>
          <button
            className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
              sidebarView === "folders"
                ? "text-primary border-b-2 border-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setSidebarView("folders")}
          >
            <FolderOpen className="w-3 h-3 inline mr-1" />
            Folders
          </button>
          <button
            className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
              sidebarView === "playlists"
                ? "text-primary border-b-2 border-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setSidebarView("playlists")}
          >
            <Star className="w-3 h-3 inline mr-1" />
            Lists
          </button>
        </div>

        {/* Sidebar content */}
        <ScrollArea className="flex-1">
          {sidebarView === "folders" && (
            <div className="p-3 space-y-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={handleAddFolder}
                data-testid="add-folder"
              >
                <Plus className="w-3 h-3 mr-1" />
                Add Folder
              </Button>

              {folders.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={handleRescan}
                  disabled={isScanning}
                  data-testid="rescan"
                >
                  {isScanning ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  ) : (
                    <FolderSearch className="w-3 h-3 mr-1" />
                  )}
                  {isScanning ? "Scanning…" : "Rescan All"}
                </Button>
              )}

              <div className="space-y-1">
                {folders.map((folder) => {
                  const name = folder.split(/[/\\]/).pop() || folder;
                  return (
                    <div
                      key={folder}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-accent group"
                    >
                      <FolderOpen className="w-3 h-3 text-muted-foreground shrink-0" />
                      <span className="truncate flex-1" title={folder}>
                        {name}
                      </span>
                      <button
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemoveFolder(folder)}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="text-xs text-muted-foreground pt-2 border-t border-border">
                {stats.total_files} files in {stats.total_folders} folders
              </div>
              {embeddingProgress && (
                <div
                  className="text-xs text-primary flex items-center gap-1"
                  data-testid="embedding-progress"
                >
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {embeddingProgress}
                </div>
              )}
            </div>
          )}

          {sidebarView === "playlists" && (
            <div className="p-3 space-y-2">
              <div className="flex gap-1">
                <Input
                  placeholder="New list name…"
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreatePlaylist()}
                  className="h-7 text-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  onClick={handleCreatePlaylist}
                >
                  <Plus className="w-3 h-3" />
                </Button>
              </div>

              <div className="space-y-1">
                <SortableContext
                  items={playlists.map((p) => `playlistsort:${p.id}`)}
                  strategy={verticalListSortingStrategy}
                >
                  {playlists.map((pl) => {
                    const isOpen = openPlaylists.has(pl.id);
                    const items = playlistItemsMap.get(pl.id) || [];
                    return (
                      <SortablePlaylistHeader
                        key={pl.id}
                        playlist={pl}
                        isActive={isOpen}
                        onSelect={() => handleSelectPlaylist(pl.id)}
                        onDelete={() => handleDeletePlaylist(pl.id)}
                        onRename={(name) => handleRenamePlaylist(pl.id, name)}
                        onCopyAll={() => handleCopyAll(pl.id)}
                      >
                        {isOpen && items.length > 0 && (
                          <div className="ml-5 space-y-0.5 mt-1">
                            <SortableContext
                              items={items}
                              strategy={verticalListSortingStrategy}
                            >
                              {items.map((item) => (
                                <SortablePlaylistItem
                                  key={item}
                                  item={item}
                                  currentlyPlaying={currentlyPlaying}
                                  play={play}
                                  stop={stop}
                                  onRemove={(path) => handleRemoveFromPlaylist(pl.id, path)}
                                />
                              ))}
                            </SortableContext>
                          </div>
                        )}
                      </SortablePlaylistHeader>
                    );
                  })}
                </SortableContext>
              </div>
            </div>
          )}

          {sidebarView === "search" && (
            <div className="p-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                Semantic + keyword search with fuzzy matching. Try searching for
                concepts like "ocean", "explosion", "ambient".
              </p>
              <div className="text-xs text-muted-foreground">
                <kbd className="px-1 py-0.5 bg-secondary rounded text-[10px]">Ctrl+K</kbd> to focus search
              </div>
              {stats.total_files > 0 && (
                <div className="text-xs text-muted-foreground">
                  {stats.total_files} sounds indexed
                </div>
              )}
              {folders.length === 0 && (
                <div className="space-y-2 pt-2">
                  <p className="text-xs text-muted-foreground">
                    Add a folder to get started.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={handleAddFolder}
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    Add Folder
                  </Button>
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Search bar */}
        <div className="p-3 border-b border-border flex items-center gap-2">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <Input
            ref={searchInputRef}
            placeholder="Search sounds… (semantic + fuzzy)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="search-input"
            className="border-0 shadow-none focus-visible:ring-0 h-8 text-sm"
          />
          {isSearching && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
          {query && (
            <button onClick={() => { setQuery(""); setHiddenPaths(new Set()); }} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          )}
          {results.length > 0 && (
            <span className="text-xs text-muted-foreground whitespace-nowrap flex items-center gap-1.5">
              {results.filter((r) => !hiddenPaths.has(r.path)).length} results
              <button
                className="text-primary hover:text-primary/80"
                title="Save results as a new list"
                onClick={async () => {
                  const visible = results.filter((r) => !hiddenPaths.has(r.path));
                  if (visible.length === 0) return;
                  const name = query.trim() || "Untitled";
                  const pls = await api.createPlaylist(name);
                  setPlaylists(pls);
                  const newPl = pls[pls.length - 1];
                  for (const r of visible) {
                    await api.addToPlaylist(newPl.id, r.path);
                  }
                  showToast(`Created list "${name}" with ${visible.length} sounds`);
                }}
              >
                <ListPlus className="w-3.5 h-3.5" />
              </button>
            </span>
          )}
        </div>

        {/* Results */}
        <ScrollArea className="flex-1 overflow-x-hidden">
          {results.length === 0 && query && !isSearching && (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              No results found
            </div>
          )}

          {results.length === 0 && !query && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
              <Search className="w-12 h-12 opacity-20" />
              <p className="text-sm">Start typing to search</p>
            </div>
          )}

          <div className="divide-y divide-border">
            {results.filter((r) => !hiddenPaths.has(r.path)).map((result) => (
              <DraggableResultRow key={result.path} id={result.path}>
              <div
                className={`px-4 py-2 flex items-center gap-3 hover:bg-accent/50 cursor-pointer transition-colors group w-full ${
                  currentlyPlaying === result.path ? "bg-primary/10" : ""
                }`}
                onMouseLeave={() => stop()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const name = result.filename;
                  setHiddenPaths((prev) => new Set(prev).add(result.path));
                  showToast(`Hidden "${name}" from results`);
                }}
              >
                {/* Play indicator */}
                <div className="w-4 shrink-0">
                  {currentlyPlaying === result.path ? (
                    <Volume2 className="w-4 h-4 text-primary animate-pulse" />
                  ) : (
                    <VolumeX className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100" />
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0 overflow-hidden">
                  <div className="text-sm font-medium truncate">{result.filename}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {result.parent_folder}
                  </div>
                </div>

                {/* Waveform */}
                <Waveform
                  filePath={result.path}
                  width={240}
                  height={24}
                  isPlaying={currentlyPlaying === result.path}
                  progress={currentlyPlaying === result.path ? progress : 0}
                  onSeek={currentlyPlaying === result.path ? seek : undefined}
                  onMouseEnter={() => play(result.path)}
                  className="shrink-0 hidden sm:block"
                />

                {/* Meta */}
                <div className="text-xs text-muted-foreground shrink-0 w-14 text-right">
                  {formatBytes(result.size_bytes)}
                </div>
                <div className="text-xs text-muted-foreground shrink-0 w-10 text-right tabular-nums">
                  {formatDuration(result.duration_seconds)}
                </div>

                {/* Actions - always visible */}
                <div className="flex gap-1 shrink-0">
                  <button
                    className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReveal(result.path);
                    }}
                    title="Reveal in Explorer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                  {playlists.length > 0 && (
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                          title="Add to list"
                        >
                          <ListPlus className="w-3.5 h-3.5" />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          className="bg-popover border border-border rounded-md shadow-lg py-1 z-50 min-w-40"
                          sideOffset={4}
                          align="end"
                        >
                          <div className="px-3 py-1 text-xs text-muted-foreground font-medium">
                            Add to list
                          </div>
                          {playlists.map((pl) => (
                            <DropdownMenu.Item
                              key={pl.id}
                              className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent flex items-center gap-2 cursor-pointer outline-none data-highlighted:bg-accent"
                              onSelect={() => handleAddToPlaylist(pl.id, result.path)}
                            >
                              <Music className="w-3 h-3" />
                              {pl.name}
                            </DropdownMenu.Item>
                          ))}
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  )}
                </div>
              </div>
              </DraggableResultRow>
            ))}
            {hiddenPaths.size > 0 && (
              <div className="px-4 py-3 text-xs text-muted-foreground text-center">
                …and {hiddenPaths.size} result{hiddenPaths.size > 1 ? "s" : ""} temporarily hidden.{" "}
                <button
                  className="text-primary hover:underline"
                  onClick={() => setHiddenPaths(new Set())}
                >
                  Click to show.
                </button>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
      </div>

      <ActivityBar />
    </div>

    {/* Toast */}
    {toast && (
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-card border border-border rounded-md shadow-lg text-sm text-foreground animate-in fade-in slide-in-from-bottom-2 duration-200">
        {toast}
      </div>
    )}

    <CopyResultDialog
      payload={copyResultPayload}
      onClose={() => setCopyResultPayload(null)}
    />

    <CopyOptionsDialog
      request={copyOptionsRequest}
      onCancel={() => setCopyOptionsRequest(null)}
      onConfirm={(options) => {
        const req = copyOptionsRequest;
        setCopyOptionsRequest(null);
        if (req) runCopyWithOptions(req.playlistId, options);
      }}
    />

    <DragOverlay>
      {draggedItem && (
        <div className="px-3 py-1.5 rounded bg-accent text-sm font-medium shadow-lg border border-border max-w-64 truncate">
          {draggedItem.replace(/^search:/, "").split(/[/\\]/).pop()}
        </div>
      )}
    </DragOverlay>
    </DndContext>
  );
}

export default App;
