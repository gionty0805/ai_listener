// 환경변수 → 설정 객체. .env 파일이 있으면 간단히 로드한다(외부 의존성 없이).
import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function loadConfig(env = process.env) {
  if (env === process.env) loadDotEnv();
  const hasKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  return {
    port: int(env.PORT, 3000),
    accessToken: env.APP_ACCESS_TOKEN || '',
    // 운영(NODE_ENV=production)에서는 접근 코드 없이 기동하지 않는다 (명시적으로 허용한 경우 제외)
    allowNoAuth: bool(env.ALLOW_NO_AUTH, env.NODE_ENV !== 'production'),
    limits: {
      apiPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 240), // IP당 전체 API
      costlyPerMinute: int(env.RATE_LIMIT_COSTLY_PER_MINUTE, 6), // IP당 요약·발송·세션 생성
      maxTranscriptLines: int(env.MAX_TRANSCRIPT_LINES, 20000), // 세션당 (약 10시간 분량)
      maxAudioSegments: int(env.MAX_AUDIO_SEGMENTS, 150), // 세션당 (5분 × 150 = 12.5시간)
    },
    // 리버스 프록시 뒤에서 X-Forwarded-For 로 클라이언트 IP 판별 (프록시 없이 노출 시 false 유지 — 위조 가능)
    trustProxy: bool(env.TRUST_PROXY, false),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    timezone: env.TZ || 'Asia/Seoul',

    summarizer: env.SUMMARIZER || (hasKey ? 'claude' : 'mock'),
    claude: {
      model: env.CLAUDE_MODEL || 'claude-opus-5-5',
      effortFinal: env.CLAUDE_EFFORT_FINAL || 'high',
      effortChunk: env.CLAUDE_EFFORT_CHUNK || 'medium',
      fallbacks: bool(env.CLAUDE_FALLBACKS, true),
    },

    chunk: {
      minutes: int(env.CHUNK_MINUTES, 10),
      maxChars: int(env.CHUNK_MAX_CHARS, 12000),
      singlePassMaxChars: int(env.SINGLE_PASS_MAX_CHARS, 200000),
      liveNotes: bool(env.LIVE_NOTES, true),
    },

    stt: {
      mode: env.STT_MODE || 'browser',
      whisperUrl: env.WHISPER_API_URL || '',
      whisperKey: env.WHISPER_API_KEY || '',
      whisperModel: env.WHISPER_MODEL || 'whisper-1',
      segmentSeconds: int(env.AUDIO_SEGMENT_SECONDS, 300),
      keepAudio: bool(env.KEEP_AUDIO, false),
    },

    smtp: {
      host: env.SMTP_HOST || '',
      port: int(env.SMTP_PORT, 587),
      secure: bool(env.SMTP_SECURE, false),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || 'AI Listener <no-reply@example.com>',
      autoSend: bool(env.AUTO_SEND_EMAIL, false),
      // 수신 허용 도메인 (쉼표 구분). 설정 시 그 외 도메인으로는 발송 불가 → 외부 유출·스팸 악용 방지
      allowedDomains: (env.MAIL_ALLOWED_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    },

    webhook: {
      url: env.WEBHOOK_URL || '',
      format: env.WEBHOOK_FORMAT || 'slack',
      autoSend: bool(env.AUTO_SEND_WEBHOOK, false),
    },
  };
}
