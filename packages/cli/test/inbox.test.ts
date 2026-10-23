import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdInbox } from "../src/cmd/inbox.ts";
import { openInbox } from "../src/sqlite.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wxrq-"));
  const state = join(dir, "state");
  mkdirSync(state);
  const cfg = join(dir, "config.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      state_dir: state,
      local_api: { listen: "127.0.0.1:18790" },
      bindings: [
        { name: "hook", delivery: "webhook", webhook: { url: "https://example/hook" } },
        { name: "muse", delivery: "pull" },
      ],
    }),
  );
  return { cfg, state };
}

async function run(cfg: string, args: string[]) {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => {
    logs.push(String(m));
  };
  try {
    return { code: await cmdInbox(cfg, args), out: logs.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("inbox requeue moves dead events for webhook and pull bindings", async () => {
  const { cfg, state } = setup();
  const box = openInbox(join(state, "inbox.db"));
  box.add("hook", "hook:1", enc("{}"));
  box.add("hook", "hook:2", enc("{}"));
  box.add("muse", "muse:1", enc("{}"));
  box.claim(["hook", "muse"], 10, 1000);
  box.dead("hook:1", "x");
  box.dead("hook:2", "x");
  box.dead("muse:1", "x");
  expect(box.stats("hook")).toEqual({ pending: 0, dead: 2 });
  box.close();

  expect(await run(cfg, ["requeue", "--binding", "hook", "hook:1"])).toEqual({ code: 0, out: '{"requeued":1}' });
  expect(await run(cfg, ["requeue", "--binding", "hook"])).toEqual({ code: 0, out: '{"requeued":1}' });
  expect(await run(cfg, ["requeue"])).toEqual({ code: 0, out: '{"requeued":1}' });
  expect(await run(cfg, ["requeue"])).toEqual({ code: 0, out: '{"requeued":0}' });
  expect(await run(cfg, ["count", "--binding", "muse"])).toEqual({ code: 0, out: "1" });
});
