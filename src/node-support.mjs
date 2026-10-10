export const MIN_NODE_VERSION = '20.18.0';

export function supportsNode(version = process.versions.node) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version));
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return major > 20 || (major === 20 && minor >= 18);
}

export function assertSupportedNode(version = process.versions.node) {
  if (!supportsNode(version)) throw new Error(`Node.js >= ${MIN_NODE_VERSION} is required; current: ${version}`);
}
