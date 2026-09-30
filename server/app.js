// HTTP 라우팅 (Node 내장 http, 외부 프레임워크 없음)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Pipeline } from './pipeline.js';
import { Notifier } from './notify.js';
import { WhisperStt } from './stt.js';
import { createSummarizer } from './summarizer.js';
import { toMarkdown } from './report.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};
const AUDIO_EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

export const DEFAULT_RUBRIC = ['직무 전문성', '문제 해결력', '커뮤니케이션', '협업', '학습·성장 태도', '직무 동기'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '요청 본문이 너무 큽니다.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 형식이 올바르지 않습니다.');
  }
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(status, {
    'content-type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

const strList = (v, max = 50) =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : [])
    .map((x) => String(x).trim()).filter(Boolean).slice(0, max).map((x) => x.slice(0, 200));

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function createApp(config, overrides = {}) {
  const store = overrides.store || new Store(config.dataDir);
  await store.init();
  const summarizer = overrides.summarizer || createSummarizer(config);
  const notifier = overrides.notifier || new Notifier({ config, store, fetchImpl: overrides.fetch });
  const stt = overrides.stt || new WhisperStt(config.stt, overrides.fetch);
  const log = overrides.log || console;
  const pipeline = new Pipeline({ store, summarizer, config, notifier, log });

  // 재시작 복구: 요약 도중 서버가 내려간 세션 재처리
  for (const s of await store.list()) if (s.status === 'summarizing') pipeline.finish(s.id);

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });

  const load = async (id) => {
    const s = await store.get(id);
    if (!s) throw new HttpError(404, '세션을 찾을 수 없습니다.');
    return s;
  };

  route('GET', '/api/config', async () => ({
    summarizer: summarizer.name,
    model: summarizer.name === 'claude' ? config.claude.model : 'mock',
    stt: { mode: stt.enabled ? 'whisper' : 'browser', segmentSeconds: config.stt.segmentSeconds },
    chunk: config.chunk,
    notify: notifier.status(),
    defaultRubric: DEFAULT_RUBRIC,
    authRequired: Boolean(config.accessToken),
  }));

  route('GET', '/api/sessions', async () => store.list());

  route('POST', '/api/sessions', async (req) => {
    const b = await readJson(req);
    const type = b.type === 'interview' ? 'interview' : b.type === 'meeting' ? 'meeting' : null;
    if (!type) throw new HttpError(400, 'type 은 meeting 또는 interview 여야 합니다.');
    if (b.consent !== true) throw new HttpError(400, '녹음 및 개인정보 처리에 대한 참석자 동의 확인이 필요합니다.');
    const rubric = type === 'interview' ? (strList(b.rubric, 12).length ? strList(b.rubric, 12) : DEFAULT_RUBRIC) : [];
    return store.create({
      type,
      title: String(b.title || '').trim().slice(0, 200) || (type === 'interview' ? '면접' : '회의'),
      participants: strList(b.participants),
      recipients: strList(b.recipients),
      rubric,
      jobDescription: String(b.jobDescription || '').slice(0, 5000),
      agenda: String(b.agenda || '').slice(0, 3000),
      consent: { agreed: true, at: new Date().toISOString() },
    });
  });

  route('GET', '/api/sessions/([a-f0-9]{16})', async (req, [id]) => {
    const s = await load(id);
    return { ...s, transcript: await store.transcript(id) };
  });

  route('DELETE', '/api/sessions/([a-f0-9]{16})', async (req, [id]) => {
    await load(id);
    await pipeline.idle(id);
    await store.remove(id);
    return { ok: true };
  });

  // 브라우저 음성인식 결과(확정 문장) 업로드
  route('POST', '/api/sessions/([a-f0-9]{16})/transcript', async (req, [id]) => {
    const s = await load(id);
    if (s.status !== 'recording') throw new HttpError(409, '녹음 중인 세션이 아닙니다.');
    const b = await readJson(req);
    const lines = (Array.isArray(b.lines) ? b.lines : [])
      .map((l) => ({
        t: Math.max(0, Math.round(Number(l.t) || 0)),
        speaker: String(l.speaker || '').slice(0, 50),
        text: String(l.text || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
        src: l.src === 'note' ? 'note' : 'browser',
      }))
      .filter((l) => l.text);
    if (!lines.length) return { added: 0 };
    await store.appendTranscript(id, lines);
    pipeline.onTranscript(id); // 비동기: 닫힌 청크가 있으면 중간 노트 생성
    return { added: lines.length };
  });

  // 녹음 세그먼트 업로드 (서버 STT 모드). 본문 = 오디오 바이너리
  route('POST', '/api/sessions/([a-f0-9]{16})/audio', async (req, [id], url) => {
    const s = await load(id);
    if (s.status !== 'recording' && s.status !== 'summarizing') throw new HttpError(409, '녹음 중인 세션이 아닙니다.');
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    const ext = AUDIO_EXT[mime];
    if (!ext) throw new HttpError(415, `지원하지 않는 오디오 형식: ${mime}`);
    const seq = Number(url.searchParams.get('seq'));
    const startMs = Number(url.searchParams.get('startMs'));
    const speaker = String(url.searchParams.get('speaker') || '').slice(0, 50);
    if (!Number.isInteger(seq) || seq < 0 || !Number.isFinite(startMs)) throw new HttpError(400, 'seq/startMs 가 필요합니다.');
    if (s.audioSegments.some((a) => a.seq === seq)) return { duplicate: true }; // 재전송 멱등 처리
    const buf = await readBody(req, 50 * 1024 * 1024);
    await store.saveAudio(id, seq, ext, buf);
    let added = 0;
    if (stt.enabled) {
      const segs = await stt.transcribe(buf, { mime, filename: `${seq}.${ext}` });
      const lines = segs.map((x) => ({ t: Math.round(startMs + x.offsetMs), speaker, text: x.text, src: 'whisper' }));
      if (lines.length) await store.appendTranscript(id, lines);
      added = lines.length;
    }
    await store.update(id, (x) => {
      x.audioSegments.push({ seq, startMs, bytes: buf.length, mime, lines: added });
    });
    if (added) pipeline.onTranscript(id);
    return { added };
  });

  route('POST', '/api/sessions/([a-f0-9]{16})/finish', async (req, [id]) => {
    const s = await load(id);
    if (s.status !== 'recording') throw new HttpError(409, '이미 종료된 세션입니다.');
    const b = await readJson(req);
    await store.update(id, (x) => {
      x.status = 'summarizing';
      x.endedAt = new Date().toISOString();
      if (b.durationMs) x.durationMs = Math.round(Number(b.durationMs) || 0);
    });
    pipeline.finish(id);
    return { ok: true, status: 'summarizing' };
  });

  route('POST', '/api/sessions/([a-f0-9]{16})/summarize', async (req, [id]) => {
    const s = await load(id);
    if (s.status === 'recording' || s.status === 'summarizing') throw new HttpError(409, '녹음/요약 진행 중에는 재요약할 수 없습니다.');
    await store.update(id, (x) => { x.status = 'summarizing'; });
    pipeline.finish(id);
    return { ok: true, status: 'summarizing' };
  });

  route('POST', '/api/sessions/([a-f0-9]{16})/notify', async (req, [id]) => {
    const s = await load(id);
    const b = await readJson(req);
    const result = {};
    if (b.email) result.email = await notifier.sendEmail(s, strList(b.email.to));
    if (b.webhook) result.webhook = await notifier.sendWebhook(s);
    if (!b.email && !b.webhook) throw new HttpError(400, 'email 또는 webhook 중 하나를 지정하세요.');
    return result;
  });

  route('GET', '/api/sessions/([a-f0-9]{16})/export\\.md', async (req, [id], url, res) => {
    const s = await load(id);
    if (!s.summary) throw new HttpError(409, '요약이 아직 완료되지 않았습니다.');
    send(res, 200, toMarkdown(s), {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${s.type}_${s.id}.md"`,
    });
    return undefined;
  });

  async function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.resolve(PUBLIC_DIR, `.${rel}`);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'forbidden');
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    } catch {
      send(res, 404, 'not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // 공통 보안 헤더. 마이크 사용은 동일 출처에서만 허용
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('permissions-policy', 'microphone=(self)');
    try {
      if (!url.pathname.startsWith('/api/')) return await serveStatic(req, res, url);
      if (config.accessToken && url.pathname !== '/api/config' && !safeEqual(req.headers['x-access-token'] || '', config.accessToken)) {
        throw new HttpError(401, '접근 코드가 필요합니다.');
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const out = await r.handler(req, m.slice(1), url, res);
        if (out !== undefined) send(res, 200, out);
        return;
      }
      throw new HttpError(404, 'API 경로를 찾을 수 없습니다.');
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error(err);
      if (!res.headersSent) send(res, status, { error: status >= 500 && !err.status ? '서버 오류가 발생했습니다.' : err.message });
    }
  });

  return { server, store, pipeline, notifier };
}
