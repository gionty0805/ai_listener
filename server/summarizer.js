// 요약 엔진: Claude(운영) / mock(키 없이 데모·테스트)
import {
  SYSTEM_CHUNK, SYSTEM_MEETING, SYSTEM_INTERVIEW, chunkUserPrompt, finalUserPrompt,
} from './prompts.js';
import {
  chunkNotesSchema, meetingSummarySchema, interviewSummarySchema, validate,
} from './schemas.js';
import { formatTime } from './chunker.js';

export class SummaryError extends Error {
  constructor(message, { retryable = false, cause } = {}) {
    super(message, { cause });
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------- Claude
export class ClaudeSummarizer {
  constructor(cfg) {
    this.cfg = cfg;
    this.name = 'claude';
    this.clientPromise = null;
  }

  async #client() {
    // SDK 는 운영 배포 시에만 필요하므로 지연 로딩
    this.clientPromise ??= import('@anthropic-ai/sdk').then(({ default: Anthropic }) => ({
      Anthropic,
      client: new Anthropic({ maxRetries: 3 }), // 429/5xx/연결오류 자동 재시도
    }));
    return this.clientPromise;
  }

  async #structured({ system, prompt, schema, effort, maxTokens }) {
    const { Anthropic, client } = await this.#client();
    const params = {
      model: this.cfg.model,
      max_tokens: maxTokens,
      // 고정 system 프롬프트는 캐시 → 청크마다 반복 호출 시 비용·지연 절감
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort, format: { type: 'json_schema', schema } },
    };
    let message;
    try {
      // 긴 입력/출력 → 스트리밍 + finalMessage() 로 HTTP 타임아웃 회피
      if (this.cfg.fallbacks) {
        // 안전 분류기 거절 시 서버가 권장 모델로 자동 재시도
        message = await client.beta.messages
          .stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          .finalMessage();
      } else {
        message = await client.messages.stream(params).finalMessage();
      }
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new SummaryError('요청 한도 초과(429). 잠시 후 재시도하세요.', { retryable: true, cause: err });
      if (err instanceof Anthropic.AuthenticationError) throw new SummaryError('Claude API 인증 실패. ANTHROPIC_API_KEY를 확인하세요.', { cause: err });
      if (err instanceof Anthropic.BadRequestError) throw new SummaryError(`잘못된 요청(400): ${err.message}`, { cause: err });
      if (err instanceof Anthropic.APIConnectionError) throw new SummaryError('Claude API 연결 실패', { retryable: true, cause: err });
      if (err instanceof Anthropic.APIError) throw new SummaryError(`Claude API 오류(${err.status}): ${err.message}`, { retryable: (err.status ?? 0) >= 500, cause: err });
      throw err;
    }

    if (message.stop_reason === 'refusal') {
      throw new SummaryError(`모델이 요청을 거절했습니다 (${message.stop_details?.category ?? 'unknown'}).`);
    }
    if (message.stop_reason === 'max_tokens') {
      throw new SummaryError('출력 한도(max_tokens)에 도달해 요약이 잘렸습니다.', { retryable: true });
    }
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new SummaryError('모델 출력 JSON 파싱 실패', { retryable: true, cause: err });
    }
    const errs = validate(schema, data);
    if (errs.length) throw new SummaryError(`출력 스키마 불일치: ${errs.slice(0, 3).join(', ')}`, { retryable: true });
    return { data, usage: message.usage, model: message.model };
  }

  summarizeChunk(session, tz, chunk, lines, prevContext) {
    return this.#structured({
      system: SYSTEM_CHUNK,
      prompt: chunkUserPrompt(session, tz, chunk, lines, prevContext),
      schema: chunkNotesSchema,
      effort: this.cfg.effortChunk,
      maxTokens: 16000,
    });
  }

  summarizeFinal(session, tz, input) {
    const interview = session.type === 'interview';
    return this.#structured({
      system: interview ? SYSTEM_INTERVIEW : SYSTEM_MEETING,
      prompt: finalUserPrompt(session, tz, input),
      schema: interview ? interviewSummarySchema : meetingSummarySchema,
      effort: this.cfg.effortFinal,
      maxTokens: 64000,
    });
  }
}

