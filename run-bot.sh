#!/data/data/com.termux/files/usr/bin/bash
# run-bot.sh — start the spare WhatsApp bot on the spare phone (Termux).
# Usage:
#   bash run-bot.sh          # QR link mode
#   LINK_MODE=code bash run-bot.sh   # pairing-code mode (8-digit code)
#   DRY_RUN=1 bash run-bot.sh       # poll + log only, send nothing
# The SPARE_TOKEN is read from $HOME/spare-whatsapp-bot/.spare-token
# (chmod 600). Muse delivers the token value securely — never share it.
set -u
DIR="$HOME/spare-whatsapp-bot"
cd "$DIR" || { echo "ERROR: no $DIR (copy bot.js + package.json there first)"; exit 2; }
if [ ! -f "$DIR/.spare-token" ]; then
  echo "ERROR: token file missing: $DIR/.spare-token"
  exit 2
fi
export SPARE_TOKEN="$(tr -d ' \t\r\n' < "$DIR/.spare-token")"
export LINK_MODE="${LINK_MODE:-qr}"
export DRY_RUN="${DRY_RUN:-0}"
export POLL_SECONDS="${POLL_SECONDS:-10}"
termux-wake-lock 2>/dev/null || true
echo "starting spare-whatsapp-bot (link=$LINK_MODE dry_run=$DRY_RUN)"
exec node bot.js
