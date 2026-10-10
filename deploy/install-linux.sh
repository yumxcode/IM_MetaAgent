#!/bin/bash
# Install/restart the single Linux systemd receiver as the current user.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${IM_METAAGENT_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js >= 20.18。" >&2
  exit 1
fi
exec node "$SCRIPT_DIR/../scripts/install-linux-service.mjs" "$PROJECT_DIR"
