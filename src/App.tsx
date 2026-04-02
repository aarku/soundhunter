import { useState, useEffect, useCallback, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
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
  Trash2,
  ChevronRight,
  ChevronDown,
  Music,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Waveform } from "@/components/Waveform";
import { useAudioPreview } from "@/hooks/useAudioPreview";
import * as api from "@/hooks/useTauri";
import type { SearchResult, Playlist } from "@/hooks/useTauri";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
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
  const [activePlaylist, setActivePlaylist] = useState<string | null>(null);
  const [playlistItems, setPlaylistItems] = useState<string[]>([]);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    filePath: string;
  } | null>(null);

  const { play, stop, currentlyPlaying } = useAudioPreview();
  const searchTimeoutRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Load initial data
  useEffect(() => {
    api.getFolders().then(setFolders).catch(console.error);
    api.getStats().then(setStats).catch(console.error);
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
      // Auto-scan after adding
      setIsScanning(true);
      try {
        const count = await api.scanFolders();
        const s = await api.getStats();
        setStats(s);
      } finally {
        setIsScanning(false);
      }
    }
  }, []);

  const handleRemoveFolder = useCallback(async (path: string) => {
    const newFolders = await api.removeFolder(path);
    setFolders(newFolders);
    const s = await api.getStats();
    setStats(s);
  }, []);

  const handleRescan = useCallback(async () => {
    setIsScanning(true);
    try {
      await api.scanFolders();
      const s = await api.getStats();
      setStats(s);
    } finally {
      setIsScanning(false);
    }
  }, []);

  const handleReveal = useCallback((path: string) => {
    api.revealInExplorer(path).catch(console.error);
  }, []);

  const handleCreatePlaylist = useCallback(async () => {
    if (!newPlaylistName.trim()) return;
    const pls = await api.createPlaylist(newPlaylistName.trim());
    setPlaylists(pls);
    setNewPlaylistName("");
  }, [newPlaylistName]);

  const handleDeletePlaylist = useCallback(async (id: string) => {
    const pls = await api.deletePlaylist(id);
    setPlaylists(pls);
    if (activePlaylist === id) {
      setActivePlaylist(null);
      setPlaylistItems([]);
    }
  }, [activePlaylist]);

  const handleSelectPlaylist = useCallback(async (id: string) => {
    if (activePlaylist === id) {
      setActivePlaylist(null);
      setPlaylistItems([]);
    } else {
      setActivePlaylist(id);
      const items = await api.getPlaylistItems(id);
      setPlaylistItems(items);
    }
  }, [activePlaylist]);

  const handleAddToPlaylist = useCallback(async (playlistId: string, filePath: string) => {
    await api.addToPlaylist(playlistId, filePath);
    if (activePlaylist === playlistId) {
      const items = await api.getPlaylistItems(playlistId);
      setPlaylistItems(items);
    }
    setContextMenu(null);
  }, [activePlaylist]);

  const handleRemoveFromPlaylist = useCallback(async (filePath: string) => {
    if (!activePlaylist) return;
    await api.removeFromPlaylist(activePlaylist, filePath);
    const items = await api.getPlaylistItems(activePlaylist);
    setPlaylistItems(items);
  }, [activePlaylist]);

  const handleContextMenu = useCallback((e: React.MouseEvent, filePath: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, filePath });
  }, []);

  // Close context menu on click elsewhere
  useEffect(() => {
    const handler = () => setContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, []);

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
    <div className="flex h-screen bg-background text-foreground overflow-hidden select-none">
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
                >
                  {isScanning ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  ) : (
                    <FolderSearch className="w-3 h-3 mr-1" />
                  )}
                  {isScanning ? "Scanning..." : "Rescan All"}
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
            </div>
          )}

          {sidebarView === "playlists" && (
            <div className="p-3 space-y-2">
              <div className="flex gap-1">
                <Input
                  placeholder="New list name..."
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
                {playlists.map((pl) => (
                  <div key={pl.id}>
                    <div
                      className={`flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer group ${
                        activePlaylist === pl.id
                          ? "bg-primary/20 text-primary"
                          : "hover:bg-accent"
                      }`}
                      onClick={() => handleSelectPlaylist(pl.id)}
                    >
                      {activePlaylist === pl.id ? (
                        <ChevronDown className="w-3 h-3 shrink-0" />
                      ) : (
                        <ChevronRight className="w-3 h-3 shrink-0" />
                      )}
                      <Music className="w-3 h-3 shrink-0" />
                      <span className="truncate flex-1">{pl.name}</span>
                      <span className="text-muted-foreground">{pl.items.length}</span>
                      <button
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeletePlaylist(pl.id);
                        }}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>

                    {activePlaylist === pl.id && playlistItems.length > 0 && (
                      <div className="ml-4 space-y-0.5 mt-1">
                        {playlistItems.map((item) => {
                          const name = item.split(/[/\\]/).pop() || item;
                          return (
                            <div
                              key={item}
                              className="flex items-center gap-1 px-2 py-0.5 rounded text-xs hover:bg-accent group/item cursor-pointer"
                              onMouseEnter={() => play(item)}
                              onMouseLeave={() => stop()}
                            >
                              <Volume2
                                className={`w-3 h-3 shrink-0 ${
                                  currentlyPlaying === item
                                    ? "text-primary"
                                    : "text-muted-foreground"
                                }`}
                              />
                              <span className="truncate flex-1" title={item}>
                                {name}
                              </span>
                              <button
                                className="opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-destructive"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRemoveFromPlaylist(item);
                                }}
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
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
      <div className="flex-1 flex flex-col">
        {/* Search bar */}
        <div className="p-3 border-b border-border flex items-center gap-2">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <Input
            ref={searchInputRef}
            placeholder="Search sounds... (semantic + fuzzy)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="border-0 shadow-none focus-visible:ring-0 h-8 text-sm"
          />
          {isSearching && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
          {query && (
            <button onClick={() => setQuery("")} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          )}
          {results.length > 0 && (
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {results.length} results
            </span>
          )}
        </div>

        {/* Results */}
        <ScrollArea className="flex-1">
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
            {results.map((result) => (
              <div
                key={result.path}
                className={`px-4 py-2 flex items-center gap-3 hover:bg-accent/50 cursor-pointer transition-colors group ${
                  currentlyPlaying === result.path ? "bg-primary/10" : ""
                }`}
                onMouseEnter={() => play(result.path)}
                onMouseLeave={() => stop()}
                onContextMenu={(e) => handleContextMenu(e, result.path)}
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
                  width={80}
                  height={24}
                  isPlaying={currentlyPlaying === result.path}
                  className="shrink-0 hidden sm:block"
                />

                {/* Meta */}
                <div className="text-xs text-muted-foreground shrink-0 w-14 text-right">
                  {formatBytes(result.size_bytes)}
                </div>
                <div className="text-xs text-muted-foreground shrink-0 w-8 text-right">
                  .{result.extension}
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
                    <button
                      className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleContextMenu(e, result.path);
                      }}
                      title="Add to list"
                    >
                      <ListPlus className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Context menu */}
      {contextMenu && playlists.length > 0 && (
        <div
          className="fixed bg-popover border border-border rounded-md shadow-lg py-1 z-50 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-xs text-muted-foreground font-medium">
            Add to list
          </div>
          {playlists.map((pl) => (
            <button
              key={pl.id}
              className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent flex items-center gap-2"
              onClick={() => handleAddToPlaylist(pl.id, contextMenu.filePath)}
            >
              <Music className="w-3 h-3" />
              {pl.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
