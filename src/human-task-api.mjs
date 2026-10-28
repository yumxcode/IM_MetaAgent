import { runBoundedCommand } from './meta-agent-tasks.mjs';
import path from 'node:path';

const READ = new Set(['human_task.list', 'human_task.events', 'human_task.inspect', 'task.inspect']);
const WRITE = new Set(['human_task.deliver', 'human_task.ack', 'human_task.complete', 'human_task.reject']);

/** Public gateway only: never read or mutate runtime's private task files. */
export function createHumanTaskApi({ env = process.env, run = runBoundedCommand } = {}) {
  const root = env.META_AGENT_RUNTIME_DIR || env.META_AGENT_TASKS_RUNTIME_DIR;
  const bin = env.META_AGENT_HUMAN_BIN || env.META_AGENT_TASKS_BIN || (root ? path.join(root, 'dist/cli-glm.mjs') : 'meta-agent-glm');
  return async (capability, input) => {
    if (!READ.has(capability) && !WRITE.has(capability)) throw new Error('Unsupported human-task capability');
    const args = ['call', capability, '--input', JSON.stringify(input)];
    if (WRITE.has(capability)) args.push('--yes');
    const result = await run(bin, args, { env, timeoutMs: 70_000 });
    let response;
    try { response = JSON.parse(result.stdout); }
    catch { throw new Error('人工工单后端未返回 JSON；请检查 META_AGENT_HUMAN_BIN（需要支持 human_task.* 的 runtime，建议 >= 0.12.1）。'); }
    if (!response.ok || result.code !== 0) {
      const error = new Error(response.error?.message || '人工工单后端调用失败');
      error.code = response.error?.code;
      throw error;
    }
    return response;
  };
}
