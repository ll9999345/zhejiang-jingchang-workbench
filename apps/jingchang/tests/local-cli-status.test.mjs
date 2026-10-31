import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localCliStatuses, localCliStatus } from '../lib/local-cli-status.mjs';

test('本机 CLI 状态只查找程序文件，不把安装误报成登录或账户状态', async t => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'jingchang-cli-status-'));
  // Retain the task-owned fixture for inspection; do not automatically delete files.
  const codex = path.join(bin, 'codex');
  await fs.writeFile(codex, '#!/bin/sh\nexit 0\n');
  await fs.chmod(codex, 0o755);

  const statuses = await localCliStatuses({ env: { PATH: bin }, pathEnv: bin });
  const found = statuses.find(item => item.id === 'codex');
  const missing = statuses.find(item => item.id === 'gemini-cli');
  assert.equal(found.installed, true);
  assert.equal(found.executable, 'codex');
  assert.equal(found.version, null);
  assert.equal(found.loggedIn, null);
  assert.equal(found.accountChecked, false);
  assert.equal(found.infoAvailable, true);
  assert.equal(missing.installed, false);
  assert.equal(missing.loggedIn, null);
  assert.equal(JSON.stringify(statuses).includes(bin), false);
});

test('Windows PATH lookup honors PATHEXT and reports only the executable name', async () => {
  const checked = [];
  const status = await localCliStatus('gemini-cli', {
    platform: 'win32',
    env: { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD' },
    statFile: async file => {
      checked.push(file);
      if (file === 'C:\\tools\\gemini.cmd') return { isFile: () => true };
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    accessFile: async () => { throw new Error('Windows lookup should not require X_OK'); },
  });
  assert.ok(checked.includes('C:\\tools\\gemini.cmd'));
  assert.equal(status.installed, true);
  assert.equal(status.executable, 'gemini.cmd');
  assert.equal(status.infoAvailable, false);
  assert.equal(status.loggedIn, null);
});

test('explicit Codex path is checked without executing it or returning the full path', async () => {
  const configured = '/private/tools/codex';
  const status = await localCliStatus('codex', {
    env: { PATH: '', CODEX_BIN: configured },
    pathEnv: '',
    statFile: async file => file === configured ? { isFile: () => true } : Promise.reject(new Error('missing')),
    accessFile: async () => {},
  });
  assert.equal(status.installed, true);
  assert.equal(status.executable, 'codex');
  assert.equal(JSON.stringify(status).includes(configured), false);
  assert.equal(status.loggedIn, null);
  assert.equal(status.accountChecked, false);
  assert.equal(status.infoAvailable, true);
});

test('WSL 即梦状态只反映宿主入口，不扫描 Linux CLI 或查询积分', async () => {
  const status = await localCliStatus('jimeng', {
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE', JIMENG_USE_WSL: '1' },
    statFile: async file => file === 'C:\\Windows\\System32\\wsl.exe'
      ? { isFile: () => true }
      : Promise.reject(new Error('missing')),
    accessFile: async () => {},
  });
  assert.equal(status.installed, null);
  assert.equal(status.executable, 'wsl.exe');
  assert.equal(status.loggedIn, null);
  assert.equal(status.accountChecked, false);
  assert.equal(status.infoAvailable, false);
  assert.match(status.message, /未扫描 WSL 内的 dreamina/);
  assert.match(status.message, /未查询登录状态或积分/);
});
