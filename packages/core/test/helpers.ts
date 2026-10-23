import { Database } from "bun:sqlite";
import type { Sql } from "../src/inbox.ts";

/** In-memory bun:sqlite driver for tests. */
export function memorySql(path = ":memory:"): Sql & { db: Database } {
  const db = new Database(path);
  return {
    db,
    all: (sql, ...p) => db.query(sql).all(...(p as never[])) as never,
    run: (sql, ...p) => ({ changes: db.query(sql).run(...(p as never[])).changes }),
    transaction: (fn) => db.transaction(fn).immediate(),
  };
}

export type FetchStep = Response | Error | (() => Response | Promise<Response>);

/** Fake fetch that consumes scripted results in order (repeats the last step if exhausted). */
export function scriptedFetch(steps: FetchStep[]) {
  if (steps.length === 0) throw new Error("scriptedFetch: steps must not be empty");
  const calls: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    calls.push(String(input));
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step();
    return step;
  };
  return { fetch, calls };
}

export type Handler = (req: Request) => Response | Promise<Response>;

/** Start a local HTTP server; stopped automatically by the returned stop(). */
export function serve(handler: Handler) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, timeoutMs = 3000, what = "condition") {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}
