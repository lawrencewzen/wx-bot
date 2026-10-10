import { allowlist, type Inbox, type InboxCounts } from "@wx-bot/core";
import { existsSync } from "node:fs";
import { DELIVERY_WEBHOOK, inboxPath, loadConfig, type Binding, type Config } from "../config.ts";
import { openInbox } from "../sqlite.ts";
import { Store } from "../state.ts";

export interface BindingStatus {
  name: string;
  logged_in: boolean;
  expired: boolean;
  bot_id: string;
  cursor_set: boolean;
  allowlist: string[];
  delivery: string;
  webhook_host: string;
  inbox?: InboxCounts;
}

/** First 4 code points + "…". */
export function redactBotId(id: string): string {
  if (!id) return "";
  return Array.from(id).slice(0, 4).join("") + "…";
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function statusOf(cfg: Config, b: Binding, box?: Inbox): BindingStatus {
  const st: BindingStatus = {
    name: b.name,
    logged_in: false,
    expired: false,
    bot_id: "",
    cursor_set: false,
    allowlist: [],
    delivery: b.delivery,
    webhook_host: host(b.webhook.url),
  };
  if (box) st.inbox = box.stats(b.name);
  let loginUser = "";
  try {
    const store = new Store(cfg.state_dir, b.name);
    st.expired = store.isExpired();
    st.cursor_set = store.hasCursor();
    try {
      const s = store.loadSession();
      st.logged_in = true;
      st.bot_id = redactBotId(s.ilink_bot_id);
      loginUser = s.ilink_user_id;
    } catch {}
  } catch {}
  st.allowlist = [...allowlist(b.allow_wxids, loginUser)].sort();
  return st;
}

export const statusAll = (cfg: Config, box?: Inbox) => cfg.bindings.map((b) => statusOf(cfg, b, box));

export async function cmdStatus(configPath: string, args: string[]): Promise<number> {
  if (args.length !== 0) return console.error("usage: wx-bot status"), 2;
  const cfg = await loadConfig(configPath).catch((e: Error) => e);
  if (cfg instanceof Error) return console.error(`wx-bot: ${cfg.message}`), 1;
  if (cfg.bindings.length === 0) return console.log("no bindings configured"), 0;
  // Read-only peek: do not create the inbox if `run` never has.
  let box: ReturnType<typeof openInbox> | undefined;
  if (existsSync(inboxPath(cfg))) {
    try {
      box = openInbox(inboxPath(cfg));
    } catch {}
  }
  try {
    for (const st of statusAll(cfg, box)) {
      const lines = [
        `binding: ${st.name}`,
        `  logged_in: ${st.logged_in}`,
        `  expired: ${st.expired}`,
        `  bot_id: ${st.bot_id}`,
        `  cursor: ${st.cursor_set ? "set" : "unset"}`,
        `  allowlist: ${st.allowlist.join(", ")}`,
        `  delivery: ${st.delivery}`,
      ];
      if (st.delivery === DELIVERY_WEBHOOK) lines.push(`  webhook: ${st.webhook_host}`);
      if (st.inbox) lines.push(`  inbox: ${st.inbox.pending} pending, ${st.inbox.dead} dead`);
      console.log(lines.join("\n"));
    }
  } finally {
    box?.close();
  }
  return 0;
}
