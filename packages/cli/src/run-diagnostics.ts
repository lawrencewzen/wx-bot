import { log } from "./log.ts";

const STACK_MAX = 1500;
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Minimal process surface so tests can drive the listeners with an EventEmitter. */
export type ProcessEvents = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

/** One-line stack for slog attrs; Bun fetch errors often have no stack. */
export function flattenStack(err: unknown, max = STACK_MAX): string | undefined {
  if (!(err instanceof Error) || !err.stack) return undefined;
  const s = err.stack.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function errorLogAttrs(err: unknown): { err: string; stack?: string } {
  const attrs: { err: string; stack?: string } = { err: errorMessage(err) };
  const stack = flattenStack(err);
  if (stack) attrs.stack = stack;
  return attrs;
}

/**
 * Catch-all for `wx-bot run`: log the failure and keep the process up.
 * Poller and webhook workers have their own loops; one async error must not
 * take the process down with no trace.
 */
export function installRunProcessDiagnostics(proc: ProcessEvents = process): void {
  proc.on("unhandledRejection", (reason: unknown) => {
    log("error", "unhandledRejection", errorLogAttrs(reason));
  });
  proc.on("uncaughtException", (err: unknown) => {
    log("error", "uncaughtException", errorLogAttrs(err));
  });
  // log() writes stderr synchronously; this must still work on process.exit.
  proc.on("exit", (code: unknown) => {
    log("info", "process exit", { code });
  });
}

/** Log the signal name and abort. SIGHUP is a stop (hangup would otherwise be silent). */
export function bindRunStopSignals(ctl: AbortController, proc: ProcessEvents = process): void {
  for (const signal of STOP_SIGNALS) {
    proc.on(signal, () => {
      log("info", "received signal", { signal });
      ctl.abort();
    });
  }
}
