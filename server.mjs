import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';
import { createStore, randomId } from './storage.mjs';
import { adminRequest, builder, clientRequest, empty, login, messagePage } from './views.mjs';

const day = 86_400_000;
const mb = 1_048_576;
const formLimit = 32 * 1024;
const adminPath = /^\/admin\/([\w-]{16})(?:\/(download|close|delete))?$/;
const clientPath = /^\/r\/([\w-]{43})(?:\/([\w-]{16}))?$/;
const contentTypes = { '/style.css': 'text/css; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8' };
const hash = (value) => createHash('sha256').update(value).digest();
const now = () => Date.now();

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function respond(response, status, body, type = 'text/html; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type });
  response.end(body);
}

function redirect(response, path) {
  response.writeHead(303, { Location: path }).end();
}

async function readForm(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
    throw new RequestError(415, 'Unsupported form format.');
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > formLimit) {
      request.resume();
      throw new RequestError(413, 'This form is too large.');
    }
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function parseChecklist(fields) {
  const title = (fields.get('title') || '').trim();
  const message = (fields.get('message') || '').trim();
  const labels = fields.getAll('label');
  const notes = fields.getAll('details');
  const quantities = fields.getAll('required');
  const items = labels.slice(0, 20).map((label, i) => ({
    label: label.trim(), details: (notes[i] ?? '').trim(), required: Number(quantities[i])
  }));
  const valid = title && title.length <= 100 && message.length <= 600 &&
    labels.length > 0 && labels.length <= 20 && labels.length === notes.length &&
    labels.length === quantities.length && items.every(({ label, details, required }) =>
      label && label.length <= 90 && details.length <= 260 &&
      Number.isInteger(required) && required >= 1 && required <= 12);
  return { data: { title, message, items }, valid };
}

function cleanName(value) {
  let text = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_');
  while (Buffer.byteLength(text) > 140) text = text.slice(0, -1).toWellFormed();
  return text.replace(/^[.\s]+|[.\s]+$/g, '');
}

function uploadName(header) {
  if (typeof header !== 'string' || header.length > 2500) return '';
  try {
    return cleanName(decodeURIComponent(header));
  } catch {
    return '';
  }
}

