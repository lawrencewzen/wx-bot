import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";

export const DEFAULT_LISTEN = "127.0.0.1:18790";
export const DELIVERY_WEBHOOK = "webhook";
export const DELIVERY_PULL = "pull";
const BINDING_RE = /^[a-z0-9_-]{1,32}$/;

export interface Webhook {
  url: string;
  key: string;
  key_header: string;
  key_prefix: string;
  secret: string;
}

export interface Binding {
  name: string;
  delivery: "webhook" | "pull";
  webhook: Webhook;
  allow_wxids: string[];
  forward_unallowed: boolean;
}

export interface Config {
  state_dir: string;
  media_dir: string;
  local_api: { listen: string; token: string };
  bindings: Binding[];
}

export const defaultConfigPath = () => join(homedir(), ".config", "wx-bot", "config.json");
export const defaultStateDir = () => join(homedir(), ".local", "state", "wx-bot");
export const inboxPath = (c: Config) => join(c.state_dir, "inbox.db");
export const pullBindings = (c: Config) => c.bindings.filter((b) => b.delivery === DELIVERY_PULL).map((b) => b.name);
export const findBinding = (c: Config, name: string) => c.bindings.find((b) => b.name === name);

// Allowed keys at each level; anything else is rejected (Go: DisallowUnknownFields).
const SHAPE = {
  root: ["state_dir", "media_dir", "local_api", "bindings"],
  local_api: ["listen", "token"],
  binding: ["name", "delivery", "webhook", "allow_wxids", "forward_unallowed"],
  webhook: ["url", "key", "key_header", "key_prefix", "secret"],
};

function checkKeys(obj: unknown, allowed: string[], where: string) {
  if (obj === undefined || obj === null) return;
  if (typeof obj !== "object" || Array.isArray(obj)) throw new Error(`parse config: ${where} must be an object`);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new Error(`parse config: json: unknown field "${k}"`);
  }
}

function str(v: unknown, where: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new Error(`parse config: ${where} must be a string`);
  return v;
}

/** "env:NAME" -> value of NAME (must be set and non-empty); "~/" -> home. */
export function expandString(s: string): string {
  if (s.startsWith("env:")) {
    const name = s.slice(4);
    if (!name) throw new Error("empty env var name");
    const v = process.env[name];
    if (v === undefined || v === "") throw new Error(`environment variable ${name} is unset or empty`);
    s = v;
  }
  if (s === "~" || s.startsWith("~/")) return homedir() + s.slice(1);
  return s;
}

export async function checkLoopbackListen(addr: string): Promise<void> {
  const m = /^(?:\[([^\]]*)\]|([^:]*)):(\d*)$/.exec(addr);
  if (!m) throw new Error(`local_api.listen "${addr}": missing port in address`);
  const host = m[1] ?? m[2] ?? "";
  if (!m[3]) throw new Error(`local_api.listen "${addr}": missing port`);
  if (!host) throw new Error(`local_api.listen "${addr}" is not a loopback address (refusing unspecified bind)`);
  if (host.toLowerCase() === "localhost") return;
  const loop = (ip: string) => (isIP(ip) === 4 ? ip.startsWith("127.") : ip === "::1" || ip === "0:0:0:0:0:0:0:1");
  if (isIP(host)) {
    if (loop(host)) return;
    throw new Error(`local_api.listen "${addr}" is not a loopback address`);
  }
  let ips: { address: string }[];
  try {
    ips = await lookup(host, { all: true });
  } catch (err) {
    throw new Error(`local_api.listen "${addr}": resolve: ${(err as Error).message}`);
  }
  if (ips.length === 0) throw new Error(`local_api.listen "${addr}" did not resolve`);
  if (!ips.every((i) => loop(i.address))) throw new Error(`local_api.listen "${addr}" is not a loopback address`);
}

