#!/bin/sh
# wx-bot keepalive for agents without a hook system (e.g. a Grok Bot routine
# scheduled every 10 minutes). Cloud computers may reboot or be restored, and
# a user systemd service does not always come back on its own.
#
# Prints exactly one line:
#   ok                      wx-bot is running and receiving
#   restarted: <how>        wx-bot was down and has been started again
#   NEED_USER: <reason>     cannot fix it alone; tell the user
# Only NEED_USER needs a message to the user.
set -u
WXBOT="${WXBOT:-$HOME/.local/bin/wx-bot}"
ENVFILE="${HOME}/.config/wx-bot/env"
LOG="${HOME}/.local/state/wx-bot/run.log"
INSTALL_URL="https://raw.githubusercontent.com/lawrencewzen/wx-bot/main/install.sh"

if [ ! -x "$WXBOT" ]; then
	if ! curl -fsSL "$INSTALL_URL" | bash >/dev/null 2>&1 || [ ! -x "$WXBOT" ]; then
		echo "NEED_USER: wx-bot 程序不见了，自动重装失败（${INSTALL_URL}）"
		exit 1
	fi
fi

if "$WXBOT" health --liveness >/dev/null 2>&1; then
	how=""
else
	# Prefer the service manager; fall back to a detached process with the env file.
	if command -v systemctl >/dev/null 2>&1 && systemctl --user cat wx-bot >/dev/null 2>&1 &&
		systemctl --user restart wx-bot >/dev/null 2>&1; then
		how="systemctl --user restart wx-bot"
	else
		pkill -f "wx-bot.* run$" 2>/dev/null
		mkdir -p "$(dirname "$LOG")"
		(
			set -a
			[ -f "$ENVFILE" ] && . "$ENVFILE"
			set +a
			if command -v setsid >/dev/null 2>&1; then
				setsid nohup "$WXBOT" run >>"$LOG" 2>&1 </dev/null &
			else
				nohup "$WXBOT" run >>"$LOG" 2>&1 </dev/null &
			fi
		)
		how="nohup wx-bot run (log: ${LOG})"
	fi
	sleep 15
	if ! "$WXBOT" health --liveness >/dev/null 2>&1; then
		echo "NEED_USER: wx-bot 启动失败（${how}）：$("$WXBOT" health 2>&1 | head -1)"
		exit 1
	fi
fi

# Running. Problems a restart cannot fix (expired login, proxy) need the user.
if out="$("$WXBOT" health 2>&1)"; then
	if [ -n "$how" ]; then echo "restarted: $how"; else echo "ok"; fi
else
	echo "NEED_USER: $out"
	exit 1
fi
