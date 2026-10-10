import { Database } from "bun:sqlite";
import { closeSync, openSync } from "node:fs";
import { Inbox, type Sql } from "@wx-bot/core";

/** Open (creating 0600) the inbox database; safe to share between processes. */
export function openInbox(path: string): Inbox & { close(): void } {
  closeSync(openSync(path, "a", 0o600));
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  const sql: Sql = {
    all: (q, ...p) => db.query(q).all(...(p as never[])) as never,
    run: (q, ...p) => ({ changes: db.query(q).run(...(p as never[])).changes }),
    transaction: (fn) => db.transaction(fn).immediate(),
  };
  const inbox = new Inbox(sql) as Inbox & { close(): void };
  inbox.close = () => db.close();
  return inbox;
}
