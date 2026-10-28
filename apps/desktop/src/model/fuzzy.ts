/**
 * Subsequence match with a score that favors contiguous runs and word starts.
 * Returns null when the query is not a subsequence of the label.
 */
export function fuzzyScore(query: string, label: string): { score: number; indices: number[] } | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const l = label.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const at = l.indexOf(ch, from);
    if (at === -1) return null;
    const wordStart = at === 0 || /[\s/_\-.]/.test(l[at - 1] ?? '');
    score += at === prev + 1 ? 5 : 1;
    if (wordStart) score += 3;
    indices.push(at);
    prev = at;
    from = at + 1;
  }
  // Prefer shorter labels when scores tie.
  return { score: score - label.length * 0.01, indices };
}

export function fuzzyFilter<T>(items: readonly T[], query: string, label: (item: T) => string): T[] {
  if (!query.trim()) return [...items];
  return items
    .map((item) => ({ item, match: fuzzyScore(query, label(item)) }))
    .filter((x): x is { item: T; match: NonNullable<ReturnType<typeof fuzzyScore>> } => x.match !== null)
    .sort((a, b) => b.match.score - a.match.score)
    .map((x) => x.item);
}
