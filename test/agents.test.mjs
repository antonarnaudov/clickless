// Tests for src/shared/agents: recognising agent clients by the name they connect with.
//   node --test test/agents.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clickless-agents-'));
let m;
before(async () => {
  const out = path.join(tmp, 'agents.cjs');
  await build({ entryPoints: [path.join(root, 'src/shared/agents.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  m = createRequire(import.meta.url)(out);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('known agent clients are recognised from their MCP client names', () => {
  const cases = {
    'claude-code': 'claude-code',
    'Claude Code': 'claude-code',
    'codex-mcp-client': 'codex',
    'gemini-cli-mcp-client': 'gemini-cli',
    'cursor-vscode': 'cursor',
    'claude-ai': 'claude-desktop',
    'Visual Studio Code': 'vscode',
    'windsurf-client': 'windsurf',
    Cline: 'cline',
    'clickless-cli': 'cli',
    'curl/8.7.1': 'http',
    'python-httpx/0.27': 'http',
    'my-own-agent': 'mcp',
  };
  for (const [name, id] of Object.entries(cases)) assert.equal(m.agentClient(name).id, id, name);
  assert.equal(m.agentClient('my-own-agent').name, 'my-own-agent');
  assert.equal(m.agentClient('').id, 'mcp');
});
