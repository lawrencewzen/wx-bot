#!/bin/sh
# Muse hook detector for wx-bot pull delivery.
#
# It only counts ready events (no claim, no side effects), so dry runs are
# safe. Events being handled are leased and not counted, so an agent that is
# already working is not woken again; unacked events come back after the lease.
#
# Connection problems and expired logins arrive as alert events in the inbox
# (counted above). The one thing an alert cannot report is wx-bot run itself
# being down, so `wx-bot health --liveness` covers that. Each such problem
# wakes once, then again every hour while it lasts.
#
# Wrap the final decision in the Muse hook script protocol:
#   count > 0  -> wake  (wake text: "微信有 N 条新事件，按 wx-bot 指令处理")
#   unhealthy  -> wake  (wake text: "wx-bot 异常：...，按 AGENTS.md「断线排查」处理")
#   otherwise  -> silent
#   error      -> silent, and report the error text
set -eu
WXBOT="${WXBOT:-$HOME/.local/bin/wx-bot}"
BINDING="${WXBOT_BINDING:-muse}"
MARK="${HOME}/.cache/wx-bot/hook-alerted"

if ! count="$("$WXBOT" inbox count --binding "$BINDING" 2>&1)"; then
	echo "error: $count"
	exit 0
fi
if [ "$count" -gt 0 ]; then
	echo "wake: 微信有 $count 条新事件"
	exit 0
fi

if health="$("$WXBOT" health --binding "$BINDING" --liveness 2>&1)"; then
	rm -f "$MARK"
	echo "silent"
elif [ -f "$MARK" ] && [ -z "$(find "$MARK" -mmin +60 2>/dev/null)" ]; then
	echo "silent"
else
	mkdir -p "$(dirname "$MARK")"
	touch "$MARK"
	echo "wake: wx-bot 异常：$health"
fi
