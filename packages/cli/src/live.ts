import { allowlist, IlinkClient, WxBotError, type MediaSink } from "@wx-bot/core";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findBinding, type Binding, type Config } from "./config.ts";
import { mkdir0700 } from "./fsutil.ts";
import { nodeCrypto } from "./nodecrypto.ts";
import { Store, type SavedSession } from "./state.ts";

/** An in-memory handle for one logged-in binding. */
export interface LiveBinding {
  name: string;
  config: Binding;
  store: Store;
  session: SavedSession;
  client: IlinkClient;
  allow: Set<string>;
}

export function openLive(cfg: Config, name: string): LiveBinding {
  const b = findBinding(cfg, name);
  if (!b) throw new WxBotError("not_found", `unknown binding "${name}"`);
  const store = new Store(cfg.state_dir, name);
  if (store.isExpired()) throw new WxBotError("expired", `binding ${name} session expired: run \`wx-bot login ${name}\``);
  let session: SavedSession;
  try {
    session = store.loadSession();
  } catch (err) {
    throw new WxBotError("expired", `binding ${name}: ${(err as Error).message} (run \`wx-bot login ${name}\`)`);
  }
  const client = new IlinkClient(session, { crypto: nodeCrypto });
  client.loadTokens(store.loadTokensSync());
  return { name, config: b, store, session, client, allow: allowlist(b.allow_wxids, session.ilink_user_id) };
}

/** media_dir/<binding>/<YYYYMMDD>/<msgid>_<name>, files 0600, dirs 0700. */
export function fileMediaSink(mediaDir: string): MediaSink {
  return async (m) => {
    const d = m.createdAt;
    const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const dir = join(mediaDir, m.binding, day);
    mkdir0700(dir);
    const path = join(dir, `${m.messageId}_${m.fileName}`);
    writeFileSync(path, m.data, { mode: 0o600 });
    return { path: resolve(path) };
  };
}
