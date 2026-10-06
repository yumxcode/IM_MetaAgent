// lib/compat.mjs
// Centralized compatibility matrix for openclaw-weixin plugin versions.

/**
 * Each entry maps a plugin major version to the supported OpenClaw host range.
 * Used by both the installer CLI (auto-select) and the plugin runtime (fail-fast).
 */
export const COMPAT_MATRIX = [
  {
    pluginMajor: 1,
    distTag: 'compat-host-gte2026.3.0-lt2026.3.22',
    openclawRange: { gte: '2026.3.0', lt: '2026.3.22' },
  },
  {
    pluginMajor: 2,
    distTag: 'latest',
    openclawRange: { gte: '2026.3.22' },
  },
];

/** Parse a version string like "2026.3.22" into [major, minor, patch]. */
export function parseVersion(v) {
  const m = String(v).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two version strings. Returns <0, 0, or >0. */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return NaN;
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

/** Check if `version` satisfies { gte, lt } range. */
export function satisfiesRange(version, range) {
  if (range.gte && compareVersions(version, range.gte) < 0) return false;
  if (range.lt && compareVersions(version, range.lt) >= 0) return false;
  return true;
}

/** Find the matching matrix entry for a given OpenClaw host version. */
export function findCompatEntry(openclawVersion) {
  return COMPAT_MATRIX.find(entry =>
    satisfiesRange(openclawVersion, entry.openclawRange)
  ) || null;
}

/** Format a range for display, e.g. ">=2026.3.22 <2026.4.0". */
export function formatRange(range) {
  const parts = [];
  if (range.gte) parts.push(`>=${range.gte}`);
  if (range.lt) parts.push(`<${range.lt}`);
  return parts.join(' ');
}
