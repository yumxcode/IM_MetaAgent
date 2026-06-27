#!/bin/bash
#
# nvm-aware 启动 wrapper（供 launchd / pm2 / systemd 调用）
#
# 问题：launchd / pm2 启动的进程不会加载 shell profile。
#   - 用 zsh 的用户把 nvm source 在 .zshrc 里（交互式 zsh 才读）
#   - bash login shell 读的是 .bash_profile，不读 .zshrc
#   - launchd 又会把 PATH 重置为最小值
#   → 三者叠加，node / meta-agent 都找不到
#
# 解决：显式 source nvm.sh（它会加载 default alias 并把 nvm bin 前置到 PATH），
#   不依赖任何 login shell 魔法。exec 后 node 继承 PATH，spawn meta-agent 也能命中。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

NODE_BIN=""

# 策略 1：PATH 里已经有 node（交互终端直接调用本脚本时）
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

# 策略 2：显式 source nvm（launchd / 守护进程场景的主路径）
if [ -z "$NODE_BIN" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    NODE_BIN="$(command -v node 2>/dev/null || true)"
    # 兜底：nvm.sh 未自动加载 default 时，显式 use
    if [ -z "$NODE_BIN" ] && command -v nvm >/dev/null 2>&1; then
      nvm use default >/dev/null 2>&1 || true
      NODE_BIN="$(command -v node 2>/dev/null || true)"
    fi
  fi
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[start.sh] FATAL: 找不到 node。" >&2
  echo "[start.sh] 已尝试 PATH + 显式 source \$NVM_DIR/nvm.sh (\$NVM_DIR=${NVM_DIR:-未设})。" >&2
  echo "[start.sh] 请确认: 1) nvm 已安装  2) 已设 default 版本 (nvm alias default 22)" >&2
  exit 1
fi

echo "[start.sh] $(date '+%Y-%m-%dT%H:%M:%S') starting: ${NODE_BIN} weixin-meta-agent.mjs (PATH meta-agent: $(command -v meta-agent 2>/dev/null || echo '未找到'))"

# exec 替换进程，让守护工具直接管理 node（收到 SIGTERM 能优雅退出）
# node 继承当前 PATH（含 nvm bin），spawn meta-agent 可命中
exec "$NODE_BIN" weixin-meta-agent.mjs
