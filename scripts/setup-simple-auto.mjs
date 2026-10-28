#!/usr/bin/env node
/**
 * One-time (re-runnable) setup of meta-agent's IM-only simple_auto mode
 * (runtime >= 0.13.3 reads ~/.meta-agent/mcp.simple_auto.json and
 * ~/.meta-agent/skills/simple_auto/ for simple_auto, nothing else).
 *
 *   - copies every server from mcp.json that simple_auto does not have yet
 *     (servers without autoAllow get "readOnly"; mcp.json itself is untouched)
 *   - ensures GLM search (web-search-prime) and 12306-mcp
 *   - copies the shared global skills into skills/simple_auto/
 *   - installs/updates the office skills shipped with IM (.im-managed marker)
 *   - reports missing Python packages / LibreOffice
 *
 * Usage: node scripts/setup-simple-auto.mjs [--dry-run] [--home <dir>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_SKILLS_DIR = path.join(HERE, 'simple-auto-skills');
export const GLM_SEARCH_SERVER = { type: 'http', url: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp',
  headers: { Authorization: 'Bearer ${ZHIPU_API_KEY}' }, autoAllow: true };
const MANAGED = '.im-managed';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`${file} 不是有效的 JSON：${error.message}`); }
}
function resolveNpx() {
  const sibling = path.join(path.dirname(process.execPath), 'npx');
  if (fs.existsSync(sibling)) return sibling;
  const found = spawnSync('/bin/sh', ['-lc', 'command -v npx'], { encoding: 'utf8' }).stdout?.trim();
  return found || 'npx';
}
const isSkillEntry = (dir, name) => {
  if (name.startsWith('.')) return false;
  const full = path.join(dir, name);
  try {
    const stat = fs.statSync(full);
    if (stat.isFile()) return name.endsWith('.md') && name !== 'SKILL.md' && name !== 'README.md';
    return stat.isDirectory() && fs.existsSync(path.join(full, 'SKILL.md'));
  } catch { return false; }
};

/** Pure planning step: what would change, without touching disk. */
export function planSimpleAutoSetup({ home, bundledDir = BUNDLED_SKILLS_DIR, npx = resolveNpx() }) {
  const sharedMcp = readJson(path.join(home, 'mcp.json'))?.mcpServers || {};
  const ownFile = path.join(home, 'mcp.simple_auto.json');
  const own = readJson(ownFile) || {};
  const servers = { ...(own.mcpServers || {}) };
  const mcp = [];
  for (const [name, cfg] of Object.entries(sharedMcp)) {
    if (servers[name]) { mcp.push({ name, action: 'keep' }); continue; }
    const copy = structuredClone(cfg);
    const defaulted = copy.autoAllow === undefined;
    if (defaulted) copy.autoAllow = 'readOnly';
    servers[name] = copy; mcp.push({ name, action: 'copy', defaultedAutoAllow: defaulted });
  }
  if (!servers['web-search-prime']) { servers['web-search-prime'] = structuredClone(GLM_SEARCH_SERVER); mcp.push({ name: 'web-search-prime', action: 'add' }); }
  if (!servers['12306']) { servers['12306'] = { type: 'stdio', command: npx, args: ['-y', '12306-mcp'], autoAllow: true }; mcp.push({ name: '12306', action: 'add' }); }

  const globalDir = path.join(home, 'skills'), ownDir = path.join(globalDir, 'simple_auto');
  const skills = [];
  const existing = name => fs.existsSync(path.join(ownDir, name));
  for (const name of fs.existsSync(globalDir) ? fs.readdirSync(globalDir).sort() : []) {
    if (!isSkillEntry(globalDir, name)) continue;
    skills.push({ name, from: path.join(globalDir, name), action: existing(name) ? 'keep' : 'copy' });
  }
  for (const name of fs.existsSync(bundledDir) ? fs.readdirSync(bundledDir).sort() : []) {
    if (!isSkillEntry(bundledDir, name)) continue;
    const target = path.join(ownDir, name);
    const managed = fs.existsSync(path.join(target, MANAGED));
    skills.push({ name, from: path.join(bundledDir, name), bundled: true,
      action: !fs.existsSync(target) ? 'install' : managed ? 'update' : 'keep-user-version' });
  }
  return { home, ownFile, servers, mcp, ownDir, skills, ownMcpExisted: Boolean(readJson(ownFile)) };
}

