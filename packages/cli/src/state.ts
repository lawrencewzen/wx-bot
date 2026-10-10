// Per-binding state under state_dir/<binding>/, file-compatible with the Go version.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PollerStore, Session } from "@wx-bot/core";
import { mkdir0700, writeAtomic } from "./fsutil.ts";

export interface SavedSession extends Session {
  created_at: string;
}

export class NoSessionError extends Error {
  constructor() {
    super("no wechat session file");
  }
}

export class Store implements PollerStore {
  readonly root: string;

  constructor(stateDir: string, binding: string) {
    mkdir0700(stateDir);
    this.root = join(stateDir, binding);
    mkdir0700(this.root);
  }

  private p(name: string) {
    return join(this.root, name);
  }

  loadSession(): SavedSession {
    let text: string;
    try {
      text = readFileSync(this.p("session.json"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new NoSessionError();
      throw new Error(`open session: ${(err as Error).message}`);
    }
    let s: SavedSession;
    try {
      s = JSON.parse(text);
    } catch (err) {
      throw new Error(`decode session: ${(err as Error).message}`);
    }
    if (!s.bot_token || !s.base_url) throw new Error("session incomplete (missing token or base_url)");
    return s;
  }

  saveSession(s: Session): void {
    const out: SavedSession = {
      bot_token: s.bot_token,
      base_url: s.base_url,
      ilink_bot_id: s.ilink_bot_id,
      ilink_user_id: s.ilink_user_id,
      created_at: new Date().toISOString(),
    };
    writeAtomic(this.p("session.json"), JSON.stringify(out, null, 2) + "\n");
  }

  loadTokensSync(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.p("context_tokens.json"), "utf8")) ?? {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`decode context_tokens: ${(err as Error).message}`);
    }
  }

  async saveTokens(t: Record<string, string>): Promise<void> {
    writeAtomic(this.p("context_tokens.json"), JSON.stringify(t, null, 2) + "\n");
  }

  async loadCursor(): Promise<string> {
    try {
      return readFileSync(this.p("cursor"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  async saveCursor(c: string): Promise<void> {
    writeAtomic(this.p("cursor"), c);
  }

  isExpired(): boolean {
    return existsSync(this.p("expired"));
  }

  async markExpired(): Promise<void> {
    writeAtomic(this.p("expired"), new Date().toISOString().replace(/\.\d{3}Z$/, "Z") + "\n");
  }

  clearExpired(): void {
    rmSync(this.p("expired"), { force: true });
  }

  hasSession(): boolean {
    return existsSync(this.p("session.json"));
  }

  hasCursor(): boolean {
    try {
      return readFileSync(this.p("cursor")).length > 0;
    } catch {
      return false;
    }
  }
}
