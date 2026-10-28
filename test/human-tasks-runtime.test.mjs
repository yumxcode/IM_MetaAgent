import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHumanTaskApi } from '../src/human-task-api.mjs';
import { createHumanTasks } from '../src/human-tasks.mjs';
import { runBoundedCommand } from '../src/meta-agent-tasks.mjs';

const runtime = process.env.IM_TEST_RUNTIME_DIR;
test('real runtime gateway: events → notification → receipt and inbox ingestion', { skip: !runtime }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-runtime-e2e-'));
  const originalHome = process.env.META_AGENT_HOME;
  process.env.META_AGENT_HOME = path.join(root, 'home');
  t.after(() => {
    if (originalHome === undefined) delete process.env.META_AGENT_HOME; else process.env.META_AGENT_HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  const { createHumanTask } = await import(pathToFileURL(path.join(runtime, 'dist/infra/humanTasks/HumanTaskStore.js')));
  const { record } = await createHumanTask(workspace, { sessionId: 'isolated-session', type: 'observation',
    title: '拍摄测试视频', why: '验证微信回执链路', steps: ['拍摄视频'], safety: [], onComplete: '检查视频',
    assigneeRole: '测试员', requiredOutputs: [{ name: 'ok', type: 'bool', required: true }, { name: 'video', type: 'file', required: true, accept: ['.mp4'] }],
  });
  const api = createHumanTaskApi({ env: { ...process.env }, run: (_bin, args, options) =>
    runBoundedCommand(process.execPath, [path.join(runtime, 'dist/cli.mjs'), ...args, '--workspace', workspace], options) });
  const sent = [], replies = [];
  let responseLost = false;
  const lossyApi = async (name, input) => {
    const result = await api(name, input);
    if (name === 'human_task.complete') { responseLost = true; throw new Error('Simulated lost response after successful runtime write'); }
    return result;
  };
  const options = { api: lossyApi, stateDir: path.join(root, 'im'),
    bot: { async sendText(msg) { sent.push(msg); return { messageId: 'test-message' }; }, async reply(_msg, text) { replies.push(text); } }, log: { warn(message) { throw new Error(message); } } };
  let service = createHumanTasks(options);
  let sequence = 0;
  const message = (commandText, extra = {}) => ({ accountId: 'bot', fromUserId: 'person', contextToken: 'mock-token', messageId: String(++sequence), commandText, ...extra });
  await service.handle(message('hello')); await service.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'person', 'private chat automatically binds the recipient of worker tasks');
  await service.close(); service = createHumanTasks(options); await service.tick();
  assert.equal(sent.length, 1, 'restart must not resend a registered notification');
  await service.handle(message('/human H1 接单'));
  await service.handle(message('/human H1 填写'));
  await service.handle(message('是'));
  const clip = path.join(root, 'clip.mp4'); fs.writeFileSync(clip, 'fake mp4 bytes for transport test');
  await service.handle(message('', { mediaPath: clip, raw: { item_list: [{ type: 5, video_item: { media: { full_url: 'https://example.invalid/test' } } }] } }));
  const submit = message('提交');
  await service.handle(submit);
  assert.equal(responseLost, true);
  assert.match(replies.at(-1), /回执已提交/);
  assert.equal(await service.handle(submit), true, 'duplicate submit must not become an ordinary agent prompt');
  const { data } = await api('human_task.inspect', { task: { taskId: record.taskId } });
  assert.equal(data.task.status, 'done', replies.join('\n'));
  assert.equal(data.task.receipt.attestation, 'human_relayed');
  assert.equal(data.task.receipt.completedBy.actor, 'person');
  assert.equal(data.task.receipt.outputs.ok, true);
  const attachment = data.task.receipt.attachments[0];
  assert.equal(fs.readFileSync(path.join(workspace, attachment.path), 'utf8'), 'fake mp4 bytes for transport test');
  assert.equal(fs.readdirSync(data.inbox).length, 0, 'runtime moves inbox file into workspace');
  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'im/human-tasks.json')));
  assert.deepEqual(persisted.autoRecipient, { accountId: 'bot', userId: 'person' });
  assert.equal(Object.keys(persisted.drafts).length, 0, 'verified receipt clears submitting draft');
});
