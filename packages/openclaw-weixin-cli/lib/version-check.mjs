// lib/version-check.mjs
// Runtime fail-fast version check — call at plugin initialization.
//
// Usage (in plugin entry point):
//   import { assertHostCompat } from '@tencent/openclaw-weixin/lib/version-check.mjs';
//   assertHostCompat();

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPAT_MATRIX,
  findCompatEntry,
  parseVersion,
  formatRange,
} from './compat.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the current OpenClaw host version.
 * Checks (in order):
 *   1. OPENCLAW_VERSION env var (set by host since 2026.3.x)
 *   2. globalThis.__openclaw_version__ (injected by host runtime)
 */
export function getHostVersion() {
  if (process.env.OPENCLAW_VERSION) return process.env.OPENCLAW_VERSION;
  if (globalThis.__openclaw_version__) return String(globalThis.__openclaw_version__);
  return null;
}

/**
 * Read the plugin's own major version from its package.json.
 */
function getPluginMajor() {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'),
    );
    return parseVersion(pkg.version)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Assert that the current host is compatible with this plugin version.
 * Throws a clear error if incompatible; silently returns on success.
 */
export function assertHostCompat() {
  const hostVersion = getHostVersion();
  if (!hostVersion) {
    console.warn(
      '[openclaw-weixin] 无法检测 OpenClaw 宿主版本，跳过兼容性检查',
    );
    return;
  }

  const pluginMajor = getPluginMajor();
  const entry = COMPAT_MATRIX.find(e => e.pluginMajor === pluginMajor);
  if (!entry) {
    console.warn(
      `[openclaw-weixin] 未知插件主版本 ${pluginMajor}，跳过兼容性检查`,
    );
    return;
  }

  const compat = findCompatEntry(hostVersion);
  if (compat && compat.pluginMajor === pluginMajor) {
    // Compatible — nothing to do.
    return;
  }

  const supported = formatRange(entry.openclawRange);
  const suggestion = compat
    ? `请安装 openclaw-weixin@${compat.distTag}`
    : '请升级或降级 OpenClaw 宿主到受支持的版本';

  throw new Error(
    `[openclaw-weixin] 宿主版本不兼容!\n` +
    `  当前 OpenClaw 版本: ${hostVersion}\n` +
    `  当前插件支持范围:   ${supported}\n` +
    `  ${suggestion}\n` +
    `  或运行: npx @tencent-weixin/openclaw-weixin-cli install (自动选择兼容版本)`,
  );
}
