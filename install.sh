#!/usr/bin/env bash
# Install or upgrade wx-bot.
#
#   curl -fsSL https://raw.githubusercontent.com/lawrencewzen/wx-bot/main/install.sh | bash
#   ./install.sh                      # from a checkout
#
# Upgrading keeps config, login state and inbox; a running service is restarted.
set -euo pipefail

REPO="lawrencewzen/wx-bot"
RAW_BASE="${WXBOT_RAW_URL:-https://raw.githubusercontent.com/${REPO}/main}"

usage() {
  cat <<'EOF'
Install or upgrade wx-bot (Linux / macOS only).

Usage: install.sh [--system] [--service] [--prefix DIR] [--version vX.Y.Z] [--release]

From a checkout with bun installed it builds from source; otherwise it downloads
a release binary (musl build on Alpine) and verifies its sha256. An existing
install is upgraded in place: config, login state and inbox are kept, and a
running wx-bot service is restarted.

  --system    install to /usr/local/bin (default: ~/.local/bin)
  --service   install systemd --user unit (Linux) or launchd plist (macOS)
  --prefix    install prefix (default ~/.local or /usr/local with --system)
  --version   install this release tag instead of the latest
  --release   download a release even when building from source is possible

Environment: WXBOT_BINARY=/path/to/wx-bot installs a binary you already have.
EOF
}

SYSTEM=0
SERVICE=0
PREFIX=""
TAG=""
FORCE_RELEASE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --system) SYSTEM=1; shift ;;
    --service) SERVICE=1; shift ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --version) TAG="$2"; shift 2 ;;
    --release) FORCE_RELEASE=1; shift ;;
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
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *)
    echo "unsupported OS: $uname_s (Linux and macOS only)" >&2
    exit 1
    ;;
esac

uname_m="$(uname -m)"
case "$uname_m" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *)
    echo "unsupported arch: $uname_m" >&2
    exit 1
    ;;
esac

# Release binaries embed the Bun runtime and link against the C library:
# Alpine and other musl systems need the *_musl build.
LIBC=""
if [[ "$OS" == linux ]] && { ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; }; then
  LIBC="_musl"
fi

if [[ -z "$PREFIX" ]]; then
  if [[ "$SYSTEM" -eq 1 ]]; then
    PREFIX=/usr/local
  else
    PREFIX="${HOME}/.local"
  fi
fi
BINDIR="${PREFIX}/bin"
TARGET="${BINDIR}/wx-bot"
mkdir -p "$BINDIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Running from a checkout, or piped from curl?
ROOT=""
SRC="${BASH_SOURCE[0]:-}"
if [[ -n "$SRC" && -f "$SRC" ]]; then
  d="$(cd "$(dirname "$SRC")" && pwd)"
  [[ -f "$d/examples/config.example.json" ]] && ROOT="$d"
fi

# repo_file <path> <dest>: copy from the checkout, or download it.
repo_file() {
  if [[ -n "$ROOT" ]]; then
    cp "$ROOT/$1" "$2"
  else
    curl -fsSL --retry 3 -o "$2" "$RAW_BASE/$1"
  fi
}

# ---------- what is installed now ----------

OLD_VERSION=""
if [[ -x "$TARGET" ]]; then
  OLD_VERSION="$("$TARGET" version 2>/dev/null | awk '{print $2}' || true)"
  OLD_VERSION="${OLD_VERSION:-unknown}"
fi
OTHER="$(command -v wx-bot 2>/dev/null || true)"
if [[ -n "$OTHER" && "$OTHER" != "$TARGET" && "$(cd "$(dirname "$OTHER")" && pwd)/wx-bot" != "$TARGET" ]]; then
  echo "note: another wx-bot is on PATH at $OTHER ($("$OTHER" version 2>/dev/null || echo unknown version))."
  echo "      This script installs to $TARGET; remove the other one or put $BINDIR first on PATH."
fi

# ---------- get the new binary into $TMP/wx-bot ----------

if [[ -n "${WXBOT_BINARY:-}" ]]; then
  echo "using $WXBOT_BINARY"
  cp "$WXBOT_BINARY" "$TMP/wx-bot"
elif [[ -n "$ROOT" && "$FORCE_RELEASE" -eq 0 && -z "$TAG" ]] && command -v bun >/dev/null 2>&1; then
  VERSION="${VERSION:-}"
  if [[ -z "$VERSION" ]] && command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || true)"
  fi
  VERSION="${VERSION:-dev}"
  echo "building wx-bot ${VERSION} from source with bun $(bun --version)"
  (cd "$ROOT" && bun install --frozen-lockfile --production --filter @wx-bot/cli >/dev/null)
  (cd "$ROOT/packages/cli" && bun build src/main.ts --compile --minify \
    --define WXBOT_VERSION="\"${VERSION}\"" --outfile "$TMP/wx-bot" >/dev/null)
else
  # Always download: a dist/ left over from an older build (e.g. the Go
  # version) must never be reinstalled by accident.
  ASSET="wx-bot_${OS}_${ARCH}${LIBC}"
  if [[ -n "$TAG" ]]; then
    BASE="${WXBOT_RELEASE_URL:-https://github.com/${REPO}/releases/download/${TAG}}"
  else
    BASE="${WXBOT_RELEASE_URL:-https://github.com/${REPO}/releases/latest/download}"
  fi
  echo "downloading ${ASSET} (${TAG:-latest release})"
  curl -fL --retry 3 --progress-bar -o "$TMP/$ASSET" "$BASE/$ASSET"
  curl -fsSL --retry 3 -o "$TMP/checksums.txt" "$BASE/checksums.txt"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$TMP" && sha256sum -c --ignore-missing --quiet checksums.txt)
  else
    (cd "$TMP" && shasum -a 256 -c --ignore-missing --quiet checksums.txt)
  fi
  mv "$TMP/$ASSET" "$TMP/wx-bot"
