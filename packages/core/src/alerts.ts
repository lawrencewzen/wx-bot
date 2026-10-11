// Alerts: problems on one side of the bridge reported through the other side.
//
// - iLink side broken (cannot reach WeChat, login expired): an "alert" event
//   is queued in the inbox and delivered to the agent like a message.
// - Agent side broken (queued messages not taken for a while): wx-bot tells
//   the WeChat owner directly; see agentStalledText.

import { EVENT_SCHEMA, type WxEvent } from "./events.ts";
import type { PollHealth } from "./poller.ts";

/** Poll errors shorter than this are retried silently. */
export const ALERT_GRACE_MS = 2 * 60_000;
/** A message nobody has taken for this long means the agent is not working. */
export const AGENT_STALL_MS = 10 * 60_000;

export type AlertCode = "ilink_unreachable" | "session_expired" | "recovered";

export interface AlertInfo {
  code: AlertCode;
  /** What happened, in Chinese, ready to relay to the user. */
  message: string;
  /** What to do about it. Empty for "recovered". */
  hint: string;
  /** Unix seconds when the problem began. */
  since: number;
}

/** An alert as an inbox event. Text and media are empty, so agents that only handle messages skip it. */
export function buildAlertEvent(binding: string, toBotId: string, info: AlertInfo, nowMs: number): WxEvent {
  return {
    schema: EVENT_SCHEMA,
    event_id: `${binding}:alert:${info.code}:${info.since}`,
    binding,
    kind: "alert",
    message_id: "",
    from_wxid: "",
    to_bot_id: toBotId,
    create_time: Math.floor(nowMs / 1000),
    text: "",
    media: [],
    has_context_token: false,
    reply_hint: "",
    alert: info,
  };
}

/**
 * Turns the poller's health reports into at most one alert per incident:
 * "failing" once errors last ALERT_GRACE_MS, "recovered" when a poll succeeds
 * after that.
 */
export class PollAlerts {
  private failingSince = 0;
  private alerted = false;

  constructor(
    private readonly graceMs = ALERT_GRACE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  update(h: PollHealth): { kind: "failing"; since: number; error: string } | { kind: "recovered"; since: number } | null {
    const now = this.now();
    if (h.ok) {
      const since = this.failingSince;
      const was = this.alerted;
      this.failingSince = 0;
      this.alerted = false;
      return was ? { kind: "recovered", since: Math.floor(since / 1000) } : null;
    }
    if (!this.failingSince) this.failingSince = now;
    if (this.alerted || now - this.failingSince < this.graceMs) return null;
    this.alerted = true;
    return { kind: "failing", since: Math.floor(this.failingSince / 1000), error: h.error };
  }
}

/** WeChat text to the owner when queued messages wait too long, and when they move again. */
export function agentStalledText(binding: string, waiting: number, minutes: number): string {
  return (
    `【wx-bot】你的 Agent（${binding}）已经 ${minutes} 分钟没有处理微信消息，目前有 ${waiting} 条在排队。` +
    `可能是 Agent 没在运行或 webhook 出错，请到 Agent 那边看看。恢复后排队的消息会自动送达。`
  );
}

export const AGENT_RECOVERED_TEXT = "【wx-bot】Agent 已恢复处理微信消息。";
