import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSimpleAutoSetup, applySimpleAutoSetup, BUNDLED_SKILLS_DIR, GLM_SEARCH_SERVER } from '../scripts/setup-simple-auto.mjs';

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-sa-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body)); };

test('copies shared MCP servers and skills into simple_auto without touching the shared config', t => {
  const home = temp(t);
  const shared = { mcpServers: { engineering: { type: 'stdio', command: 'eng' }, search: { type: 'http', url: 'https://s', autoAllow: true },
    'web-search-prime': { type: 'http', url: 'https://glm', headers: { Authorization: 'Bearer ${ZHIPU_API_KEY}' } } } };
  write(path.join(home, 'mcp.json'), shared);
  write(path.join(home, 'mcp.simple_auto.json'), { mcpServers: { search: { type: 'http', url: 'https://mine', autoAllow: ['q'] } } });
  write(path.join(home, 'skills', 'writing', 'SKILL.md'), '# writing');
  write(path.join(home, 'skills', 'notes.md'), '# notes');
  write(path.join(home, 'skills', 'agentic', 'eng-only', 'SKILL.md'), '# mode-specific, not copied');
  const plan = planSimpleAutoSetup({ home, npx: '/opt/homebrew/bin/npx' });
  applySimpleAutoSetup(plan, { now: new Date('2026-10-28T00:00:00Z') });

  const own = JSON.parse(fs.readFileSync(path.join(home, 'mcp.simple_auto.json'), 'utf8')).mcpServers;
  assert.deepEqual(own.search, { type: 'http', url: 'https://mine', autoAllow: ['q'] }, 'existing simple_auto entries win');
  assert.equal(own.engineering.autoAllow, 'readOnly', 'copied servers without autoAllow become read-only');
  assert.equal(own['web-search-prime'].url, 'https://glm', 'an existing GLM entry is copied as-is');
  assert.equal(own['web-search-prime'].autoAllow, 'readOnly');
  assert.deepEqual(own['12306'], { type: 'stdio', command: '/opt/homebrew/bin/npx', args: ['-y', '12306-mcp'], autoAllow: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'mcp.json'), 'utf8')), shared, 'mcp.json unchanged');
  assert.equal(fs.statSync(path.join(home, 'mcp.simple_auto.json')).mode & 0o777, 0o600);
  assert.ok(fs.readdirSync(home).some(name => name.startsWith('mcp.simple_auto.json.bak-')), 'previous file backed up');

  const ownSkills = fs.readdirSync(path.join(home, 'skills', 'simple_auto')).sort();
  for (const name of ['writing', 'notes.md', 'docx', 'xlsx', 'pptx', 'pdf']) assert.ok(ownSkills.includes(name), name);
  assert.ok(!ownSkills.includes('eng-only') && !ownSkills.includes('agentic'));
  assert.ok(fs.existsSync(path.join(home, 'skills', 'writing', 'SKILL.md')), 'global skills stay in place');
  assert.ok(fs.existsSync(path.join(home, 'skills', 'simple_auto', 'docx', '.im-managed')));
});

test('re-running adds GLM search when missing, updates IM skills, keeps user edits', t => {
  const home = temp(t);
  applySimpleAutoSetup(planSimpleAutoSetup({ home, npx: 'npx' }));
  const own = JSON.parse(fs.readFileSync(path.join(home, 'mcp.simple_auto.json'), 'utf8')).mcpServers;
  assert.deepEqual(own['web-search-prime'], GLM_SEARCH_SERVER);
  const docx = path.join(home, 'skills', 'simple_auto', 'docx', 'SKILL.md');
  fs.writeFileSync(docx, 'stale');
  const pdfDir = path.join(home, 'skills', 'simple_auto', 'pdf');
  fs.rmSync(path.join(pdfDir, '.im-managed')); fs.writeFileSync(path.join(pdfDir, 'SKILL.md'), 'my own pdf skill');
  const second = planSimpleAutoSetup({ home, npx: 'npx' });
  assert.deepEqual(second.mcp.map(m => m.action), ['keep', 'keep'].slice(0, second.mcp.length));
  applySimpleAutoSetup(second);
  assert.equal(fs.readFileSync(docx, 'utf8'), fs.readFileSync(path.join(BUNDLED_SKILLS_DIR, 'docx', 'SKILL.md'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(pdfDir, 'SKILL.md'), 'utf8'), 'my own pdf skill');
  assert.equal(second.skills.find(s => s.name === 'pdf').action, 'keep-user-version');
});

test('bundled office skills are complete and declare a description', () => {
  for (const name of ['docx', 'xlsx', 'pptx', 'pdf']) {
    const body = fs.readFileSync(path.join(BUNDLED_SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    assert.match(body, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
    assert.match(body, /outbox\//, `${name} tells the agent where deliverables go`);
  }
});
