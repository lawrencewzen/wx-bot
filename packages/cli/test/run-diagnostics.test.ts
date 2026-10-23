import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindRunStopSignals,
  errorMessage,
  flattenStack,
  installRunProcessDiagnostics,
} from "../src/run-diagnostics.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const DIAG = fileURLToPath(new URL("../src/run-diagnostics.ts", import.meta.url));

const childProcs: Bun.Subprocess[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const p of childProcs.splice(0)) {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return lines;
}

async function until(cond: () => boolean, timeoutMs: number, what: string) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(25);
  }
}

test("flattenStack is a single truncated line", () => {
  const err = new Error("x");
  err.stack = "Error: x\n    at foo (a.ts:1:1)\n    at bar (b.ts:2:2)";
  expect(flattenStack(err)).toBe("Error: x at foo (a.ts:1:1) at bar (b.ts:2:2)");
  expect(flattenStack(err, 20)).toBe("Error: x at foo (a.t…");
  const nos = new Error("socket closed");
  nos.stack = "";
  expect(flattenStack(nos)).toBeUndefined();
  expect(errorMessage("plain")).toBe("plain");
});

test("unhandledRejection, uncaughtException and exit are logged", () => {
  const fake = new EventEmitter();
  const lines = captureLog(() => {
    installRunProcessDiagnostics(fake);
    const err = new Error("boom");
    err.stack = "Error: boom\n    at test";
    fake.emit("unhandledRejection", err);
    fake.emit("uncaughtException", err);
    fake.emit("exit", 7);
  });
  expect(lines.some((l) => l.includes("unhandledRejection") && l.includes("boom") && l.includes("stack="))).toBe(true);
  expect(lines.some((l) => l.includes("uncaughtException") && l.includes("boom"))).toBe(true);
  expect(lines.some((l) => l.includes('msg="process exit"') && l.includes("code=7"))).toBe(true);
});

test("stop signals log the name and abort, including SIGHUP", () => {
  const fake = new EventEmitter();
  const ctl = new AbortController();
  const lines = captureLog(() => {
    bindRunStopSignals(ctl, fake);
    fake.emit("SIGHUP");
  });
  expect(ctl.signal.aborted).toBe(true);
  expect(lines.some((l) => l.includes("received signal") && l.includes("signal=SIGHUP"))).toBe(true);
});

test("unhandledRejection is logged and the process stays alive", async () => {
  const script = join(mkdtempSync(join(tmpdir(), "wxrej-")), "rej.ts");
  writeFileSync(
    script,
    `import { installRunProcessDiagnostics } from ${JSON.stringify(DIAG)};
installRunProcessDiagnostics();
Promise.reject(new Error("test-unhandled"));
setTimeout(() => {
  process.stderr.write("still-alive\\n");
  process.exit(0);
}, 150);
`,
  );
  const proc = Bun.spawn([process.execPath, script], { stderr: "pipe", stdout: "ignore" });
  childProcs.push(proc);
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  expect(stderr).toContain("unhandledRejection");
  expect(stderr).toContain("test-unhandled");
  expect(stderr).toContain("still-alive");
});

function writeRunEnv(baseUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "wxrun-"));
  const state = join(dir, "state");
  const media = join(dir, "media");
  mkdirSync(state);
  mkdirSync(media);
  mkdirSync(join(state, "muse"));
  const config = join(dir, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      state_dir: state,
      media_dir: media,
      local_api: { listen: "127.0.0.1:0", token: "t" },
      bindings: [{ name: "muse", delivery: "pull" }],
    }),
  );
  writeFileSync(
    join(state, "muse", "session.json"),
    JSON.stringify({
      bot_token: "bot-secret",
      base_url: baseUrl,
      ilink_bot_id: "bot@im.bot",
      ilink_user_id: "wxid_owner",
      created_at: "2026-01-01T00:00:00.000Z",
    }),
  );
  return { dir, config, logPath: join(dir, "run.log") };
}

test(
  "run survives a mid-poll socket drop, then SIGTERM leaves signal and exit logs",
  async () => {
    let gets = 0;
    const dropFirst = 2;
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url?.includes("/ilink/bot/getupdates")) {
        gets++;
        req.on("data", () => {});
        req.on("end", () => {
          if (gets <= dropFirst) {
            setTimeout(() => req.socket.destroy(), 20);
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ get_updates_buf: `c${gets}`, msgs: [] }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const url = await new Promise<string>((resolve, reject) => {
      servers.push(server);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") return reject(new Error("no port"));
        resolve(`http://127.0.0.1:${addr.port}`);
      });
      server.on("error", reject);
    });

    const env = writeRunEnv(url);
    const fd = openSync(env.logPath, "w");
    const proc = Bun.spawn([process.execPath, MAIN, "--config", env.config, "run"], {
      stdout: "ignore",
      stderr: fd,
    });
    childProcs.push(proc);
    closeSync(fd);

    const logText = () => {
      try {
        return readFileSync(env.logPath, "utf8");
      } catch {
        return "";
      }
    };

    await until(() => logText().includes("wx-bot running"), 8_000, "run start");
    await until(
      () => gets > dropFirst && logText().includes("getupdates error") && proc.exitCode === null,
      15_000,
      `retry after socket drop (gets=${gets} log=${logText()})`,
    );
    expect(proc.exitCode).toBeNull();
    expect(logText()).toMatch(/getupdates error \(failures \d+\): The socket connection was closed unexpectedly/);
    expect(logText()).not.toContain("shutting down");
    expect(logText()).not.toContain("poller stop");

    process.kill(proc.pid!, "SIGTERM");
    expect(await proc.exited).toBe(0);
    const finalLog = logText();
    expect(finalLog).toContain("received signal");
    expect(finalLog).toContain("signal=SIGTERM");
    expect(finalLog).toContain("shutting down");
    expect(finalLog).toContain('msg="process exit"');
    expect(finalLog).toContain("code=0");
  },
  25_000,
);
