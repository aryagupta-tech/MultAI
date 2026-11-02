// Who is here right now: online (has a live socket), typing, and which file they're looking at.
// Ephemeral and in memory: nothing is stored, and a restart just means everyone reports again. The
// service runs as one instance, so one hub sees every socket of a session.

export interface PresenceUpdate {typing: boolean; viewing: string | null}
export interface PresenceEntry {userId: string; typing: boolean; viewing: string | null}
export type PresenceSender = (message: {type: 'presence'; participants: PresenceEntry[]}) => void;

const TYPING_MS = 6_000;
const MAX_PER_SECOND = 4;

interface Connection {userId: string; send: PresenceSender; typingUntil: number; viewing: string | null; viewingOrder: number; recent: number[]}

export class PresenceHub {
  private readonly sessions = new Map<string, Map<object, Connection>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private viewingOrder = 0;
  constructor(private readonly clock: () => number = Date.now) {}

  /** Adds a socket and tells everyone; the returned function removes it. */
  join(sessionId: string, key: object, userId: string, send: PresenceSender): () => void {
    let connections = this.sessions.get(sessionId);
    if (!connections) this.sessions.set(sessionId, connections = new Map());
    connections.set(key, {userId, send, typingUntil: 0, viewing: null, viewingOrder: 0, recent: []});
    this.broadcast(sessionId);
    return () => {
      const current = this.sessions.get(sessionId);
      if (!current?.delete(key)) return;
      if (!current.size) {this.sessions.delete(sessionId); const timer = this.timers.get(sessionId); if (timer) clearTimeout(timer); this.timers.delete(sessionId);}
      this.broadcast(sessionId);
    };
  }

  /** False when the socket sends too often; the update is dropped, not an error. */
  update(sessionId: string, key: object, update: PresenceUpdate): boolean {
    const connection = this.sessions.get(sessionId)?.get(key);
    if (!connection) return false;
    const now = this.clock();
    connection.recent = connection.recent.filter(at => now - at < 1000);
    if (connection.recent.length >= MAX_PER_SECOND) return false;
    connection.recent.push(now);
    const typingUntil = update.typing ? now + TYPING_MS : 0;
    const changed = (typingUntil > now) !== (connection.typingUntil > now) || update.viewing !== connection.viewing;
    connection.typingUntil = typingUntil;
    if (update.viewing !== connection.viewing) connection.viewingOrder = ++this.viewingOrder;
    connection.viewing = update.viewing;
    if (changed) this.broadcast(sessionId);
    this.expireLater(sessionId);
    return true;
  }

  /** One entry per person; several devices merge (typing on any, the latest file viewed). */
  snapshot(sessionId: string): PresenceEntry[] {
    const now = this.clock();
    const people = new Map<string, PresenceEntry>();
    const latestView = new Map<string, number>();
    for (const connection of this.sessions.get(sessionId)?.values() ?? []) {
      const entry = people.get(connection.userId) ?? {userId: connection.userId, typing: false, viewing: null};
      entry.typing ||= connection.typingUntil > now;
      if (connection.viewing !== null && connection.viewingOrder > (latestView.get(connection.userId) ?? -1)) {
        entry.viewing = connection.viewing;
        latestView.set(connection.userId, connection.viewingOrder);
      }
      people.set(connection.userId, entry);
    }
    return [...people.values()];
  }

  private broadcast(sessionId: string): void {
    const message = {type: 'presence' as const, participants: this.snapshot(sessionId)};
    for (const connection of this.sessions.get(sessionId)?.values() ?? []) {
      try {connection.send(message);} catch {/* A closing socket is removed by its own close handler. */}
    }
  }

  /** Typing stops on its own when no update arrives in time. */
  private expireLater(sessionId: string): void {
    const previous = this.timers.get(sessionId);
    if (previous) clearTimeout(previous);
    this.timers.delete(sessionId);
    const now = this.clock();
    const deadlines = [...(this.sessions.get(sessionId)?.values() ?? [])].map(connection => connection.typingUntil).filter(deadline => deadline > 0);
    if (!deadlines.length) return;
    // Expire the earliest typist, even when somebody else keeps sending updates.
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      for (const connection of this.sessions.get(sessionId)?.values() ?? []) {
        if (connection.typingUntil <= this.clock()) connection.typingUntil = 0;
      }
      this.broadcast(sessionId);
      this.expireLater(sessionId);
    }, Math.max(0, Math.min(...deadlines) - now + 50));
    timer.unref();
    this.timers.set(sessionId, timer);
  }
}
