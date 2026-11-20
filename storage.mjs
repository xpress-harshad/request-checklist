import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const randomId = (size = 12) => randomBytes(size).toString('base64url');

export function createStore(dataDir) {
  const filesDir = join(dataDir, 'files');
  mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'requests.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, title TEXT NOT NULL, message TEXT NOT NULL,
      created INTEGER NOT NULL, expires INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, label TEXT NOT NULL, details TEXT NOT NULL, required INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, bytes INTEGER NOT NULL, received INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS request_items ON items(request_id);
    CREATE INDEX IF NOT EXISTS item_files ON files(item_id);
  `);
  const storedFiles = new Set(db.prepare('SELECT id FROM files').all().map(({ id }) => id));
  for (const name of readdirSync(filesDir)) {
    if (/^[\w-]{22}(?:\.part)?$/.test(name) && !storedFiles.has(name)) {
      rmSync(join(filesDir, name), { force: true });
    }
  }
  const getId = db.prepare('SELECT * FROM requests WHERE id = ?');
  const getToken = db.prepare('SELECT * FROM requests WHERE token = ?');
  const getItems = db.prepare('SELECT * FROM items WHERE request_id = ? ORDER BY position');
  const getFiles = db.prepare('SELECT * FROM files WHERE item_id = ? ORDER BY received, id');
  const getCounts = db.prepare(`
    SELECT i.*, COUNT(f.id) AS count FROM items i LEFT JOIN files f ON f.item_id = i.id
    WHERE i.request_id = ? GROUP BY i.id ORDER BY i.position
  `);
  const list = db.prepare(`
    SELECT r.id, r.title, COUNT(i.id) AS items,
      SUM((SELECT COUNT(*) FROM files f WHERE f.item_id = i.id) >= i.required) AS completed
    FROM requests r JOIN items i ON i.request_id = r.id
    GROUP BY r.id ORDER BY r.created DESC, r.id
  `);
  const putRequest = db.prepare(
    'INSERT INTO requests (id, token, title, message, created, expires) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const putItem = db.prepare(
    'INSERT INTO items (id, request_id, position, label, details, required) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const getUpload = db.prepare(`
    SELECT r.id AS request_id, r.closed, r.expires, i.required,
      (SELECT COUNT(*) FROM files f WHERE f.item_id = i.id) AS count
    FROM requests r JOIN items i ON i.request_id = r.id WHERE r.token = ? AND i.id = ?
  `);
  const getUsed = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM files');
  const putFile = db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?)');
  const close = db.prepare('UPDATE requests SET closed = 1 WHERE id = ?');
  const remove = db.prepare('DELETE FROM requests WHERE id = ?');
  return {
    filesDir,
    list: () => list.all(),
    admin(id) {
      const request = getId.get(id);
      if (!request) return;
      const items = getItems.all(id).map((item) => {
        const files = getFiles.all(item.id);
        return { ...item, files, count: files.length };
      });
      return { ...request, items };
    },
    public(token) {
      const request = getToken.get(token);
      if (request) return { ...request, items: getCounts.all(request.id) };
    },
    create({ title, message, items }, now, expiryMs) {
      const id = randomId();
      db.exec('BEGIN');
      try {
        putRequest.run(id, randomId(32), title, message, now, now + expiryMs);
        for (const [position, item] of items.entries()) {
          putItem.run(randomId(), id, position, item.label, item.details, item.required);
        }
        db.exec('COMMIT');
        return id;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    uploadItem: (token, item) => getUpload.get(token, item),
    usedBytes: () => getUsed.get().bytes,
    addFile: (id, item, filename, bytes, now) => putFile.run(id, item, filename, bytes, now),
    close: (id) => close.run(id),
    delete(request) {
      remove.run(request.id);
      for (const item of request.items) {
        for (const file of item.files) rmSync(join(filesDir, file.id), { force: true });
      }
    },
    shutdown: () => db.close()
  };
}