export function parseConfig(text: string): Config {
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`parse config: ${(err as Error).message}`);
  }
  checkKeys(raw, SHAPE.root, "config");
  checkKeys(raw.local_api, SHAPE.local_api, "local_api");
  if (raw.bindings !== undefined && raw.bindings !== null && !Array.isArray(raw.bindings)) {
    throw new Error("parse config: bindings must be an array");
  }
  const bindingsRaw: Record<string, any>[] = raw.bindings ?? [];

  const ex = (v: string, where: string) => {
    try {
      return expandString(v);
    } catch (err) {
      throw new Error(`${where}: ${(err as Error).message}`);
    }
  };

  const c: Config = {
    state_dir: ex(str(raw.state_dir, "state_dir"), "state_dir"),
    media_dir: ex(str(raw.media_dir, "media_dir"), "media_dir"),
    local_api: {
      listen: ex(str(raw.local_api?.listen, "local_api.listen"), "local_api.listen"),
      token: ex(str(raw.local_api?.token, "local_api.token"), "local_api.token"),
    },
    bindings: bindingsRaw.map((b, i) => {
      checkKeys(b, SHAPE.binding, `bindings[${i}]`);
      checkKeys(b.webhook, SHAPE.webhook, `bindings[${i}].webhook`);
      const w = b.webhook ?? {};
      const allow = b.allow_wxids ?? [];
      if (!Array.isArray(allow)) throw new Error(`parse config: bindings[${i}].allow_wxids must be an array`);
      return {
        name: ex(str(b.name, `bindings[${i}].name`), `bindings[${i}].name`),
        delivery: str(b.delivery, `bindings[${i}].delivery`) as Binding["delivery"],
        webhook: {
          url: ex(str(w.url, "url"), `bindings[${i}].webhook.url`),
          key: ex(str(w.key, "key"), `bindings[${i}].webhook.key`),
          key_header: ex(str(w.key_header, "key_header"), `bindings[${i}].webhook.key_header`),
          key_prefix: ex(str(w.key_prefix, "key_prefix"), `bindings[${i}].webhook.key_prefix`),
          secret: ex(str(w.secret, "secret"), `bindings[${i}].webhook.secret`),
        },
        allow_wxids: allow.map((a: unknown, j: number) => ex(str(a, "allow_wxids"), `bindings[${i}].allow_wxids[${j}]`)),
        forward_unallowed: b.forward_unallowed === true,
      };
    }),
  };

  // Defaults.
  if (!c.state_dir) c.state_dir = defaultStateDir();
  if (!c.media_dir) c.media_dir = join(c.state_dir, "media");
  if (!c.local_api.listen) c.local_api.listen = DEFAULT_LISTEN;
  for (const b of c.bindings) {
    if (!b.delivery) b.delivery = DELIVERY_WEBHOOK;
    if (!b.webhook.key_header) b.webhook.key_header = "Authorization";
    if (!b.webhook.key_prefix) b.webhook.key_prefix = "Bearer ";
  }

  // Validation (loopback is checked asynchronously in loadConfig).
  const seen = new Map<string, number>();
  c.bindings.forEach((b, i) => {
    if (!BINDING_RE.test(b.name)) throw new Error(`bindings[${i}].name "${b.name}" invalid: must match [a-z0-9_-]{1,32}`);
    const prev = seen.get(b.name);
    if (prev !== undefined) throw new Error(`duplicate binding name "${b.name}" (index ${prev} and ${i})`);
    seen.set(b.name, i);
    if (b.delivery !== DELIVERY_WEBHOOK && b.delivery !== DELIVERY_PULL) {
      throw new Error(`bindings[${i}].delivery "${b.delivery}" invalid: must be "webhook" or "pull"`);
    }
  });
  return c;
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`load config ${path}: open config: ${(err as Error).message}`);
  }
  try {
    const c = parseConfig(text);
    await checkLoopbackListen(c.local_api.listen);
    return c;
  } catch (err) {
    throw new Error(`load config ${path}: ${(err as Error).message}`);
  }
}
