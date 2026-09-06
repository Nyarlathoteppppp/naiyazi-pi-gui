import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { SessionSupervisor } from '../dist/index.js';

test('single discovery imports new cwd, respects ignores and longest ancestors without duplicate scans', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-discovery-')));
  const paths = ['ywbw', 'searchjob', 'pisearchjob', 'repo', 'repo/api', 'ignored', 'ignored/child'];
  for (const path of paths) await mkdir(join(root, path), { recursive: true });
  const infos = await Promise.all([...paths, '/'].map(async (path, i) => {
    const file = join(root, i + '.jsonl');
    await writeFile(file, '');
    return { id: String(i), path: file, cwd: path === '/' ? '/' : join(root, path), created: new Date(), modified: new Date(), messageCount: 0, firstMessage: '', allMessagesText: '' };
  }));
  let scans = 0;
  t.mock.method(SessionManager, 'listAll', async () => { scans++; return [...infos, infos[0]]; });
  t.mock.method(SessionManager, 'list', async () => { throw new Error('Repeated scan forbidden'); });
  const supervisor = new SessionSupervisor({ catalogFilePath: join(root, 'catalog.json') });
  const diagnostics: string[] = [];
  const result = await supervisor.syncWorkspaces([{path: join(root, 'repo')}, {path: join(root, 'repo/api')}], [join(root, 'ignored')], message => diagnostics.push(message));
  assert.deepEqual(diagnostics, [], 'Skipping root cwd is not a startup warning');
  assert.equal(scans, 1);
  assert.equal(result.length, 5);
  assert.equal(result.flatMap(x => x.sessions).length, 5);
  assert.equal(result.find(x => x.workspace.path.endsWith('/repo'))!.sessions.length, 1);
  assert.equal(result.find(x => x.workspace.path.endsWith('/repo/api'))!.sessions.length, 1);
  assert.ok(result.some(x => x.workspace.displayName === 'ywbw'));
  const child = await supervisor.syncWorkspaces([{path: join(root, 'ignored/child')}], [join(root, 'ignored')], () => {});
  assert.ok(child.some(x => x.workspace.path.endsWith('/ignored/child') && x.sessions.length === 1));
  t.mock.method(SessionManager, 'listAll', async () => { throw new Error('discovery unavailable'); });
  await assert.rejects(supervisor.syncWorkspaces([]), /discovery unavailable/);
  assert.ok((await supervisor.listWorkspaces()).workspaces.length > 0);
  assert.ok((await supervisor.listSessions()).sessions.length > 0);
});
