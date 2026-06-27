#!/bin/bash
#
# Ubuntu/Debian 安装 systemd 服务（一键开机自启 + 崩溃重启）
#
# 需要 sudo 权限（服务安装到 /etc/systemd/system/，以普通用户身份运行）
#
set -euo pipefail

SERVICE_NAME="im-metaagent"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_SRC="$SCRIPT_DIR/systemd/${SERVICE_NAME}.service"
SERVICE_DST="/etc/systemd/system/${SERVICE_NAME}.service"
LOG_DIR="$PROJECT_DIR/logs"
CURRENT_USER="$(whoami)"
USER_HOME="$(eval echo ~"$CURRENT_USER")"

# ── 环境检查 ──

echo "🔍 检查环境..."

# 1. 检查 node（通过 nvm login shell 解析，与 start.sh 逻辑一致）
NODE_BIN="$(bash -lc 'command -v node' 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "❌ 找不到 node，请先通过 nvm 安装 Node.js >= 22:" >&2
  echo "   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash" >&2
  echo "   source ~/.bashrc && nvm install 22 && nvm alias default 22" >&2
  exit 1
fi
echo "✅ node: $NODE_BIN"

# 2. 检查 meta-agent CLI
META_BIN="$(bash -lc 'command -v meta-agent' 2>/dev/null || true)"
if [ -z "$META_BIN" ]; then
  echo "⚠️  meta-agent CLI 未找到（运行后微信指令会失败）" >&2
  echo "   安装: npm install -g @meta-agent/runtime" >&2
else
  echo "✅ meta-agent: $META_BIN"
fi

# 3. 检查 systemd
if ! command -v systemctl >/dev/null 2>&1; then
  echo "❌ 当前系统不支持 systemd" >&2
  exit 1
fi
echo "✅ systemd 可用"

# 4. 提醒扫码登录
echo "ℹ️  确保已运行过 'npm run agent:login' 扫码登录微信账号"

# ── 安装 ──

echo ""
echo "📦 安装服务..."

# 5. 创建日志目录
mkdir -p "$LOG_DIR"

# 6. 渲染 service 文件（替换占位符为绝对路径 + 用户名）
TMP_SERVICE="$(mktemp)"
sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
    -e "s|__USER__|$CURRENT_USER|g" \
    "$SERVICE_SRC" > "$TMP_SERVICE"

# 7. 安装到系统目录（需要 sudo）
sudo cp "$TMP_SERVICE" "$SERVICE_DST"
rm -f "$TMP_SERVICE"
sudo sed -i "s|__HOME__|$USER_HOME|g" "$SERVICE_DST" 2>/dev/null || true
echo "✅ service 已安装: $SERVICE_DST"

# 8. 重载 + 启用 + 启动
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

# 9. 确认状态
sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
  PID="$(systemctl show -p MainPID --value "$SERVICE_NAME")"
  echo "✅ 服务已启动 (PID: $PID)"
else
  echo "⚠️  服务已加载但未正常运行"
  echo "   常见原因：未登录微信账号 / meta-agent 未安装 / .env 缺失"
  echo "   查看日志: sudo journalctl -u $SERVICE_NAME -n 30 --no-pager"
  echo "   或:       tail -30 $LOG_DIR/im-metaagent.err.log"
fi

echo ""
echo "━━━ 常用命令 ━━━"
echo "  查看状态 : sudo systemctl status $SERVICE_NAME"
echo "  停止     : sudo systemctl stop $SERVICE_NAME"
echo "  启动     : sudo systemctl start $SERVICE_NAME"
echo "  重启     : sudo systemctl restart $SERVICE_NAME"
echo "  实时日志 : sudo journalctl -u $SERVICE_NAME -f"
echo "  文件日志 : tail -f $LOG_DIR/im-metaagent.out.log"
echo "  卸载     : bash $SCRIPT_DIR/uninstall-linux.sh"
echo ""
echo "⚠️  服务随服务器开机自启，重启服务器后自动恢复"
