import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  REMOTE_READ_TOOLS,
  authorizeRemoteReadPath,
  validateRemoteReadArguments,
} from '../dist/native-remote/safe-read-policy.js';
import { validateToolCall } from '../cloudflare/native-rdc-gateway/src/core.js';
import {
  DEFAULT_POLICY_REGISTRY,
  PERMISSION_CLASSES,
} from '../cloudflare/native-rdc-gateway/src/policy.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'native-rdc-m3c-'));
  const root = path.join(base, 'approved');
  const outside = path.join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(root, 'safe.txt'), 'one\ntwo\nthree\n', 'utf8');
  await writeFile(path.join(root, 'code.ts'), 'export const safe = true;\n', 'utf8');
  await writeFile(path.join(root, '.env'), 'SECRET=synthetic\n', 'utf8');
  await writeFile(path.join(root, 'binary.exe'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(outside, 'outside.txt'), 'outside\n', 'utf8');
  await mkdir(path.join(root, '.ssh'));
  await writeFile(path.join(root, '.ssh', 'id_ed25519'), 'synthetic-key', 'utf8');
  return { base, root, outside };
}

test('M3C exposes only the five explicit read tools', () => {
  assert.deepEqual([...REMOTE_READ_TOOLS], [
    'get_config',
    'list_processes',
    'list_directory',
    'get_file_info',
    'read_file',
  ]);
  assert.deepEqual(Object.keys(DEFAULT_POLICY_REGISTRY), [...REMOTE_READ_TOOLS]);
  assert.equal(DEFAULT_POLICY_REGISTRY.get_config.permissionClass, PERMISSION_CLASSES.READ_SAFE);
  for (const name of REMOTE_READ_TOOLS.slice(1)) {
    assert.equal(DEFAULT_POLICY_REGISTRY[name].permissionClass, PERMISSION_CLASSES.READ_SENSITIVE);
    assert.equal(DEFAULT_POLICY_REGISTRY[name].approvalRequired, false);
  }
});

test('approved text file path resolves canonically inside root', async () => {
  const f = await fixture();
  try {
    const safe = await authorizeRemoteReadPath(path.join(f.root, 'safe.txt'), [f.root], { requireTextFile: true });
    assert.equal(await import('node:fs/promises').then((fs) => fs.realpath(safe)), safe);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('outside-root read is denied', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => authorizeRemoteReadPath(path.join(f.outside, 'outside.txt'), [f.root], { requireTextFile: true }),
      /outside approved roots/,
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('sensitive credential-like paths are denied even inside root', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => authorizeRemoteReadPath(path.join(f.root, '.env'), [f.root], { requireTextFile: true }),
      /sensitive and denied/,
    );
    await assert.rejects(
      () => authorizeRemoteReadPath(path.join(f.root, '.ssh', 'id_ed25519'), [f.root], { requireTextFile: true }),
      /sensitive and denied/,
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('binary file reads are denied', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => authorizeRemoteReadPath(path.join(f.root, 'binary.exe'), [f.root], { requireTextFile: true }),
      /file type is not permitted/,
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('symlink or junction escape resolves outside root and is denied', async () => {
  const f = await fixture();
  try {
    const link = path.join(f.root, 'escape-link');
    try {
      await symlink(f.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    await assert.rejects(
      () => authorizeRemoteReadPath(path.join(link, 'outside.txt'), [f.root], { requireTextFile: true }),
      /outside approved roots/,
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('no configured roots means filesystem reads fail closed', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => validateRemoteReadArguments('get_file_info', { path: path.join(f.root, 'safe.txt') }, []),
      /No Native RDC read roots/,
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('read_file bounds offset and line count', async () => {
  const f = await fixture();
  try {
    const safe = await validateRemoteReadArguments('read_file', {
      path: path.join(f.root, 'safe.txt'),
      offset: 1,
      length: 200,
    }, [f.root]);
    assert.equal(safe.offset, 1);
    assert.equal(safe.length, 200);
    await assert.rejects(
      () => validateRemoteReadArguments('read_file', {
        path: path.join(f.root, 'safe.txt'),
        length: 201,
      }, [f.root]),
      /between 1 and 200/,
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('list_directory depth is capped at two', async () => {
  const f = await fixture();
  try {
    const safe = await validateRemoteReadArguments('list_directory', { path: f.root, depth: 2 }, [f.root]);
    assert.equal(safe.depth, 2);
    await assert.rejects(
      () => validateRemoteReadArguments('list_directory', { path: f.root, depth: 3 }, [f.root]),
      /depth must be 1 or 2/,
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('gateway accepts bounded read calls and still rejects arbitrary execution', () => {
  const now = Date.now();
  const call = (tool_name, args) => ({
    type: 'TOOL_CALL',
    call_id: 'm3c-test',
    device_id: 'device-1',
    tool_name,
    arguments: args,
    created_at: new Date(now).toISOString(),
    deadline_at: new Date(now + 5000).toISOString(),
  });
  assert.equal(validateToolCall(call('list_processes', {}), 'device-1', now).ok, true);
  assert.equal(validateToolCall(call('read_file', { path: 'C:\\approved\\x.txt', length: 20 }), 'device-1', now).ok, true);
  assert.equal(validateToolCall(call('start_process', { command: 'whoami' }), 'device-1', now).ok, false);
  assert.equal(validateToolCall(call('write_file', { path: 'x', content: 'x' }), 'device-1', now).ok, false);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (error) {
    failed += 1;
    console.error('FAIL ' + name);
    console.error(error);
  }
}
console.log('Native RDC M3C tests: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
