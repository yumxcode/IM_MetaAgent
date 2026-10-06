# openclaw-weixin-installer

OpenClaw 微信消息通道插件的统一安装器。自动检测宿主 OpenClaw 版本，安装兼容的插件版本。

## 快速开始

```bash
npx -y @tencent-weixin/openclaw-weixin-cli install
```

安装器会自动完成以下步骤：
1. 检测本地 `openclaw --version`
2. 根据兼容矩阵选择合适的插件版本（dist-tag）
3. 调用 `openclaw plugins install` 安装对应版本
4. 引导扫码连接微信
5. 重启 OpenClaw Gateway

**无需手动指定版本号。**

## 兼容矩阵

| openclaw-weixin | 支持的 OpenClaw       | dist-tag                              | 说明                 |
|-----------------|-----------------------|---------------------------------------|----------------------|
| 1.0.x           | >=2026.3.0 <2026.3.22 | `compat-host-gte2026.3.0-lt2026.3.22` | 兼容轨道             |
| v2 主线         | >=2026.3.22           | `latest`                              | 当前推荐             |

> 从 2.0.0 开始，插件采用独立 semver 版本号，不再对齐宿主 OpenClaw 版本号。

## 手动安装

如果需要手动指定版本，可以直接使用 openclaw 命令：

```bash
# 查看当前 OpenClaw 版本
openclaw --version

# 当前推荐主线 (>=2026.3.22)
openclaw plugins install @tencent/openclaw-weixin@latest

# 兼容轨道 (<2026.3.22)
openclaw plugins install @tencent/openclaw-weixin@compat-host-gte2026.3.0-lt2026.3.22
```

## 运行时版本校验

插件在启动时会自动检查宿主版本兼容性。如果版本不匹配，将立即抛出错误：

```
[openclaw-weixin] 宿主版本不兼容!
  当前 OpenClaw 版本: 2026.3.10
  当前插件支持范围:   >=2026.3.22
  请安装 openclaw-weixin@compat-host-gte2026.3.0-lt2026.3.22
  或运行: npx @tencent-weixin/openclaw-weixin-cli install (自动选择兼容版本)
```

## 故障排查

### 宿主版本不兼容

**症状**：插件启动时报 `宿主版本不兼容` 错误。

**解决**：
```bash
# 1. 确认 OpenClaw 版本
openclaw --version

# 2. 用统一安装器重新安装（自动匹配版本）
npx -y @tencent-weixin/openclaw-weixin-cli install
```

### 如何查看当前 openclaw 版本

```bash
openclaw --version
```

## 发布策略

### 本仓库（CLI installer）与插件仓库的关系

本仓库发布的是 **CLI 安装器**（`openclaw-weixin-cli`），不是插件本身（`openclaw-weixin`）。

- **插件仓库**：openclaw-weixin，通过各分支发布到不同的 npm dist-tag
- **本仓库**：CLI 安装器，根据 `COMPAT_MATRIX` 自动选择正确的插件 dist-tag 来安装
