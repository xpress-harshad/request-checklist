import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from './server.mjs';

async function start(dataDir) {
  let app;
  const server = createServer((request, response) => app.handle(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  app = createApp({ origin, dataDir, password: 'integration-test-password', maxMb: 1 });
  return {
    origin,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      app.shutdown();
    }
  };
}

async function signIn(origin) {
  const response = await fetch(origin + '/login', {
    method: 'POST', redirect: 'manual', headers: { Origin: origin },
    body: new URLSearchParams({ password: 'integration-test-password' })
  });
  assert.equal(response.status, 303);
  return response.headers.get('set-cookie').split(';')[0];
}

test('create, resume, privately export, close, and delete a file request', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'request-checklist-test-'));
  let app;
  try {
    app = await start(dataDir);
    const { origin } = app;
    const cookie = await signIn(origin);
    const body = new URLSearchParams([
      ['title', 'Spring collection <assets>'], ['message', 'For next week'],
      ['label', 'Product photos'], ['details', 'One per angle'], ['required', '2'],
      ['label', 'Product copy'], ['details', 'Approved version'], ['required', '1']
    ]);
    const form = (path, headers = {}) => fetch(origin + path, {
      method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: origin, ...headers }, body
    });
    assert.equal((await form('/admin/new', { Origin: 'https://elsewhere.example' })).status, 403);
    const created = await form('/admin/new');
    assert.equal(created.status, 303);

    const project = created.headers.get('location');
    const ownerPage = await (await fetch(origin + project, { headers: { Cookie: cookie } })).text();
    assert.match(ownerPage, /Spring collection &lt;assets&gt;/);
    const share = ownerPage.match(/\/r\/[\w-]{43}/)[0];
    const client = await (await fetch(origin + share)).text();
    const uploadPaths = [...client.matchAll(/action="(\/r\/[\w-]{43}\/[\w-]{16})"/g)].map((match) => match[1]);
    assert.equal(uploadPaths.length, 2);
    const upload = (index, name, data, site = origin) => fetch(origin + uploadPaths[index], {
      method: 'PUT', headers: {
        Origin: site, 'Content-Type': 'application/octet-stream', 'X-Upload-Name': encodeURIComponent(name)
      }, body: data
    });

    assert.equal((await upload(0, 'empty.txt', Buffer.alloc(0))).status, 413);
    assert.equal((await upload(0, 'oversized.txt', Buffer.alloc(1_048_577))).status, 413);
    assert.equal((await upload(0, 'cross-origin.txt', 'private', 'https://elsewhere.example')).status, 403);
    const first = await upload(0, '../../private-file.txt', 'first photo bytes');
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), { count: 1 });
    const again = await (await fetch(origin + share)).text();
    assert.match(again, /1\/2 files/);
    assert.doesNotMatch(again, /private-file|first photo bytes/);

    const second = await upload(0, 'side.txt', 'second photo bytes');
    assert.equal(second.status, 201);
    assert.equal((await upload(0, 'too-many.txt', 'excess')).status, 409);
    assert.equal((await upload(1, 'copy.txt', 'approved product description')).status, 201);
    assert.match(await (await fetch(origin + share)).text(), /2 of 2 items complete/);

    const duplicate = await (await fetch(origin + '/admin/new?copy=' + project.split('/').pop(),
      { headers: { Cookie: cookie } })).text();
    assert.match(duplicate, /value="Product photos"/);
    assert.doesNotMatch(duplicate, /private-file|side\.txt/);
    assert.equal((await fetch(origin + project + '/download', { redirect: 'manual' })).headers.get('location'), '/login');
    const exported = await fetch(origin + project + '/download', { headers: { Cookie: cookie } });
    assert.equal(exported.headers.get('content-type'), 'application/zip');
    const archive = Buffer.from(await exported.arrayBuffer());
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    assert.notEqual(archive.indexOf(Buffer.from('approved product description')), -1);
    assert.match(archive.toString(), /1-Product photos\/1-[_\.]*private-file\.txt/);

    await app.stop();
    app = await start(dataDir);
    const nextCookie = await signIn(app.origin);
    const publicProgress = await (await fetch(app.origin + share)).text();
    assert.match(publicProgress, /2 of 2 items complete/);
    const post = (suffix) => fetch(app.origin + project + suffix, {
      method: 'POST', redirect: 'manual', headers: { Origin: app.origin, Cookie: nextCookie }
    });
    assert.equal((await post('/close')).status, 303);
    assert.equal((await fetch(app.origin + share)).status, 410);
    assert.equal((await post('/delete')).status, 303);
    assert.deepEqual(await readdir(join(dataDir, 'files')), []);
  } finally {
    if (app) await app.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