fi
chmod 0755 "$TMP/wx-bot"
NEW_VERSION="$("$TMP/wx-bot" version 2>/dev/null | awk '{print $2}' || true)"
if [[ -z "$NEW_VERSION" ]]; then
  echo "the new binary does not run on this system (wrong libc or architecture?)" >&2
  exit 1
fi

# Replace atomically: a running binary cannot be overwritten in place on Linux.
cp "$TMP/wx-bot" "${TARGET}.new.$$"
mv -f "${TARGET}.new.$$" "$TARGET"

# ---------- config (first install only; never overwritten) ----------

CFGDIR="${HOME}/.config/wx-bot"
mkdir -p "$CFGDIR"
chmod 0700 "$CFGDIR"
CFG="${CFGDIR}/config.json"
if [[ ! -f "$CFG" ]]; then
  repo_file examples/config.example.json "$TMP/config.json"
  install -m 0600 "$TMP/config.json" "$CFG"
  echo "wrote example config to $CFG (mode 0600); edit webhook.url before running."
fi
ENVFILE="${CFGDIR}/env"
if [[ ! -f "$ENVFILE" ]]; then
  repo_file examples/env.example "$TMP/env"
  install -m 0600 "$TMP/env" "$ENVFILE"
  echo "wrote env template to $ENVFILE (mode 0600); fill WXBOT_WEBHOOK_KEY (and friends)."
fi

# ---------- service unit (only with --service) ----------

if [[ "$SERVICE" -eq 1 ]]; then
  if [[ "$OS" == linux ]]; then
    UNITDIR="${HOME}/.config/systemd/user"
    mkdir -p "$UNITDIR"
    UNIT="${UNITDIR}/wx-bot.service"
    repo_file deploy/systemd/wx-bot.service "$TMP/unit"
    sed "s|%h/.local/bin/wx-bot|${TARGET}|g" "$TMP/unit" > "$UNIT"
    echo "installed $UNIT"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload || true
      [[ -z "$OLD_VERSION" ]] && echo "enable with: systemctl --user enable --now wx-bot"
    fi
  else
    if [[ "$SYSTEM" -eq 1 ]]; then
      PLIST_DST="/Library/LaunchAgents/com.lawrencewzen.wx-bot.plist"
    else
      PLIST_DST="${HOME}/Library/LaunchAgents/com.lawrencewzen.wx-bot.plist"
      mkdir -p "${HOME}/Library/LaunchAgents"
    fi
    LOGDIR="${HOME}/Library/Logs"
    mkdir -p "$LOGDIR"
    repo_file deploy/launchd/com.lawrencewzen.wx-bot.plist "$TMP/plist"
    # launchd does not expand ~; write absolute, user-writable log paths.
    sed -e "s|/usr/local/bin/wx-bot|${TARGET}|g" \
        -e "s|~/Library/Logs|${LOGDIR}|g" \
        "$TMP/plist" > "$PLIST_DST"
    echo "installed $PLIST_DST (logs: ${LOGDIR}/wx-bot.log)"
    [[ -z "$OLD_VERSION" ]] && echo "load with: launchctl load $PLIST_DST"
  fi
fi

# ---------- upgrade: restart whatever is running ----------

restart_service() {
  if [[ "$OS" == linux ]] && command -v systemctl >/dev/null 2>&1; then
    if systemctl --user is-active --quiet wx-bot 2>/dev/null; then
      systemctl --user restart wx-bot && echo "restarted systemd user service wx-bot" && return 0
    fi
    if systemctl is-active --quiet wx-bot 2>/dev/null; then
      if [[ "$(id -u)" -eq 0 ]]; then
        systemctl restart wx-bot && echo "restarted systemd service wx-bot" && return 0
      elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        sudo systemctl restart wx-bot && echo "restarted systemd service wx-bot" && return 0
      fi
      echo "the systemd service wx-bot is running; restart it to use the new version: sudo systemctl restart wx-bot"
      return 0
    fi
  fi
  if [[ "$OS" == darwin ]] && launchctl list com.lawrencewzen.wx-bot >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/com.lawrencewzen.wx-bot" && echo "restarted launchd service com.lawrencewzen.wx-bot" && return 0
  fi
  if pgrep -f "wx-bot.* run( |$)" >/dev/null 2>&1; then
    echo "a 'wx-bot run' process is running outside a service manager; restart it to use the new version."
  fi
}

if [[ -n "$OLD_VERSION" ]]; then
  echo
  if [[ "$OLD_VERSION" == "$NEW_VERSION" ]]; then
    echo "wx-bot ${NEW_VERSION} reinstalled at ${TARGET}."
  else
    echo "wx-bot upgraded: ${OLD_VERSION} -> ${NEW_VERSION} (${TARGET})"
  fi
  echo "Config, login state and inbox are unchanged; no need to scan the QR code again."
  restart_service
  cat <<EOF

From v0.4.0 on, upgrade with: wx-bot update
EOF
  exit 0
fi

cat <<EOF

Installed wx-bot ${NEW_VERSION} at ${TARGET}

Next steps:
  1. Edit ${CFG} and ${ENVFILE} (env: vars must be set)
  2. ${TARGET} login <binding>
  3. ${TARGET} run

Put ${BINDIR} on PATH if needed. Replies are plain text (no Markdown).
Upgrade later with: wx-bot update
EOF
