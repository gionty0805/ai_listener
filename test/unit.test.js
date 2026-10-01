import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planChunks, overlapContext, formatTime, renderLines } from '../server/chunker.js';
import { validate, meetingSummarySchema, interviewSummarySchema, chunkNotesSchema } from '../server/schemas.js';
import { buildIcs, eventsFromMeeting } from '../server/ics.js';
import { finalUserPrompt, contextBlock } from '../server/prompts.js';
import { MockSummarizer } from '../server/summarizer.js';
import { toMarkdown, toShortText } from '../server/report.js';

const minute = 60_000;
const mkLines = (n, stepMs, text = '가나다라마바사') => Array.from({ length: n }, (_, i) => ({ t: i * stepMs, speaker: 'A', text }));

test('formatTime', () => {
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(65_000), '01:05');
  assert.equal(formatTime(3_725_000), '1:02:05');
});

test('planChunks: 녹음 중에는 시간 창이 닫힌 청크만 반환', () => {
  const lines = mkLines(25, minute); // 0~24분, 1분마다 한 줄
  const chunks = planChunks(lines, 0, { minutes: 10, maxChars: 1e9 });
  assert.equal(chunks.length, 2); // 0-9분, 10-19분 / 20-24분은 아직 열림
  assert.deepEqual(chunks.map((c) => [c.lineFrom, c.lineTo]), [[0, 10], [10, 20]]);
  const final = planChunks(lines, 20, { minutes: 10, maxChars: 1e9 }, true);
  assert.deepEqual(final.map((c) => [c.lineFrom, c.lineTo]), [[20, 25]]);
});

test('planChunks: 크기 기준 분할과 전체 커버리지', () => {
  const lines = mkLines(100, 1000, 'x'.repeat(88)); // 줄당 100자(+12)
  const chunks = planChunks(lines, 0, { minutes: 60, maxChars: 1000 }, true);
  assert.ok(chunks.length >= 10);
  assert.equal(chunks[0].lineFrom, 0);
  assert.equal(chunks.at(-1).lineTo, 100);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].lineFrom, chunks[i - 1].lineTo); // 누락·중복 없음
});

test('overlapContext', () => {
  const lines = mkLines(10, 1000);
  assert.equal(overlapContext(lines, 0).length, 0);
  assert.equal(overlapContext(lines, 8, 3).length, 3);
});

test('validate: 스키마 검증', () => {
  assert.deepEqual(validate(chunkNotesSchema, { summary: 's', topics: [], decisions: [], action_items: [], schedules: [], open_questions: [], notable_quotes: [] }), []);
  const errs = validate(interviewSummarySchema, { recommendation: '최고' });
  assert.ok(errs.some((e) => e.includes('누락')));
});

test('스키마: 모든 object 가 structured output 규칙(additionalProperties:false, 전 필드 required)을 지킴', () => {
  const walk = (s) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === 'array') walk(s.items);
  };
  [chunkNotesSchema, meetingSummarySchema, interviewSummarySchema].forEach(walk);
});

test('prompt: 기준 일시·요일과 전사문 태그 포함', () => {
  const session = { type: 'meeting', title: '주간회의', startedAt: '2026-09-30T01:00:00Z', participants: ['김', '이'], rubric: [] };
  const ctx = contextBlock(session, 'Asia/Seoul');
  assert.match(ctx, /2026-09-30 10:00/);
  assert.match(ctx, /수요일/);
  const p = finalUserPrompt(session, 'Asia/Seoul', { lines: mkLines(2, 1000) });
  assert.match(p, /<transcript>/);
  const p2 = finalUserPrompt(session, 'Asia/Seoul', { lines: null, chunkNotes: [{ index: 0, range: '00:00~10:00', notes: { summary: 'x' } }] });
  assert.match(p2, /<chunk_notes>/);
  assert.doesNotMatch(p2, /<transcript>/);
});

test('ics: 날짜 있는 일정/기한만 생성', () => {
  const session = {
    id: 'abc', type: 'meeting',
    summary: {
      schedules: [{ title: '배포, 1차', date: '2026-10-05', time: '14:00', description: '' }, { title: '미정', date: '', time: '', description: '' }],
      action_items: [{ task: '보고서 제출', owner: '김', due_date: '2026-10-02', due_text: '', priority: '높음' }],
    },
  };
  const ics = buildIcs(eventsFromMeeting(session));
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 2);
  assert.match(ics, /DTSTART;TZID=Asia\/Seoul:20261005T140000/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261002/);
  assert.match(ics, /SUMMARY:배포\\, 1차/);
  assert.equal(buildIcs([]), null);
});

test('mock 요약 → report 렌더링', async () => {
  const m = new MockSummarizer();
  const session = { id: 'x', type: 'meeting', title: 'T', startedAt: new Date().toISOString(), participants: [], rubric: [] };
  const lines = [
    { t: 0, speaker: '김', text: '다음 주 화요일까지 기획안 공유하겠습니다' },
    { t: 5000, speaker: '이', text: '출시일은 10월 말로 확정하기로 했습니다' },
  ];
  const { data } = await m.summarizeFinal(session, 'Asia/Seoul', { lines });
  assert.deepEqual(validate(meetingSummarySchema, data), []);
  session.summary = data;
  assert.match(toMarkdown(session), /## 할 일/);
  assert.match(toShortText(session), /결정 사항/);
  assert.match(renderLines(lines), /\[00:05\] 이:/);
});

test('RateLimiter: 윈도 내 한도 초과 시 대기 초 반환, 윈도 경과 후 초기화', async () => {
  const { RateLimiter } = await import('../server/ratelimit.js');
  const rl = new RateLimiter({ windowMs: 1000, max: 2 });
  assert.equal(rl.check('a', 0), 0);
  assert.equal(rl.check('a', 10), 0);
  assert.equal(rl.check('a', 20), 1);
  assert.equal(rl.check('b', 20), 0);
  assert.equal(rl.check('a', 1001), 0);
});
