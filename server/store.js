// 파일 기반 세션 저장소 (MVP). 운영 확장 시 DB(PostgreSQL 등)로 교체한다.
//   data/sessions/<id>/session.json   메타데이터 + 요약 결과
//   data/sessions/<id>/transcript.json 전사 라인 배열
//   data/sessions/<id>/audio/<seq>.<ext>
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_RE = /^[a-f0-9]{16}$/;

export class Store {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'sessions');
    this.locks = new Map(); // 세션별 직렬화 (동시 쓰기 방지)
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
  }

  dir(id) {
    if (!ID_RE.test(id)) throw Object.assign(new Error('invalid session id'), { status: 400 });
    return path.join(this.root, id);
  }

  // 같은 세션에 대한 read-modify-write 를 순서대로 실행
  withLock(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(id, next.catch(() => {}));
    return next;
  }

  async create(data) {
    const id = crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();
    const session = {
      id,
      type: data.type,
      title: data.title,
      participants: data.participants || [],
      recipients: data.recipients || [],
      rubric: data.rubric || [],
      jobDescription: data.jobDescription || '',
      agenda: data.agenda || '',
      consent: data.consent,
      status: 'recording', // recording → summarizing → done | error
      createdAt: now,
      startedAt: now,
      endedAt: null,
      chunks: [], // { index, startMs, endMs, lineFrom, lineTo, notes, status }
      summary: null,
      summaryMeta: null,
      error: null,
      notifications: [],
      audioSegments: [],
    };
    await fs.mkdir(path.join(this.dir(id), 'audio'), { recursive: true });
    await this.#write(id, 'session.json', session);
    await this.#write(id, 'transcript.json', []);
    return session;
  }

  async get(id) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir(id), 'session.json'), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async list() {
    const ids = await fs.readdir(this.root).catch(() => []);
    const all = await Promise.all(ids.filter((i) => ID_RE.test(i)).map((i) => this.get(i)));
    return all
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ id, type, title, status, createdAt, endedAt }) => ({ id, type, title, status, createdAt, endedAt }));
  }

  update(id, mutator) {
    return this.withLock(id, async () => {
      const s = await this.get(id);
      if (!s) throw Object.assign(new Error('session not found'), { status: 404 });
      const next = (await mutator(s)) || s;
      await this.#write(id, 'session.json', next);
      return next;
    });
  }

  async transcript(id) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir(id), 'transcript.json'), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  appendTranscript(id, lines) {
    return this.withLock(id, async () => {
      const all = await this.transcript(id);
      all.push(...lines);
      // 오디오 세그먼트 STT 결과가 늦게 도착할 수 있으므로 시간순 정렬 유지
      all.sort((a, b) => a.t - b.t);
      await this.#write(id, 'transcript.json', all);
      return all;
    });
  }

  async saveAudio(id, seq, ext, buf) {
    const file = path.join(this.dir(id), 'audio', `${String(seq).padStart(4, '0')}.${ext}`);
    await fs.writeFile(file, buf);
    return file;
  }

  async deleteAudio(id) {
    await fs.rm(path.join(this.dir(id), 'audio'), { recursive: true, force: true });
  }

  async remove(id) {
    await fs.rm(this.dir(id), { recursive: true, force: true });
  }

  async #write(id, name, obj) {
    const file = path.join(this.dir(id), name);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fs.rename(tmp, file); // 원자적 교체
  }
}
