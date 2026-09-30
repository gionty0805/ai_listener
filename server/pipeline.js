// 요약 파이프라인
//
//  녹음 중 ──(전사 라인 누적)──▶ 닫힌 청크 감지 ──▶ 청크 중간노트(map) 생성  ← 라이브 노트
//  종료 시 ──▶ 남은 라인으로 마지막 청크 ──▶
//      전사문 ≤ SINGLE_PASS_MAX_CHARS : 전체 원문으로 최종 요약 1회 (정확도 최우선)
//      전사문 >  SINGLE_PASS_MAX_CHARS : 청크 노트들을 합쳐 최종 요약(reduce)
//  ──▶ 결과 저장 ──▶ (설정 시) 이메일/웹훅 자동 발송 ──▶ 원본 음성 삭제(기본)
import { planChunks, overlapContext, transcriptChars, formatTime } from './chunker.js';

export class Pipeline {
  constructor({ store, summarizer, config, notifier, log = console }) {
    this.store = store;
    this.summarizer = summarizer;
    this.config = config;
    this.notifier = notifier;
    this.log = log;
    this.running = new Map(); // 세션별 진행 중 작업 (중복 실행 방지)
  }

  // 세션 단위 작업 직렬화
  #enqueue(id, fn) {
    const prev = this.running.get(id) || Promise.resolve();
    const next = prev.then(fn).catch((e) => this.log.error(`[pipeline:${id}]`, e));
    this.running.set(id, next);
    next.finally(() => { if (this.running.get(id) === next) this.running.delete(id); });
    return next;
  }

  idle(id) {
    return this.running.get(id) || Promise.resolve();
  }

  // 전사 라인이 추가될 때마다 호출 — 닫힌 청크가 있으면 중간노트 생성
  onTranscript(id) {
    if (!this.config.chunk.liveNotes) return Promise.resolve();
    return this.#enqueue(id, () => this.#processChunks(id, false));
  }

  finish(id) {
    return this.#enqueue(id, async () => {
      try {
        await this.#finalize(id);
      } catch (err) {
        this.log.error(`[pipeline:${id}] 요약 실패`, err);
        await this.store.update(id, (s) => {
          s.status = 'error';
          s.error = err.message || String(err);
        });
      }
    });
  }

  async #processChunks(id, final) {
    const session = await this.store.get(id);
    if (!session) return;
    const lines = await this.store.transcript(id);
    const doneTo = session.chunks.length ? session.chunks.at(-1).lineTo : 0;
    const planned = planChunks(lines, doneTo, this.config.chunk, final);
    for (const p of planned) {
      const chunk = { ...p, index: session.chunks.length };
      const slice = lines.slice(p.lineFrom, p.lineTo);
      const prev = overlapContext(lines, p.lineFrom);
      const t0 = Date.now();
      const res = await this.#retry(() => this.summarizer.summarizeChunk(session, this.config.timezone, chunk, slice, prev));
      const saved = {
        index: chunk.index,
        lineFrom: p.lineFrom,
        lineTo: p.lineTo,
        startMs: p.startMs,
        endMs: p.endMs,
        range: `${formatTime(p.startMs)}~${formatTime(p.endMs)}`,
        notes: res.data,
        usage: res.usage,
        ms: Date.now() - t0,
      };
      session.chunks.push(saved);
      await this.store.update(id, (s) => {
        s.chunks = session.chunks;
      });
      this.log.info?.(`[pipeline:${id}] chunk ${saved.index + 1} (${saved.range}) 완료`);
    }
  }

  async #finalize(id) {
    const lines = await this.store.transcript(id);
    await this.store.update(id, (s) => {
      s.status = 'summarizing';
      s.error = null;
    });
    if (!lines.length) {
      await this.store.update(id, (s) => {
        s.status = 'error';
        s.error = '전사된 내용이 없습니다. 마이크 권한과 음성인식 설정을 확인하세요.';
      });
      return;
    }

    const chars = transcriptChars(lines);
    const singlePass = chars <= this.config.chunk.singlePassMaxChars;
    // 단일 패스라도 라이브 노트를 켜 둔 경우 나머지 구간 노트를 채워 기록을 완결
    if (!singlePass || this.config.chunk.liveNotes) await this.#processChunks(id, true);

    const session = await this.store.get(id);
    const input = singlePass
      ? { lines, allLines: lines }
      : { lines: null, chunkNotes: session.chunks, allLines: lines };

    const t0 = Date.now();
    const res = await this.#retry(() => this.summarizer.summarizeFinal(session, this.config.timezone, input));
    const updated = await this.store.update(id, (s) => {
      s.status = 'done';
      s.summary = res.data;
      s.summaryMeta = {
        engine: this.summarizer.name,
        model: res.model,
        strategy: singlePass ? 'single-pass' : 'map-reduce',
        chunks: s.chunks.length,
        transcriptLines: lines.length,
        transcriptChars: chars,
        usage: res.usage,
        ms: Date.now() - t0,
        at: new Date().toISOString(),
      };
    });

    if (!this.config.stt.keepAudio) await this.store.deleteAudio(id).catch(() => {});
    await this.notifier?.auto(updated).catch((e) => this.log.error(`[pipeline:${id}] 자동 알림 실패`, e));
  }

  async #retry(fn, attempts = 2) {
    let last;
    for (let i = 0; i <= attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        if (!err.retryable || i === attempts) throw err;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
      }
    }
    throw last;
  }
}
