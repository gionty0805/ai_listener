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
    },

    webhook: {
      url: env.WEBHOOK_URL || '',
      format: env.WEBHOOK_FORMAT || 'slack',
      autoSend: bool(env.AUTO_SEND_WEBHOOK, false),
    },
  };
}
