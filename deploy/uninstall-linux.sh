#!/bin/bash
#
# 卸载 systemd 服务（停止 + 禁用 + 删除 service 文件，不删项目代码和日志）
#
set -euo pipefail

SERVICE_NAME="im-metaagent"
SERVICE_DST="/etc/systemd/system/${SERVICE_NAME}.service"

if [ -f "$SERVICE_DST" ]; then
  sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  sudo rm -f "$SERVICE_DST"
  sudo systemctl daemon-reload
  echo "✅ 已卸载 systemd 服务: $SERVICE_NAME"
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  echo "   日志保留在 $PROJECT_DIR/logs/（可手动删除）"
else
  echo "ℹ️  未安装，无需卸载"
fi
