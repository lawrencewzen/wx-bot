#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Install wx-bot (Linux / macOS only).

Usage: ./install.sh [--system] [--service] [--prefix DIR]

  --system    install to /usr/local/bin (default: ~/.local/bin)
  --service   install systemd --user unit (Linux) or launchd plist (macOS)
  --prefix    install prefix (default ~/.local or /usr/local with --system)
EOF
}

SYSTEM=0
SERVICE=0
PREFIX=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --system) SYSTEM=1; shift ;;
    --service) SERVICE=1; shift ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

uname_s="$(uname -s 2>/dev/null || echo unknown)"
case "$uname_s" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT|Windows*)
    echo "wx-bot does not support Windows (including MINGW/CYGWIN)." >&2
    exit 1
    ;;
  Linux) GOOS=linux ;;
  Darwin) GOOS=darwin ;;
  *)
    echo "unsupported OS: $uname_s (Linux and macOS only)" >&2
    exit 1
    ;;
esac

uname_m="$(uname -m)"
case "$uname_m" in
  x86_64|amd64) GOARCH=amd64 ;;
  aarch64|arm64) GOARCH=arm64 ;;
  *)
    echo "unsupported arch: $uname_m" >&2
    exit 1
    ;;
esac

if [[ -z "$PREFIX" ]]; then
  if [[ "$SYSTEM" -eq 1 ]]; then
    PREFIX=/usr/local
  else
    PREFIX="${HOME}/.local"
  fi
fi
BINDIR="${PREFIX}/bin"

ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$BINDIR"

if [[ -z "${VERSION:-}" ]]; then
  if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || true)"
  fi
  VERSION="${VERSION:-dev}"
fi

if command -v bun >/dev/null 2>&1 && [[ -f "${ROOT}/packages/cli/src/main.ts" ]]; then
  echo "building from source with bun $(bun --version)"
  (cd "$ROOT" && bun install --frozen-lockfile --production --filter @wx-bot/cli >/dev/null)
  (cd "$ROOT/packages/cli" && bun build src/main.ts --compile --minify \
    --define WXBOT_VERSION="\"${VERSION}\"" --outfile "${BINDIR}/wx-bot")
else
  DIST="${ROOT}/dist/wx-bot_${GOOS}_${GOARCH}"
  if [[ ! -f "$DIST" ]]; then
    echo "bun is not installed and $DIST is missing; downloading the latest release"
    mkdir -p "${ROOT}/dist"
    BASE="https://github.com/lawrencewzen/wx-bot/releases/latest/download"
    curl -fL -o "$DIST" "$BASE/wx-bot_${GOOS}_${GOARCH}"
    curl -fL -o "${ROOT}/dist/checksums.txt" "$BASE/checksums.txt"
    if command -v sha256sum >/dev/null 2>&1; then
      (cd "${ROOT}/dist" && sha256sum -c --ignore-missing checksums.txt)
    else
      (cd "${ROOT}/dist" && shasum -a 256 -c --ignore-missing checksums.txt)
    fi
  fi
  echo "installing prebuilt $DIST"
  install -m 0755 "$DIST" "${BINDIR}/wx-bot"
fi
chmod 0755 "${BINDIR}/wx-bot"

CFGDIR="${HOME}/.config/wx-bot"
mkdir -p "$CFGDIR"
chmod 0700 "$CFGDIR"
CFG="${CFGDIR}/config.json"
if [[ ! -f "$CFG" ]]; then
  install -m 0600 "${ROOT}/examples/config.example.json" "$CFG"
  echo "wrote example config to $CFG (mode 0600); edit webhook.url before running."
fi
ENVFILE="${CFGDIR}/env"
if [[ ! -f "$ENVFILE" ]]; then
  install -m 0600 "${ROOT}/examples/env.example" "$ENVFILE"
  echo "wrote env template to $ENVFILE (mode 0600); fill WXBOT_WEBHOOK_KEY (and friends)."
fi

if [[ "$SERVICE" -eq 1 ]]; then
  if [[ "$GOOS" == linux ]]; then
    UNITDIR="${HOME}/.config/systemd/user"
    mkdir -p "$UNITDIR"
    UNIT="${UNITDIR}/wx-bot.service"
    sed "s|%h/.local/bin/wx-bot|${BINDIR}/wx-bot|g" "${ROOT}/deploy/systemd/wx-bot.service" > "$UNIT"
    echo "installed $UNIT"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload || true
      echo "enable with: systemctl --user enable --now wx-bot"
    fi
  else
    PLIST_SRC="${ROOT}/deploy/launchd/com.lawrencewzen.wx-bot.plist"
    if [[ "$SYSTEM" -eq 1 ]]; then
      PLIST_DST="/Library/LaunchAgents/com.lawrencewzen.wx-bot.plist"
    else
      PLIST_DST="${HOME}/Library/LaunchAgents/com.lawrencewzen.wx-bot.plist"
      mkdir -p "${HOME}/Library/LaunchAgents"
    fi
    LOGDIR="${HOME}/Library/Logs"
    mkdir -p "$LOGDIR"
    # launchd does not expand ~; write absolute, user-writable log paths.
    sed -e "s|/usr/local/bin/wx-bot|${BINDIR}/wx-bot|g" \
        -e "s|~/Library/Logs|${LOGDIR}|g" \
        "$PLIST_SRC" > "$PLIST_DST"
    echo "installed $PLIST_DST (logs: ${LOGDIR}/wx-bot.log)"
    echo "load with: launchctl load $PLIST_DST"
  fi
fi

cat <<EOF

Installed ${BINDIR}/wx-bot

Next steps:
  1. Edit ${CFG} and ${ENVFILE} (env: vars must be set)
  2. ${BINDIR}/wx-bot login <binding>
  3. ${BINDIR}/wx-bot run

Put ${BINDIR} on PATH if needed. Replies are plain text (no Markdown).
EOF
