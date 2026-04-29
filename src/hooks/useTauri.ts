import { invoke } from "@tauri-apps/api/core";

export interface SearchResult {
  path: string;
  filename: string;
  parent_folder: string;
  score: number;
  extension: string;
  size_bytes: number;
  duration_seconds: number;
}

export interface PlaylistCopyOptions {
  rename: boolean;
  baseName: string;
  pad: number;
  start: number;
}

export interface Playlist {
  id: string;
  name: string;
  items: string[];
  last_copy_dest?: string | null;
  copy_options?: PlaylistCopyOptions | null;
}

export interface RenameOptions {
  baseName: string;
  pad: number;
  start: number;
}

export interface PreflightCopyResult {
  requiredBytes: number;
  availableBytes: number;
  sourcePaths: string[];
}

export interface CopyRenamedEntry {
  from: string;
  to: string;
}

export interface CopyErrorEntry {
  path: string;
  message: string;
}

export interface CopyResult {
  copied: number;
  canceled: boolean;
  skipped: string[];
  renamed: CopyRenamedEntry[];
  missing: string[];
  errors: CopyErrorEntry[];
}

export interface Stats {
  total_files: number;
  total_folders: number;
}

export interface AudioMetadata {
  path: string;
  filename: string;
  size_bytes: number;
  extension: string;
  parent_folder: string;
}

export async function addFolder(path: string): Promise<string[]> {
  return invoke("add_folder", { path });
}

export async function removeFolder(path: string): Promise<string[]> {
  return invoke("remove_folder", { path });
}

export async function getFolders(): Promise<string[]> {
  return invoke("get_folders");
}

export async function scanFolders(): Promise<number> {
  return invoke("scan_folders");
}

export async function search(query: string, limit?: number): Promise<SearchResult[]> {
  return invoke("search", { query, limit });
}

export async function getStats(): Promise<Stats> {
  return invoke("get_stats");
}

export async function revealInExplorer(path: string): Promise<void> {
  return invoke("reveal_in_explorer", { path });
}

export async function getPlaylists(): Promise<Playlist[]> {
  return invoke("get_playlists");
}

export async function createPlaylist(name: string): Promise<Playlist[]> {
  return invoke("create_playlist", { name });
}

export async function deletePlaylist(id: string): Promise<Playlist[]> {
  return invoke("delete_playlist", { id });
}

export async function renamePlaylist(id: string, name: string): Promise<Playlist[]> {
  return invoke("rename_playlist", { id, name });
}

export async function addToPlaylist(playlistId: string, filePath: string): Promise<void> {
  return invoke("add_to_playlist", { playlistId, filePath });
}

export async function removeFromPlaylist(playlistId: string, filePath: string): Promise<void> {
  return invoke("remove_from_playlist", { playlistId, filePath });
}

export async function getPlaylistItems(playlistId: string): Promise<string[]> {
  return invoke("get_playlist_items", { playlistId });
}

export async function reorderPlaylist(playlistId: string, items: string[]): Promise<void> {
  return invoke("reorder_playlist", { playlistId, items });
}

export async function reorderPlaylists(ids: string[]): Promise<Playlist[]> {
  return invoke("reorder_playlists", { ids });
}

export async function startEmbedding(): Promise<void> {
  return invoke("start_embedding");
}

export async function refreshEmbeddings(): Promise<void> {
  return invoke("refresh_embeddings");
}

export async function getAudioMetadata(path: string): Promise<AudioMetadata> {
  return invoke("get_audio_metadata", { path });
}

export async function preflightCopy(
  playlistId: string,
  dest: string
): Promise<PreflightCopyResult> {
  return invoke("preflight_copy", { playlistId, dest });
}

export async function startCopy(
  playlistId: string,
  dest: string,
  copyId?: string,
  rename?: RenameOptions | null
): Promise<{ copyId: string }> {
  return invoke("start_copy", { playlistId, dest, copyId, rename });
}

export async function cancelCopy(copyId: string): Promise<void> {
  return invoke("cancel_copy", { copyId });
}

export async function setPlaylistLastCopyDest(
  playlistId: string,
  path: string
): Promise<void> {
  return invoke("set_playlist_last_copy_dest", { playlistId, path });
}

export async function setPlaylistCopyOptions(
  playlistId: string,
  options: PlaylistCopyOptions | null
): Promise<void> {
  return invoke("set_playlist_copy_options", { playlistId, options });
}

export async function getPlaylistCopyOptions(
  playlistId: string
): Promise<PlaylistCopyOptions | null> {
  return invoke("get_playlist_copy_options", { playlistId });
}

