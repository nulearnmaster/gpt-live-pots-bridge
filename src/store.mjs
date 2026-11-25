import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { ownerPreset } from './policy.mjs';

const jobsDDL = `CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, session TEXT NOT NULL, delegation TEXT NOT NULL, preset TEXT NOT NULL,
  excerpt TEXT NOT NULL, created INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
  wake_recorded INTEGER NOT NULL DEFAULT 0, delivery_recorded INTEGER NOT NULL DEFAULT 0,
  summary TEXT, link TEXT, finished INTEGER, route TEXT, turn_end INTEGER,
  UNIQUE (session, delegation), CHECK ((route IS NULL) = (turn_end IS NULL)),
  CHECK ((preset='owner-context') = (route IS NOT NULL)), CHECK (turn_end IS NULL OR turn_end >= 0)
) STRICT;`;
const jobColumnsV1 = 'id, session, delegation, preset, excerpt, created, state, wake_recorded, delivery_recorded, summary, link, finished';

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
      ) STRICT;`);
    const jobColumns = this.db.prepare('PRAGMA table_info(jobs)').all();
    if (jobColumns.length && !jobColumns.some(({ name }) => name === 'route')) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`ALTER TABLE jobs RENAME TO jobs_v1; ${jobsDDL}
          INSERT INTO jobs (${jobColumnsV1}) SELECT ${jobColumnsV1} FROM jobs_v1;
          DROP TABLE jobs_v1;`);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } else this.db.exec(jobsDDL);
    this.db.exec(`CREATE INDEX IF NOT EXISTS jobs_pending ON jobs (wake_recorded, delivery_recorded, created);
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_once_preset ON jobs (session, preset) WHERE route IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_once_turn ON jobs (session, turn_end) WHERE route IS NOT NULL;
      CREATE INDEX IF NOT EXISTS jobs_owner_open ON jobs (route, state) WHERE route IS NOT NULL;`);
    if (!this.db.prepare('PRAGMA table_info(calls)').all().some(({ name }) => name === 'transport')) {
      this.db.exec("ALTER TABLE calls ADD COLUMN transport TEXT NOT NULL DEFAULT 'sip' CHECK (transport IN ('sip', 'webrtc'))");
    }
  }
  reserve(session, delivery, now) {
    return !!this.db.prepare('INSERT OR IGNORE INTO calls (session, delivery, created) VALUES (?, ?, ?)').run(session, delivery, now).changes;
  }
  reserveWeb(attempt, now, invitationCooldown = true) {
    return !!this.db.prepare(`INSERT INTO calls (session, delivery, created, transport)
      SELECT ?, ?, ?, 'webrtc' WHERE NOT EXISTS (SELECT 1 FROM calls WHERE
        (transport='webrtc' AND (closed=0 OR (?=1 AND created >= ?))) OR (closed=0 AND created >= ?))`)
      .run(attempt, attempt, now, Number(invitationCooldown), now - 30_000, now - 3 * 3600_000).changes;
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
  queue(session, delegation, { preset, excerpt, route = null, turnEnd = null }, now) {
    // Autocommit completes under synchronous=FULL before an acceptance is sent.
    const id = randomUUID();
    const row = this.db.prepare(`INSERT INTO jobs (id, session, delegation, preset, excerpt, created, route, turn_end)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ? IS NULL OR
        (SELECT COUNT(*) FROM jobs WHERE route=? AND state IN ('queued','claimed')) < 8
      ON CONFLICT DO NOTHING RETURNING id`).get(id, session, delegation, preset, excerpt, now, route, turnEnd, route, route);
    if (row) return { accepted: true, id };
    if (this.db.prepare('SELECT 1 FROM jobs WHERE session=? AND delegation=?').get(session, delegation)) return null;
    return { accepted: false };
  }
  claim(id) {
    const row = this.db.prepare(`UPDATE jobs SET state='claimed', wake_recorded=1
      WHERE id=? AND state='queued' RETURNING id, preset, CASE WHEN route IS NOT NULL THEN excerpt END AS request`).get(id);
    return !row ? null : row.request === null ? { id: row.id, preset: row.preset } : row;
  }
  finish(id, result, now, failed = false, spoken = false) {
    return this.db.prepare(`UPDATE jobs SET state=?, wake_recorded=1, summary=?, link=?, finished=?, excerpt=CASE WHEN route IS NULL THEN excerpt ELSE '' END
      WHERE id=? AND (?=0 OR preset=?) AND (state='claimed' OR (?=1 AND state='queued'))
      RETURNING id, session, delegation, state, route`)
      .get(failed ? 'failed' : 'done', result.summary, result.link, now, id, Number(spoken), ownerPreset, Number(failed)) ?? null;
  }
  pending() {
    return {
      wakes: this.db.prepare(`SELECT id, preset, route FROM jobs WHERE state='queued' AND wake_recorded=0 ORDER BY created LIMIT 20`).all(),
      deliveries: this.db.prepare(`SELECT id, preset, CASE WHEN route IS NULL THEN excerpt END AS excerpt, state, summary, link, route FROM jobs
        WHERE state IN ('done','failed') AND delivery_recorded=0 ORDER BY finished LIMIT 20`).all(),
    };
  }
  markWake(id) { return !!this.db.prepare('UPDATE jobs SET wake_recorded=1 WHERE id=?').run(id).changes; }
  markDelivery(id) {
    return !!this.db.prepare(`UPDATE jobs SET delivery_recorded=1 WHERE id=? AND state IN ('done','failed')`).run(id).changes;
  }
  list() {
    return this.db.prepare(`SELECT id, preset, CASE WHEN route IS NULL THEN excerpt END AS excerpt, state, created, finished, wake_recorded,
      delivery_recorded FROM jobs ORDER BY created DESC LIMIT 100`).all();
  }
  purge(now) {
    this.db.prepare("DELETE FROM calls WHERE created < ? AND (closed=1 OR transport='sip')").run(now - 7 * 86400000);
    this.db.prepare('DELETE FROM jobs WHERE delivery_recorded=1 AND finished < ?').run(now - 30 * 86400000);
  }
  close() { this.db.close(); }
}
