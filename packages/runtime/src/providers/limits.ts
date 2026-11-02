// Usage limits a provider reports in its response headers: a ChatGPT plan's 5-hour and weekly windows, and
// the per-minute request and token budgets of API keys (OpenAI-style and Anthropic). Only numbers are read.

export interface LimitWindow {
  /** What the window measures, for people: "5-hour", "Weekly", "Tokens per minute". */
  label: string;
  /** 0 to 100. */
  usedPercent: number;
  /** When the window resets, epoch milliseconds, if the provider said. */
  resetsAt?: number;
}

const percent = (value: number) => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
const number = (headers: Headers, name: string): number | undefined => {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

/** "1m30s", "6m0s", "250ms", "2s" (OpenAI style) as milliseconds. */
export function durationMs(text: string): number | undefined {
  if (!/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/u.test(text)) return undefined;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gu)) total += Number(amount) * {ms: 1, s: 1000, m: 60_000, h: 3_600_000}[unit as 'ms' | 's' | 'm' | 'h'];
  return total;
}

function windowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === undefined || minutes <= 0) return fallback;
  if (minutes >= 10_000 && minutes <= 10_200) return 'Weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

export function limitsFrom(headers: Headers, now = Date.now()): LimitWindow[] {
  const windows: LimitWindow[] = [];
  // ChatGPT plan (Codex): primary and secondary windows as a used percentage.
  for (const [slot, fallback] of [['primary', 'Short-term'], ['secondary', 'Long-term']] as const) {
    const used = number(headers, `x-codex-${slot}-used-percent`);
    if (used === undefined) continue;
    const resetAt = number(headers, `x-codex-${slot}-reset-at`);
    const resetAfter = number(headers, `x-codex-${slot}-reset-after-seconds`);
    const resetsAt = resetAt !== undefined ? resetAt * 1000 : resetAfter !== undefined ? now + resetAfter * 1000 : undefined;
    windows.push({label: windowLabel(number(headers, `x-codex-${slot}-window-minutes`), fallback), usedPercent: percent(used), ...(resetsAt !== undefined ? {resetsAt} : {})});
  }
  // OpenAI-style API keys (also Meta and most compatible providers).
  for (const [kind, label] of [['requests', 'Requests per minute'], ['tokens', 'Tokens per minute']] as const) {
    const limit = number(headers, `x-ratelimit-limit-${kind}`), remaining = number(headers, `x-ratelimit-remaining-${kind}`);
    if (limit === undefined || remaining === undefined || limit <= 0) continue;
    const reset = durationMs(headers.get(`x-ratelimit-reset-${kind}`) ?? '');
    windows.push({label, usedPercent: percent((limit - remaining) / limit * 100), ...(reset !== undefined ? {resetsAt: now + reset} : {})});
  }
  // Anthropic.
  for (const [kind, label] of [['requests', 'Requests per minute'], ['input-tokens', 'Input tokens per minute'], ['output-tokens', 'Output tokens per minute']] as const) {
    const limit = number(headers, `anthropic-ratelimit-${kind}-limit`), remaining = number(headers, `anthropic-ratelimit-${kind}-remaining`);
    if (limit === undefined || remaining === undefined || limit <= 0) continue;
    const reset = Date.parse(headers.get(`anthropic-ratelimit-${kind}-reset`) ?? '');
    windows.push({label, usedPercent: percent((limit - remaining) / limit * 100), ...(Number.isFinite(reset) ? {resetsAt: reset} : {})});
  }
  return windows;
}
