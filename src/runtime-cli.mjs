/**
 * The single answer to "which meta-agent does IM run, with which model config".
 *
 * Every route — auto work tasks, the resident chat assistant / simple_auto,
 * the tasks ops console and the human-task gateway — uses this one resolution.
 * Before 1.5.3 chat/auto ran `meta-agent` with config.json while tasks/human
 * ran `meta-agent-glm` with glm_config.json, each with its own override keys.
 *
 *   META_AGENT_CLI          meta-agent (default) | meta-agent-glm
 *                           → the CLI, and the config it reads by default:
 *                             config.json | glm_config.json under META_AGENT_HOME
 *   META_AGENT_RUNTIME_DIR  runtime root; the CLI is <root>/dist/cli.mjs | cli-glm.mjs
 *   META_AGENT_BIN          explicit executable path (location only; point it at
 *                           the chosen CLI so spawned workers read the same config)
 *   META_AGENT_CONFIG_FILE  explicit config file, overrides the CLI's default
 *
 * IM always passes the resolved config as META_AGENT_CONFIG_FILE, so the model
 * config never depends on which launcher happens to be on PATH.
 */
import os from 'node:os';
import path from 'node:path';

export const CLI_CHOICES = Object.freeze({
  'meta-agent': Object.freeze({ entry: 'dist/cli.mjs', config: 'config.json' }),
  'meta-agent-glm': Object.freeze({ entry: 'dist/cli-glm.mjs', config: 'glm_config.json' }),
});
export const DEFAULT_CLI = 'meta-agent';

/** Per-route keys from ≤ 1.5.2. They are ignored now; startup and --check name them. */
export const RETIRED_CLI_KEYS = Object.freeze(['META_AGENT_TASKS_BIN', 'META_AGENT_HUMAN_BIN', 'META_AGENT_TALK_PROFILE', 'META_AGENT_TASKS_PROFILE']);
/** Old name still honoured as a fallback for META_AGENT_RUNTIME_DIR. */
export const LEGACY_RUNTIME_DIR_KEY = 'META_AGENT_TASKS_RUNTIME_DIR';

const value = raw => (typeof raw === 'string' && raw.trim() ? raw.trim() : undefined);
const expandHome = file => (file === '~' || file.startsWith('~/') ? path.join(os.homedir(), file.slice(1)) : file);

/** ~/.meta-agent or META_AGENT_HOME, exactly like the runtime (which does not expand "~"). */
export function resolveMetaAgentHome(env = process.env) {
  return path.resolve(value(env.META_AGENT_HOME) || path.join(os.homedir(), '.meta-agent'));
}

export function resolveRuntimeCli(env = process.env, { platform = process.platform } = {}) {
  const problems = [];
  const requested = value(env.META_AGENT_CLI);
  let cli = DEFAULT_CLI;
  if (requested) {
    const normalized = requested.toLowerCase();
    if (Object.hasOwn(CLI_CHOICES, normalized)) cli = normalized;
    else problems.push(`META_AGENT_CLI=${requested} 无效，只能是 meta-agent 或 meta-agent-glm；已使用 ${DEFAULT_CLI}`);
  }
  const choice = CLI_CHOICES[cli];
  const legacyDir = value(env[LEGACY_RUNTIME_DIR_KEY]);
  const dir = value(env.META_AGENT_RUNTIME_DIR) || legacyDir;
  const runtimeDir = dir ? path.resolve(expandHome(dir)) : undefined;
  const explicitBin = value(env.META_AGENT_BIN);
  const bin = explicitBin ? expandHome(explicitBin)
    : runtimeDir ? path.join(runtimeDir, choice.entry)
      : platform === 'win32' ? `${cli}.cmd` : cli;
  const explicitConfig = value(env.META_AGENT_CONFIG_FILE);
  const profile = path.resolve(explicitConfig ? expandHome(explicitConfig) : path.join(resolveMetaAgentHome(env), choice.config));
  const retired = RETIRED_CLI_KEYS.filter(key => value(env[key]));
  if (retired.length) problems.push(`${retired.join('、')} 已停用并被忽略：所有用途统一使用 META_AGENT_CLI（当前 ${cli}）${explicitConfig ? '与 META_AGENT_CONFIG_FILE' : `与 ${choice.config}`}${cli === 'meta-agent-glm' ? '' : '；需要 glm 配置请设置 META_AGENT_CLI=meta-agent-glm'}`);
  if (legacyDir && !value(env.META_AGENT_RUNTIME_DIR)) problems.push(`${LEGACY_RUNTIME_DIR_KEY} 是旧名称，请改为 META_AGENT_RUNTIME_DIR（当前仍按它定位 runtime）`);
  return {
    cli, bin, profile, runtimeDir, problems, retired,
    source: { bin: explicitBin ? 'META_AGENT_BIN' : runtimeDir ? 'META_AGENT_RUNTIME_DIR' : 'PATH', profile: explicitConfig ? 'META_AGENT_CONFIG_FILE' : `META_AGENT_CLI 默认（${choice.config}）` },
  };
}

/** Environment for a child CLI: the resolved config is always explicit. */
export function runtimeCliEnv(env = process.env, resolved = resolveRuntimeCli(env)) {
  return { ...env, META_AGENT_CONFIG_FILE: resolved.profile, ...(resolved.runtimeDir ? { META_AGENT_RUNTIME_DIR: resolved.runtimeDir } : {}) };
}
