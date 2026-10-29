import type { BuildInfo, DesktopBridge } from './contract';

declare global {
  interface Window {
    multai?: DesktopBridge;
  }
}

/** The preload bridge, or null when the renderer runs in a plain browser preview. */
export function getBridge(): DesktopBridge | null {
  return typeof window === 'undefined' ? null : window.multai ?? null;
}

export async function loadBuildInfo(): Promise<BuildInfo> {
  const bridge = getBridge();
  if (bridge) return bridge.getBuildInfo();
  return {
    version: '0.0.0-dev.1',
    commit: 'browser-preview',
    dirty: true,
    builtAt: new Date().toISOString(),
    channel: import.meta.env.MODE === 'demo' ? 'demo' : 'development',
    platform: 'web',
    serviceOrigin: 'http://127.0.0.1:4310',
  };
}
