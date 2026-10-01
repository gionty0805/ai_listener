import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { MockSummarizer } from '../server/summarizer.js';

let base, app, dir;
const hooks = [];
const quiet = { info() {}, error() {} };

// 청크 요약 호출 수를 세는 mock
class CountingSummarizer extends MockSummarizer {
  chunkCalls = 0;
  async summarizeChunk(...a) { this.chunkCalls++; return super.summarizeChunk(...a); }
}
const summarizer = new CountingSummarizer();

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ail-'));
  const config = loadConfig({
    DATA_DIR: dir, SUMMARIZER: 'mock', CHUNK_MINUTES: '10', APP_ACCESS_TOKEN: 'secret', RATE_LIMIT_COSTLY_PER_MINUTE: '1000',
    MAIL_ALLOWED_DOMAINS: 'example.com',
    WEBHOOK_URL: 'https://hooks.example.com/x', WEBHOOK_FORMAT: 'slack',
  });
  const fetchImpl = async (url, init) => { hooks.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  app = await createApp(config, { summarizer, fetch: fetchImpl, log: quiet });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await new Promise((r) => app.server.close(r));
  await fs.rm(dir, { recursive: true, force: true });
});

const call = async (p, { method = 'GET', body, token = 'secret' } = {}) => {
  const res = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json', 'x-access-token': token }, body: body && JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

async function waitFor(id, status) {
  for (let i = 0; i < 100; i++) {
    const { json } = await call(`/api/sessions/${id}`);
    if (json.status === status) return json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting ${status}`);
}

test('정적 파일 · 설정 · 인증', async () => {
  const html = await fetch(base + '/');
  assert.equal(html.status, 200);
  assert.match(await html.text(), /AI Listener/);
  assert.equal((await fetch(base + '/../package.json')).status, 404);
  assert.equal((await call('/api/config', { token: '' })).status, 200);
  assert.equal((await call('/api/sessions', { token: 'wrong' })).status, 401);
});

test('세션 생성 시 동의 필수', async () => {
  const r = await call('/api/sessions', { method: 'POST', body: { type: 'meeting', title: 'x' } });
  assert.equal(r.status, 400);
});

test('회의: 전사 업로드 → 라이브 청크 → 종료 → 요약 → 웹훅 → export', async () => {
  const { json: s } = await call('/api/sessions', {
    method: 'POST', body: { type: 'meeting', title: '주간 회의', participants: '김팀장, 이선임', consent: true },
  });
  assert.equal(s.status, 'recording');
  assert.deepEqual(s.participants, ['김팀장', '이선임']);

  // 25분 분량 (1분마다 발화)
  const lines = Array.from({ length: 25 }, (_, i) => ({ t: i * 60_000, speaker: i % 2 ? '이선임' : '김팀장', text: `안건 ${i} 논의` }));
  lines[3].text = '10월 5일까지 시안 공유하겠습니다';
  lines[7].text = '런칭은 10월 말로 확정하기로 했습니다';
  assert.equal((await call(`/api/sessions/${s.id}/transcript`, { method: 'POST', body: { lines } })).json.added, 25);
  await app.pipeline.idle(s.id);
  const mid = (await call(`/api/sessions/${s.id}`)).json;
  assert.equal(mid.chunks.length, 2, '녹음 중 닫힌 10분 구간 2개 중간요약');

  assert.equal((await call(`/api/sessions/${s.id}/finish`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await call(`/api/sessions/${s.id}/transcript`, { method: 'POST', body: { lines } })).status, 409);
  const done = await waitFor(s.id, 'done');
  assert.equal(done.chunks.length, 3);
  assert.equal(done.summaryMeta.strategy, 'single-pass');
  assert.ok(done.summary.decisions.length >= 1);
  assert.ok(done.summary.action_items.length >= 1);

  const n = await call(`/api/sessions/${s.id}/notify`, { method: 'POST', body: { webhook: true } });
  assert.equal(n.status, 200);
  assert.match(hooks.at(-1).body.text, /주간 회의/);

  const bad = await call(`/api/sessions/${s.id}/notify`, { method: 'POST', body: { email: { to: ['x@example.com'] } } });
  assert.equal(bad.status, 400); // SMTP 미설정

  const md = await call(`/api/sessions/${s.id}/export.md`);
  assert.match(md.json, /# \[회의록\]/);
});

test('장시간 회의: 단일 패스 한도를 넘으면 map-reduce', async () => {
  const config = loadConfig({ DATA_DIR: path.join(dir, 'long'), SUMMARIZER: 'mock', SINGLE_PASS_MAX_CHARS: '500', CHUNK_MAX_CHARS: '300', LIVE_NOTES: 'false' });
  const a = await createApp(config, { log: quiet });
  const s = await a.store.create({ type: 'meeting', title: '2시간 회의', consent: {} });
  await a.store.appendTranscript(s.id, Array.from({ length: 120 }, (_, i) => ({ t: i * 60_000, speaker: 'A', text: `발화 ${i} 입니다` })));
  await a.pipeline.finish(s.id);
  const done = await a.store.get(s.id);
  assert.equal(done.status, 'done');
  assert.equal(done.summaryMeta.strategy, 'map-reduce');
  assert.ok(done.chunks.length > 5);
  assert.equal(done.chunks.at(-1).lineTo, 120);
});

test('면접: 기본 평가 기준 적용 및 요약', async () => {
  const { json: s } = await call('/api/sessions', { method: 'POST', body: { type: 'interview', title: '1차 면접', consent: true } });
  assert.ok(s.rubric.length >= 5);
  await call(`/api/sessions/${s.id}/transcript`, {
    method: 'POST',
    body: { lines: [{ t: 0, speaker: '면접관', text: '최근 프로젝트를 소개해 주세요' }, { t: 4000, speaker: '지원자', text: '결제 시스템을 MSA로 전환했습니다' }] },
  });
  await call(`/api/sessions/${s.id}/finish`, { method: 'POST', body: {} });
  const done = await waitFor(s.id, 'done');
  assert.equal(done.summary.competencies.length, s.rubric.length);
  assert.equal(done.summary.qa_log[0].answer_summary, '결제 시스템을 MSA로 전환했습니다');
  assert.equal((await call(`/api/sessions/${s.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/sessions/${s.id}`)).status, 404);
});

test('빈 전사로 종료하면 오류 상태', async () => {
  const { json: s } = await call('/api/sessions', { method: 'POST', body: { type: 'meeting', consent: true } });
  await call(`/api/sessions/${s.id}/finish`, { method: 'POST', body: {} });
  const e = await waitFor(s.id, 'error');
  assert.match(e.error, /전사된 내용이 없습니다/);
});

test('보안: CSP·프레임 차단 헤더', async () => {
  const res = await fetch(base + '/');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('보안: CSRF — simple request Content-Type 거부', async () => {
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', '']) {
    const res = await fetch(base + '/api/sessions', {
      method: 'POST', headers: { 'x-access-token': 'secret', ...(ct ? { 'content-type': ct } : {}) },
      body: JSON.stringify({ type: 'meeting', consent: true }),
    });
    assert.equal(res.status, 415, ct || '(없음)');
  }
});

test('보안: 메일 수신 도메인 허용목록', async () => {
  const { json: s } = await call('/api/sessions', { method: 'POST', body: { type: 'meeting', consent: true } });
  await call(`/api/sessions/${s.id}/transcript`, { method: 'POST', body: { lines: [{ t: 0, text: '안녕하세요' }] } });
  await call(`/api/sessions/${s.id}/finish`, { method: 'POST', body: {} });
  await waitFor(s.id, 'done');
  const r = await app.notifier.sendEmail(await app.store.get(s.id), ['a@evil.com']).catch((e) => e);
  assert.equal(r.status, 403);
});

test('보안: Slack 멘션 주입 이스케이프', async () => {
  const { json: s } = await call('/api/sessions', { method: 'POST', body: { type: 'meeting', title: '<!channel> 공지', consent: true } });
  await call(`/api/sessions/${s.id}/transcript`, { method: 'POST', body: { lines: [{ t: 0, text: '<!here> 확인 부탁' }] } });
  await call(`/api/sessions/${s.id}/finish`, { method: 'POST', body: {} });
  await waitFor(s.id, 'done');
  await call(`/api/sessions/${s.id}/notify`, { method: 'POST', body: { webhook: true } });
  assert.doesNotMatch(hooks.at(-1).body.text, /<!/);
});

test('보안: 속도 제한과 세션당 전사 상한', async () => {
  const config = loadConfig({ DATA_DIR: path.join(dir, 'rl'), SUMMARIZER: 'mock', RATE_LIMIT_COSTLY_PER_MINUTE: '2', MAX_TRANSCRIPT_LINES: '3' });
  const a = await createApp(config, { log: quiet });
  await new Promise((r) => a.server.listen(0, r));
  const b = `http://127.0.0.1:${a.server.address().port}`;
  const post = (p, body) => fetch(b + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const statuses = [];
  let id;
  for (let i = 0; i < 3; i++) {
    const r = await post('/api/sessions', { type: 'meeting', consent: true });
    statuses.push(r.status);
    if (r.ok) id ??= (await r.json()).id;
  }
  assert.deepEqual(statuses, [200, 200, 429]);
  const line = (n) => Array.from({ length: n }, (_, i) => ({ t: i, text: 'x' }));
  assert.equal((await post(`/api/sessions/${id}/transcript`, { lines: line(3) })).status, 200);
  assert.equal((await post(`/api/sessions/${id}/transcript`, { lines: line(1) })).status, 413);
  await new Promise((r) => a.server.close(r));
});
