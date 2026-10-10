// Durable queue between the poller and delivery (webhook push or pull).
// Every accepted message is written here before the iLink cursor advances.
// Schema is identical to the Go implementation's inbox.db.

export type SqlValue = string | number | null | Uint8Array;

/** Minimal synchronous SQLite surface (bun:sqlite, Durable Object storage.sql). */
export interface Sql {
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[];
  run(sql: string, ...params: SqlValue[]): { changes: number };
  /** Run fn atomically; must exclude concurrent writers (BEGIN IMMEDIATE or equivalent). */
  transaction<T>(fn: () => T): T;
}

export const STATE_PENDING = "pending";
export const STATE_DONE = "done";
export const STATE_DEAD = "dead";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
	seq         INTEGER PRIMARY KEY AUTOINCREMENT,
	event_id    TEXT    NOT NULL UNIQUE,
	binding     TEXT    NOT NULL,
	payload     BLOB    NOT NULL,
	state       TEXT    NOT NULL DEFAULT 'pending',
	created_at  INTEGER NOT NULL,
	attempts    INTEGER NOT NULL DEFAULT 0,
	next_at     INTEGER NOT NULL DEFAULT 0,
	lease_until INTEGER NOT NULL DEFAULT 0,
	last_error  TEXT    NOT NULL DEFAULT '',
	done_at     INTEGER NOT NULL DEFAULT 0
)`,
  `CREATE INDEX IF NOT EXISTS events_ready ON events (state, binding, seq)`,
];

export interface QueuedEvent {
  seq: number;
  eventId: string;
  binding: string;
  /** Exact JSON body sent to agents. */
  payload: Uint8Array;
  createdAt: number;
  attempts: number;
  lastError: string;
}

export interface InboxCounts {
  pending: number;
  dead: number;
}

export const PULL_LIMITS = {
  defaultLimit: 20,
  maxLimit: 100,
  defaultLeaseMs: 5 * 60_000,
  maxLeaseMs: 60 * 60_000,
  maxWaitMs: 60_000,
} as const;

const marks = (n: number) => Array(n).fill("?").join(", ");

type Row = {
  seq: number;
  event_id: string;
  binding: string;
  payload: Uint8Array | ArrayBuffer | string;
  created_at: number;
  attempts: number;
  last_error: string;
};

function toBytes(v: Row["payload"]): Uint8Array {
  if (typeof v === "string") return new TextEncoder().encode(v);
  return v instanceof Uint8Array ? v : new Uint8Array(v);
}

export class Inbox {
  private listeners = new Set<() => void>();

  constructor(
    private readonly sql: Sql,
    private readonly now: () => number = Date.now,
  ) {
    for (const stmt of SCHEMA) sql.run(stmt);
  }

  /** Called after every in-process add; returns an unsubscribe function. */
  onAdd(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Queue an event. A duplicate event_id is ignored and returns false. */
  add(binding: string, eventId: string, payload: Uint8Array): boolean {
    const { changes } = this.sql.run(
      `INSERT OR IGNORE INTO events (event_id, binding, payload, created_at) VALUES (?, ?, ?, ?)`,
      eventId,
      binding,
      payload,
      this.now(),
    );
    if (changes > 0) for (const fn of this.listeners) fn();
    return changes > 0;
  }

  /** Lease up to limit ready events of bindings, oldest first. */
  claim(bindings: string[], limit: number, leaseMs: number): QueuedEvent[] {
    if (bindings.length === 0 || limit <= 0) return [];
    return this.sql.transaction(() => {
      const now = this.now();
      const rows = this.sql.all<Row>(
        `SELECT seq, event_id, binding, payload, created_at, attempts, last_error FROM events
         WHERE state = ? AND next_at <= ? AND lease_until <= ? AND binding IN (${marks(bindings.length)})
         ORDER BY seq LIMIT ?`,
        STATE_PENDING,
        now,
        now,
        ...bindings,
        limit,
      );
      for (const r of rows) {
        this.sql.run(`UPDATE events SET lease_until = ?, attempts = attempts + 1 WHERE seq = ?`, now + leaseMs, r.seq);
      }
      return rows.map((r) => ({
        seq: r.seq,
        eventId: r.event_id,
        binding: r.binding,
        payload: toBytes(r.payload),
        createdAt: r.created_at,
        attempts: r.attempts + 1,
        lastError: r.last_error,
      }));
    });
  }

  /** Events of bindings ready to claim now (leased ones are not counted). */
  count(bindings: string[]): number {
    if (bindings.length === 0) return 0;
    const now = this.now();
    const [row] = this.sql.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events
       WHERE state = ? AND next_at <= ? AND lease_until <= ? AND binding IN (${marks(bindings.length)})`,
      STATE_PENDING,
      now,
      now,
      ...bindings,
    );
    return row?.n ?? 0;
  }

  /** Pending (including leased) and dead totals for one binding. */
  stats(binding: string): InboxCounts {
    const [row] = this.sql.all<{ pending: number | null; dead: number | null }>(
      `SELECT SUM(state = 'pending') AS pending, SUM(state = 'dead') AS dead FROM events WHERE binding = ?`,
      binding,
    );
    return { pending: row?.pending ?? 0, dead: row?.dead ?? 0 };
  }

  /** Mark events done; when bindings is non-empty only those bindings' events. Returns how many changed. */
  ack(bindings: string[], eventIds: string[]): number {
    if (eventIds.length === 0) return 0;
    let q = `UPDATE events SET state = ?, done_at = ?, lease_until = 0
             WHERE state = ? AND event_id IN (${marks(eventIds.length)})`;
    const params: SqlValue[] = [STATE_DONE, this.now(), STATE_PENDING, ...eventIds];
    if (bindings.length > 0) {
      q += ` AND binding IN (${marks(bindings.length)})`;
      params.push(...bindings);
    }
    return this.sql.run(q, ...params).changes;
  }

  /** Release a leased event so it becomes ready again at atMs. */
  retry(eventId: string, reason: string, atMs: number): void {
    this.sql.run(
      `UPDATE events SET lease_until = 0, next_at = ?, last_error = ? WHERE event_id = ? AND state = ?`,
      atMs,
      reason,
      eventId,
      STATE_PENDING,
    );
  }

  /** Give up on an event; kept for inspection until pruned. */
  dead(eventId: string, reason: string): void {
    this.sql.run(
      `UPDATE events SET state = ?, done_at = ?, lease_until = 0, last_error = ? WHERE event_id = ? AND state = ?`,
      STATE_DEAD,
      this.now(),
      reason,
      eventId,
      STATE_PENDING,
    );
  }

  /** Delete finished events older than retention; give up on pending ones that waited longer. */
  prune(retentionMs: number): { expired: number; deleted: number } {
    const now = this.now();
    const cutoff = now - retentionMs;
    const expired = this.sql.run(
      `UPDATE events SET state = ?, done_at = ?, lease_until = 0, last_error = 'expired before delivery'
       WHERE state = ? AND created_at < ?`,
      STATE_DEAD,
      now,
      STATE_PENDING,
      cutoff,
    ).changes;
    const deleted = this.sql.run(
      `DELETE FROM events WHERE state IN (?, ?) AND done_at < ?`,
      STATE_DONE,
      STATE_DEAD,
      cutoff,
    ).changes;
    return { expired, deleted };
  }

  /** Earliest time (ms) a pending, currently unavailable event becomes claimable, if any. */
  nextReadyAt(bindings: string[]): number | undefined {
    if (bindings.length === 0) return undefined;
    const [row] = this.sql.all<{ t: number | null }>(
      `SELECT MIN(MAX(next_at, lease_until)) AS t FROM events WHERE state = ? AND binding IN (${marks(bindings.length)})`,
      STATE_PENDING,
      ...bindings,
    );
    return row?.t ?? undefined;
  }
}

/** Narrow the pull-enabled bindings to want ("" = all). */
export function pullScope(pull: string[], want: string): string[] {
  if (pull.length === 0) throw new Error('no binding has "delivery": "pull"');
  if (!want) return pull;
  if (pull.includes(want)) return [want];
  throw new Error(`binding "${want}" does not use pull delivery`);
}

/** JSON body for a pull response: {"events":[...]} with payloads embedded verbatim. */
export function pullResponseBody(events: QueuedEvent[]): string {
  const dec = new TextDecoder();
  return `{"events":[${events.map((e) => dec.decode(e.payload).trimEnd()).join(",")}]}`;
}