// ---------------------------------------------------------------- Mock
// API 키 없이 UI/흐름을 확인하기 위한 규칙 기반 요약기. 품질 목적이 아님.
const DATE_RE = /(\d{1,2}월\s?\d{1,2}일|\d{4}-\d{2}-\d{2}|다음\s?주|이번\s?주|내일|모레|월말|주말|[월화수목금]요일)/;
const TASK_RE = /(까지|하겠습니다|해\s?주세요|부탁|진행하겠|공유하겠|준비하겠|확인하겠)/;
const DECIDE_RE = /(결정|확정|하기로|합의|승인)/;

function pick(lines, re) {
  return lines.filter((l) => re.test(l.text));
}

export class MockSummarizer {
  constructor() {
    this.name = 'mock';
  }

  async summarizeChunk(session, tz, chunk, lines) {
    const data = {
      summary: lines.slice(0, 3).map((l) => l.text).join(' ').slice(0, 300) || '(내용 없음)',
      topics: [],
      decisions: pick(lines, DECIDE_RE).map((l) => l.text),
      action_items: pick(lines, TASK_RE).map((l) => ({ task: l.text, owner: l.speaker || '', due: '', evidence_time: formatTime(l.t) })),
      schedules: pick(lines, DATE_RE).map((l) => ({ title: l.text.slice(0, 40), when: l.text.match(DATE_RE)[0], evidence_time: formatTime(l.t) })),
      open_questions: lines.filter((l) => /\?$|까요$/.test(l.text)).map((l) => l.text),
      notable_quotes: [],
    };
    return { data, usage: null, model: 'mock' };
  }

  async summarizeFinal(session, tz, { lines, allLines }) {
    const all = lines || allLines || [];
    if (session.type === 'interview') {
      const cand = all.filter((l) => l.speaker !== '면접관');
      const data = {
        candidate_summary: cand.slice(0, 3).map((l) => l.text).join(' ').slice(0, 400) || '(내용 없음)',
        qa_log: all
          .filter((l) => l.speaker === '면접관')
          .map((q) => {
            const a = all.find((l) => l.t > q.t && l.speaker !== '면접관');
            return { question: q.text, answer_summary: a ? a.text : '', time: formatTime(q.t) };
          }),
        competencies: (session.rubric || []).map((name) => ({
          name, score: 0, assessment: '[mock] 실제 평가는 Claude 연동 후 생성됩니다.', evidence: [],
        })),
        strengths: [],
        concerns: [],
        follow_up_questions: [],
        recommendation: '판단 불가',
        recommendation_rationale: '[mock] 규칙 기반 데모 모드입니다.',
        bias_check: { flags: [], note: '' },
      };
      return { data, usage: null, model: 'mock' };
    }
    const data = {
      title: session.title || '회의',
      overview: `[mock] 총 ${all.length}개 발화. ` + all.slice(0, 2).map((l) => l.text).join(' ').slice(0, 300),
      key_points: all.slice(0, 5).map((l) => l.text),
      decisions: pick(all, DECIDE_RE).map((l) => ({ decision: l.text, rationale: '' })),
      action_items: pick(all, TASK_RE).map((l) => ({
        task: l.text, owner: l.speaker || '미정', due_date: '', due_text: (l.text.match(DATE_RE) || [''])[0], priority: '보통',
      })),
      schedules: pick(all, DATE_RE).map((l) => ({
        title: l.text.slice(0, 40), date: (l.text.match(/\d{4}-\d{2}-\d{2}/) || [''])[0], time: '', description: l.text,
      })),
      open_issues: all.filter((l) => /\?$|까요$/.test(l.text)).map((l) => l.text),
      next_meeting: '',
    };
    return { data, usage: null, model: 'mock' };
  }
}

export function createSummarizer(config) {
  return config.summarizer === 'claude' ? new ClaudeSummarizer(config.claude) : new MockSummarizer();
}
