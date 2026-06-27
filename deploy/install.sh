#!/bin/bash
#
# 安装并加载 launchd agent（一键开机自启 + 崩溃重启）
#
set -euo pipefail

LABEL="com.yumx.im-metaagent"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_SRC="$SCRIPT_DIR/launchd/${LABEL}.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$PROJECT_DIR/logs"

# 1. 检查 node
NODE_BIN="$(bash -lc 'command -v node' 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "❌ 找不到 node，请先通过 nvm 安装 Node.js >= 22" >&2
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

# 3. 检查微信账号是否已登录
echo "ℹ️  确保已运行过 'npm run agent:login' 扫码登录"

# 4. 创建日志目录
mkdir -p "$LOG_DIR"

# 5. 渲染 plist（替换路径占位符为绝对路径）
mkdir -p "$(dirname "$PLIST_DST")"
sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$PLIST_SRC" > "$PLIST_DST"
echo "✅ plist 已生成: $PLIST_DST"

# 6. 卸载旧实例（若存在），再加载
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

# 7. 确认状态
sleep 2
LAUNCHCTL_LINE="$(launchctl list | grep "$LABEL" || true)"
if [ -n "$LAUNCHCTL_LINE" ]; then
  PID="$(echo "$LAUNCHCTL_LINE" | awk '{print $1}')"
  STATUS="$(echo "$LAUNCHCTL_LINE" | awk '{print $2}')"
  if [ "$PID" != "-" ] && [ -n "$PID" ]; then
    echo "✅ 服务已启动 (PID: $PID)"
  else
    echo "⚠️  服务已加载但进程未运行 (status: $STATUS)"
    echo "   常见原因：未登录微信账号 / meta-agent 未安装 / .env 缺失"
    echo "   查看日志: tail -f $LOG_DIR/im-metaagent.err.log"
  fi
else
  echo "❌ 加载失败，请检查 plist: $PLIST_DST"
  exit 1
fi

echo ""
echo "━━━ 常用命令 ━━━"
echo "  查看状态 : launchctl list | grep $LABEL"
echo "  停止     : launchctl unload \"$PLIST_DST\""
echo "  启动     : launchctl load \"$PLIST_DST\""
echo "  重启     : launchctl unload \"$PLIST_DST\" && launchctl load \"$PLIST_DST\""
echo "  查看日志 : tail -f \"$LOG_DIR/im-metaagent.out.log\""
echo "  卸载     : bash \"$SCRIPT_DIR/uninstall.sh\""
echo ""
echo "⚠️  不要用 kill 停止服务（会被判定为崩溃而自动重启）"
echo "   如需停机请用 launchctl unload"
