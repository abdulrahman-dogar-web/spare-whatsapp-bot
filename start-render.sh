#!/bin/bash
# start-render.sh — Render start command for the spare WhatsApp bot.
# Ensures the ./ntfy binary exists (the build does not always produce it —
# Render sometimes restarts the service without re-running the build, so
# the binary can be missing even though the code is new). If the binary is
# missing, download the pinned release, verify its SHA256, extract it and
# install it. If the install fails, the bot still starts (it falls back to
# publishing the alarm to ntfy.sh).
# This file is Render-only. The spare phone uses run-bot.sh (Termux).
NTFY_URL="https://github.com/binwiederhier/ntfy/releases/download/v2.36.0/ntfy_2.36.0_linux_amd64.tar.gz"
NTFY_SHA256="d2c76d17c4bde762913b1cbbf5ca2ac74c3eade36befb0989b44e7877c8596c2"
if [ ! -x ./ntfy ]; then
  echo "ntfy binary missing — downloading v2.36.0..."
  if curl -fsSL -o /tmp/ntfy.tar.gz "$NTFY_URL" \
    && echo "$NTFY_SHA256  /tmp/ntfy.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/ntfy.tar.gz -C /tmp ntfy_2.36.0_linux_amd64/ntfy \
    && cp /tmp/ntfy_2.36.0_linux_amd64/ntfy ./ntfy \
    && chmod +x ./ntfy; then
    echo "ntfy binary installed."
  else
    echo "WARNING: ntfy install failed — bot will fall back to ntfy.sh"
  fi
  rm -rf /tmp/ntfy.tar.gz /tmp/ntfy_2.36.0_linux_amd64
fi
exec node bot.js
