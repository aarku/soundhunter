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

export interface Playlist {
  id: string;
  name: string;
  items: string[];
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

export async function startEmbedding(): Promise<void> {
  return invoke("start_embedding");
}

export async function refreshEmbeddings(): Promise<void> {
  return invoke("refresh_embeddings");
}

export async function getAudioMetadata(path: string): Promise<AudioMetadata> {
  return invoke("get_audio_metadata", { path });
}

