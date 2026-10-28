// The only surface the preload exposes to the renderer. No credentials, tokens or raw
// filesystem access ever cross this boundary.

export type BuildChannel = 'development' | 'demo' | 'production';

export interface BuildInfo {
  version: string;
  commit: string;
  dirty: boolean;
  builtAt: string;
  channel: BuildChannel;
  platform: 'darwin' | 'win32' | 'linux' | 'web';
}

export type FolderPick =
  | { canceled: true }
  | { canceled: false; name: string; folderHint: string };

export interface DesktopBridge {
  getBuildInfo(): Promise<BuildInfo>;
  pickProjectFolder(): Promise<FolderPick>;
}

export const IPC = {
  buildInfo: 'multai:build-info',
  pickFolder: 'multai:pick-folder',
} as const;
