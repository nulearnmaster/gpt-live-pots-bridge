import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, openSync } from 'node:fs';

export class Store {
  constructor(path) {
    // The service uses its own dedicated, private state directory.
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const file = lstatSync(path);
    if (!file.isFile() || file.uid !== process.getuid() || file.mode & 0o077) throw Error('unsafe database');
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=750;
      CREATE TABLE IF NOT EXISTS calls (
        session TEXT PRIMARY KEY, delivery TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, delegation TEXT NOT NULL, preset TEXT NOT NULL,
        excerpt TEXT NOT NULL, created INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
        wake_recorded INTEGER NOT NULL DEFAULT 0, delivery_recorded INTEGER NOT NULL DEFAULT 0,
        summary TEXT, link TEXT, finished INTEGER,
        UNIQUE (session, delegation), UNIQUE (session, preset)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs (wake_recorded, delivery_recorded, created);`);
    if (!this.db.prepare('PRAGMA table_info(calls)').all().some(({ name }) => name === 'transport')) {
      this.db.exec("ALTER TABLE calls ADD COLUMN transport TEXT NOT NULL DEFAULT 'sip' CHECK (transport IN ('sip', 'webrtc'))");
    }
  }
  reserve(session, delivery, now) {
    return !!this.db.prepare('INSERT OR IGNORE INTO calls (session, delivery, created) VALUES (?, ?, ?)').run(session, delivery, now).changes;
  }
  reserveWeb(attempt, now) {
    return !!this.db.prepare(`INSERT INTO calls (session, delivery, created, transport)
      SELECT ?, ?, ?, 'webrtc' WHERE NOT EXISTS (SELECT 1 FROM calls WHERE
        (transport='webrtc' AND (closed=0 OR created >= ?)) OR (closed=0 AND created >= ?))`)
      .run(attempt, attempt, now, now - 30_000, now - 3 * 3600_000).changes;
  }
  bindWeb(attempt, session) {
    return !!this.db.prepare("UPDATE calls SET session=? WHERE session=? AND transport='webrtc' AND closed=0")
      .run(session, attempt).changes;
  }
  unclosed(now) {
    return this.db.prepare(`SELECT session, transport, session=delivery AS pending FROM calls
      WHERE closed=0 AND (transport='webrtc' OR created >= ?) ORDER BY transport DESC LIMIT 100`)
      .all(now - 3 * 3600_000);
  }
  endCall(session) { this.db.prepare('UPDATE calls SET closed=1 WHERE session=?').run(session); }
  queue(session, delegation, { preset, excerpt }, now) {
    // Autocommit completes under synchronous=FULL before an acceptance is sent.
    const id = randomUUID();
    const row = this.db.prepare(`INSERT INTO jobs (id, session, delegation, preset, excerpt, created)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`).get(id, session, delegation, preset, excerpt, now);
    if (row) return { accepted: true, id };
    if (this.db.prepare('SELECT 1 FROM jobs WHERE session=? AND delegation=?').get(session, delegation)) return null;
    return { accepted: false };
  }
  claim(id) {
    return this.db.prepare(`UPDATE jobs SET state='claimed', wake_recorded=1
      WHERE id=? AND state='queued' RETURNING id, preset`).get(id) ?? null;
  }
  finish(id, result, now, failed = false) {
    return this.db.prepare(`UPDATE jobs SET state=?, wake_recorded=1, summary=?, link=?, finished=?
      WHERE id=? AND (state='claimed' OR (?=1 AND state='queued')) RETURNING id, session, delegation, state`)
      .get(failed ? 'failed' : 'done', result.summary, result.link, now, id, Number(failed)) ?? null;
  }
  pending() {
    return {
      wakes: this.db.prepare(`SELECT id, preset FROM jobs WHERE state='queued' AND wake_recorded=0 ORDER BY created LIMIT 20`).all(),
      deliveries: this.db.prepare(`SELECT id, preset, excerpt, state, summary, link FROM jobs
        WHERE state IN ('done','failed') AND delivery_recorded=0 ORDER BY finished LIMIT 20`).all(),
    };
  }
  markWake(id) { return !!this.db.prepare('UPDATE jobs SET wake_recorded=1 WHERE id=?').run(id).changes; }
  markDelivery(id) {
    return !!this.db.prepare(`UPDATE jobs SET delivery_recorded=1 WHERE id=? AND state IN ('done','failed')`).run(id).changes;
  }
  list() {
    return this.db.prepare(`SELECT id, preset, excerpt, state, created, finished, wake_recorded,
      delivery_recorded FROM jobs ORDER BY created DESC LIMIT 100`).all();
  }
  purge(now) {
    this.db.prepare("DELETE FROM calls WHERE created < ? AND (closed=1 OR transport='sip')").run(now - 7 * 86400000);
    this.db.prepare('DELETE FROM jobs WHERE delivery_recorded=1 AND finished < ?').run(now - 30 * 86400000);
  }
  close() { this.db.close(); }
}
