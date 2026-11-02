// Tells people when a newer MultAI is published. It only reads the public GitHub release list and never
// downloads or installs anything: the sidebar links to the release page and the person installs it.
import {net} from 'electron';

export const RELEASES_API = 'https://api.github.com/repos/aryagupta-tech/MultAI/releases/latest';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** True when `candidate` (like "v0.2.0" or "0.1.1") is a newer x.y.z than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(value.trim())?.slice(1).map(Number);
  const a = parse(candidate), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** The release fields this uses, checked: only a github.com page of this repository is ever opened. */
export function releaseFrom(json: unknown, current: string): {version: string; url: string} | null {
  const release = json as {tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown} | null;
  if (!release || typeof release.tag_name !== 'string' || typeof release.html_url !== 'string' || release.draft || release.prerelease) return null;
  if (!release.html_url.startsWith('https://github.com/aryagupta-tech/MultAI/releases/')) return null;
  return isNewer(release.tag_name, current) ? {version: release.tag_name.replace(/^v/u, ''), url: release.html_url} : null;
}

let cached: {at: number; value: {version: string; url: string} | null} | null = null;
export async function latestRelease(current: string, fetcher: typeof fetch = net.fetch as typeof fetch, now = Date.now()): Promise<{version: string; url: string} | null> {
  if (cached && now - cached.at < CHECK_EVERY_MS) return cached.value;
  try {
    const response = await fetcher(RELEASES_API, {headers: {accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(10_000), redirect: 'error'});
    // No releases yet (404) or rate limited: nothing to show, check again later.
    const value = response.ok ? releaseFrom(await response.json(), current) : null;
    cached = {at: now, value};
    return value;
  } catch {return null;}
}
