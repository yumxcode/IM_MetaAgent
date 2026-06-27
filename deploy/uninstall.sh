#!/bin/bash
#
# 卸载 launchd agent（停止服务 + 删除 plist，不删除项目代码和日志）
#
set -euo pipefail

LABEL="com.yumx.im-metaagent"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✅ 已卸载 launchd agent: $LABEL"
  echo "   日志保留在 $(cd "$(dirname "$0")/.." && pwd)/logs/（可手动删除）"
else
  echo "ℹ️  未安装，无需卸载"
fi