/** Apply a plan: back up and write the simple_auto MCP file, copy skills. */
export function applySimpleAutoSetup(plan, { now = new Date() } = {}) {
  fs.mkdirSync(plan.home, { recursive: true, mode: 0o700 });
  if (plan.ownMcpExisted) fs.copyFileSync(plan.ownFile, `${plan.ownFile}.bak-${now.toISOString().replace(/[:.]/g, '-')}`);
  const temp = `${plan.ownFile}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify({ mcpServers: plan.servers }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, plan.ownFile); fs.chmodSync(plan.ownFile, 0o600);
  fs.mkdirSync(plan.ownDir, { recursive: true, mode: 0o700 });
  for (const skill of plan.skills) {
    const target = path.join(plan.ownDir, skill.name);
    if (skill.action === 'copy' || skill.action === 'install' || skill.action === 'update') {
      if (skill.action === 'update') fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(skill.from, target, { recursive: true, dereference: false, errorOnExist: false });
      if (skill.bundled) fs.writeFileSync(path.join(target, MANAGED), 'Installed by IM_MetaAgent setup-simple-auto; re-running setup replaces this folder. Delete this file to keep your own edits.\n');
    }
  }
}

/** Libraries the office skills use; missing ones are reported, never installed here. */
export function checkDependencies(python = 'python3') {
  const modules = { docx: 'python-docx', openpyxl: 'openpyxl', pptx: 'python-pptx', pypdf: 'pypdf', pdfplumber: 'pdfplumber', reportlab: 'reportlab', pandas: 'pandas' };
  const missing = [];
  for (const [module, pkg] of Object.entries(modules)) {
    const result = spawnSync(python, ['-c', `import ${module}`], { stdio: 'ignore' });
    if (result.status !== 0) missing.push(pkg);
  }
  const has = command => spawnSync('/bin/sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
  return { pythonMissing: missing, soffice: has('soffice') || fs.existsSync('/Applications/LibreOffice.app/Contents/MacOS/soffice'), markitdown: has('markitdown') };
}

function describe(plan) {
  const lines = [`meta-agent 目录：${plan.home}`, `simple_auto MCP 配置：${plan.ownFile}`];
  for (const item of plan.mcp) {
    lines.push(`  MCP ${item.name}: ${{ keep: '已存在，保留', copy: `从 mcp.json 复制${item.defaultedAutoAllow ? '（原无 autoAllow，设为 "readOnly"）' : ''}`, add: '新增' }[item.action]}`);
  }
  lines.push(`simple_auto skill 目录：${plan.ownDir}`);
  for (const skill of plan.skills) {
    lines.push(`  skill ${skill.name}: ${{ keep: '已存在，保留', copy: '从全局 skills 复制', install: '安装（IM 自带）', update: '更新（IM 自带）', 'keep-user-version': '已有同名 skill 且不是 IM 安装的，保留你的版本' }[skill.action]}`);
  }
  return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const homeIndex = argv.indexOf('--home');
  const home = path.resolve(homeIndex >= 0 ? argv[homeIndex + 1] : process.env.META_AGENT_HOME?.trim() || path.join(os.homedir(), '.meta-agent'));
  const plan = planSimpleAutoSetup({ home });
  console.log(describe(plan));
  if (argv.includes('--dry-run')) { console.log('\n（--dry-run：未写入任何文件）'); return; }
  applySimpleAutoSetup(plan);
  console.log('\n✅ 已写入。mcp.json 与全局 skills 未改动，其他模式不受影响。');
  const deps = checkDependencies();
  if (deps.pythonMissing.length) console.log(`\n⚠️ 办公 skill 需要的 Python 包缺失：${deps.pythonMissing.join(' ')}\n   建议：python3 -m pip install --user ${deps.pythonMissing.join(' ')}`);
  if (!deps.soffice) console.log('\n⚠️ 未找到 LibreOffice（转 PDF、旧格式转换、表格重算需要）。建议：brew install --cask libreoffice');
  if (!deps.markitdown) console.log('\nℹ️ 可选：python3 -m pip install --user markitdown（快速读取 Word/PPT/Excel/PDF 文字）');
  if (!deps.pythonMissing.length && deps.soffice) console.log('\n✅ 办公 skill 依赖齐全。');
  console.log('\nGLM 搜索使用 config.json 的智谱 apiKey（或环境变量 ZHIPU_API_KEY）；Tavily 读取 config.json 的 tavilyApiKey。需要 meta-agent ≥ 0.13.3。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`设置失败：${error.message}`); process.exitCode = 1; });
}