function readConfig(options) {
  const origin = new URL(options.origin);
  if (origin.href !== origin.origin + '/' || !['https:', 'http:'].includes(origin.protocol) ||
      (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('FILE_REQUEST_ORIGIN must be an HTTPS origin, or a localhost HTTP origin for testing.');
  }
  if (!options.password || options.password.length < 16 || options.password.length > 200) {
    throw new Error('Set FILE_REQUEST_PASSWORD to a strong password between 16 and 200 characters.');
  }
  const maxMb = Number(options.maxMb ?? 25);
  const storageMb = Number(options.storageMb ?? 2048);
  if (!Number.isInteger(maxMb) || maxMb < 1 || maxMb > 100 ||
      !Number.isInteger(storageMb) || storageMb < maxMb || storageMb > 100_000) {
    throw new Error('Set FILE_REQUEST_MAX_MB between 1 and 100 and FILE_REQUEST_STORAGE_MB between that value and 100000.');
  }
  return { origin, maxMb, storageBytes: storageMb * mb };
}

export function createApp(options) {
  const { origin, maxMb, storageBytes } = readConfig(options);
  const store = createStore(options.dataDir);
  const password = hash(options.password);
  const key = randomBytes(32);
  const secure = origin.protocol === 'https:';
  const cookieName = secure ? '__Host-request_session' : 'request_session';
  const cookieBase = '; Path=/; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
  const signature = (payload) => createHmac('sha256', key).update(payload).digest('base64url');
  const reservations = new Map();
  const downloads = new Set();
  let reservedBytes = 0;
  let activeUploads = 0;
  let attempts = 0;
  let windowEnd = 0;

  function session(response) {
    const payload = (now() + 12 * 3_600_000) + '.' + randomId(16);
    response.setHeader('Set-Cookie', cookieName + '=' + payload + '.' + signature(payload) + cookieBase + '; Max-Age=43200');
  }

  function isSignedIn(request) {
    const cookie = request.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(cookieName + '='));
    const value = cookie?.slice(cookieName.length + 1);
    const parts = value?.match(/^(\d{13})\.([\w-]{22})\.([\w-]{43})$/);
    return Boolean(parts && Number(parts[1]) > now() &&
      timingSafeEqual(Buffer.from(parts[3]), Buffer.from(signature(parts[1] + '.' + parts[2]))));
  }

  async function download(response, request) {
    const files = request.items.flatMap((item, index) =>
      item.files.map((file, sequence) => ({
        path: join(store.filesDir, file.id),
        name: (index + 1) + '-' + cleanName(item.label) + '/' + (sequence + 1) + '-' + file.filename
      })));
    if (!files.length) throw new RequestError(404, 'No files have been uploaded yet.');
    if (downloads.has(request.id)) throw new RequestError(409, 'A download is already in progress for this request.');
    downloads.add(request.id);
    try {
      const zip = new ZipFile();
      zip.on('error', (error) => zip.outputStream.destroy(error));
      const stream = pipeline(zip.outputStream, response);
      try {
        response.setHeader('Content-Type', 'application/zip');
        response.setHeader('Content-Disposition', 'attachment; filename="request-files.zip"');
        for (const file of files) zip.addFile(file.path, file.name, { compress: false });
        zip.end();
      } catch (error) {
        zip.outputStream.destroy(error);
      }
      await stream;
    } finally {
      downloads.delete(request.id);
    }
  }

  async function saveUpload(request, response, token, itemId) {
    const item = store.uploadItem(token, itemId);
    if (!item || item.closed || item.expires <= now()) throw new RequestError(410, 'This upload link is closed.');
    const filename = uploadName(request.headers['x-upload-name']);
    if (!filename) throw new RequestError(400, 'This file needs a valid name.');
    if (request.headers['content-type'] !== 'application/octet-stream') {
      throw new RequestError(415, 'This upload format is unsupported.');
    }
    const maxBytes = maxMb * mb;
    const declared = request.headers['content-length'];
    const expected = declared === undefined ? maxBytes : Number(declared);
    if (!Number.isSafeInteger(expected) || expected < 1 || expected > maxBytes) {
      throw new RequestError(413, 'Choose a nonempty file up to ' + maxMb + ' MB.');
    }
    const pending = reservations.get(itemId) ?? 0;
    if (item.count + pending >= item.required) {
      throw new RequestError(409, 'This item has enough files or an upload is in progress. Refresh for its current status.');
    }
    if (activeUploads >= 4) throw new RequestError(429, 'The server is busy. Try again in a moment.');
    if (store.usedBytes() + reservedBytes + expected > storageBytes) {
      throw new RequestError(507, 'The workspace is out of upload space. Contact the person who sent the link.');
    }

    reservations.set(itemId, pending + 1);
    activeUploads += 1;
    reservedBytes += expected;
    const id = randomId(16);
    const path = join(store.filesDir, id);
    const partial = path + '.part';
    let bytes = 0;
    try {
      const limit = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          callback(bytes > expected ? new RequestError(413, 'This file exceeds the upload limit.') : null, chunk);
        }
      });
      await pipeline(request, limit, createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
      if (!bytes || (declared !== undefined && bytes !== expected)) {
        throw new RequestError(400, 'The file was empty or the upload was interrupted.');
      }
      const current = store.uploadItem(token, itemId);
      if (!current || current.closed || current.expires <= now()) throw new RequestError(410, 'This upload link is closed.');
      if (current.count >= current.required) throw new RequestError(409, 'This checklist item is already complete.');
      renameSync(partial, path);
      try {
        store.addFile(id, itemId, filename, bytes, now());
      } catch (error) {
        rmSync(path, { force: true });
        throw error;
      }
      respond(response, 201, JSON.stringify({ count: current.count + 1 }), 'application/json; charset=utf-8');
    } finally {
      reservations.set(itemId, reservations.get(itemId) - 1);
      if (!reservations.get(itemId)) reservations.delete(itemId);
      activeUploads -= 1;
      reservedBytes -= expected;
      rmSync(partial, { force: true });
    }
  }

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');

    const method = request.method;
    const { pathname, searchParams } = new URL(request.url, origin);
    const publicRoute = pathname.match(clientPath);
    const json = method === 'PUT' && Boolean(publicRoute);
    try {
      if (['POST', 'PUT'].includes(method) && request.headers.origin !== origin.origin) {
        throw new RequestError(403, 'This request came from another site.');
      }
      if (method === 'GET' && Object.hasOwn(contentTypes, pathname)) {
        const asset = await readFile(new URL('.' + pathname, import.meta.url));
        return respond(response, 200, asset, contentTypes[pathname]);
      }
      if (method === 'GET' && pathname === '/health') return respond(response, 200, 'OK', 'text/plain');
      if (method === 'GET' && pathname === '/') return redirect(response, '/admin');
      if (method === 'GET' && pathname === '/login') {
        return isSignedIn(request) ? redirect(response, '/admin') : respond(response, 200, login());
      }
      if (method === 'POST' && pathname === '/login') {
        if (now() >= windowEnd) {
          windowEnd = now() + 15 * 60_000;
          attempts = 0;
        }
        if (attempts >= 20) return respond(response, 429, login('Too many attempts. Wait 15 minutes before trying again.'));
        const entered = (await readForm(request)).get('password') ?? '';
        if (!timingSafeEqual(hash(entered), password)) {
          attempts += 1;
          return respond(response, 401, login('The password was incorrect.'));
        }
        attempts = 0;
        session(response);
        return redirect(response, '/admin');
      }
      if (method === 'POST' && pathname === '/logout') {
        response.setHeader('Set-Cookie', cookieName + '=' + cookieBase + '; Max-Age=0');
        return redirect(response, '/login');
      }
      if (publicRoute) {
        const [, token, itemId] = publicRoute;
        if (method === 'PUT' && itemId) return await saveUpload(request, response, token, itemId);
        if (method === 'GET' && !itemId) {
          const project = store.public(token);
          if (!project || project.closed || project.expires <= now()) {
            throw new RequestError(410, 'Ask the sender for a new upload link.');
          }
          return respond(response, 200, clientRequest(project, maxMb));
        }
      }
      const adminRoute = pathname.match(adminPath);
      if (pathname === '/admin' || pathname === '/admin/new' || adminRoute) {
        if (!isSignedIn(request)) return redirect(response, '/login');
        if (method === 'GET' && pathname === '/admin') {
          const requests = store.list();
          return requests.length ? redirect(response, '/admin/' + requests[0].id) : respond(response, 200, empty(requests));
        }
        if (pathname === '/admin/new') {
          if (method === 'GET') return respond(response, 200, builder(store.list(), store.admin(searchParams.get('copy') ?? '')));
          if (method === 'POST') {
            const { data, valid } = parseChecklist(await readForm(request));
            if (!valid) return respond(response, 422, builder(store.list(), null, 'Check the request title and enter valid names and file counts for every item.', data));
            return redirect(response, '/admin/' + store.create(data, now(), 30 * day));
          }
        }
        if (adminRoute) {
          const [, id, action] = adminRoute;
          const project = store.admin(id);
          if (!project) throw new RequestError(404, 'This file request could not be found.');
          if (method === 'GET' && !action) {
            return respond(response, 200, adminRequest(store.list(), project, new URL('/r/' + project.token, origin).href, now()));
          }
          if (method === 'GET' && action === 'download') return await download(response, project);
          if (method === 'POST' && action === 'close') {
            store.close(id);
            return redirect(response, '/admin/' + id);
          }
          if (method === 'POST' && action === 'delete') {
            if (downloads.has(id)) throw new RequestError(409, 'Wait for the current download to finish before deleting this request.');
            store.delete(project);
            return redirect(response, '/admin');
          }
        }
      }
      throw new RequestError(404, 'This page could not be found.');
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      const status = error instanceof RequestError ? error.status : 500;
      const message = status === 500 ? 'Something went wrong. Try again.' : error.message;
      if (status === 500) console.error('Request failed:', error.code ?? error.name);
      if (json) return respond(response, status, JSON.stringify({ error: message }), 'application/json; charset=utf-8');
      return respond(response, status, messagePage(status === 410 ? 'Upload link closed' : 'Unable to continue', message));
    }
  }

  return { handle, shutdown: store.shutdown };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const port = Number(process.env.PORT ?? 3000);
  const app = createApp({
    password: process.env.FILE_REQUEST_PASSWORD,
    origin: process.env.FILE_REQUEST_ORIGIN ?? 'http://localhost:' + port,
    dataDir: process.env.FILE_REQUEST_DATA ?? resolve('data'),
    maxMb: process.env.FILE_REQUEST_MAX_MB,
    storageMb: process.env.FILE_REQUEST_STORAGE_MB
  });
  const bind = process.env.FILE_REQUEST_BIND ?? '127.0.0.1';
  const server = createServer({ requestTimeout: 180_000, headersTimeout: 15_000 }, (request, response) => {
    app.handle(request, response).catch(() => response.destroy());
  });
  server.listen(port, bind, () => console.log('Request Checklist listening on ' + bind + ':' + port));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => server.close(() => app.shutdown()));
  }
}
