#!/bin/sh
# Pax Colonia container entrypoint.
#
# A persistence volume mounts at /app/server/data so saved games survive
# redeploys. On a FRESH volume that mount is empty and shadows the scenarios
# baked into the image, so re-seed them from /app/seed (the image's copy kept
# outside the mount). `-n` never clobbers, so existing saves and any edited
# scenarios are left untouched.
set -e

if [ -d /app/seed ]; then
  cp -rn /app/seed/. /app/server/data/ 2>/dev/null || true
fi

exec node server/server.js
