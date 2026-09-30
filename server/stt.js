// 서버측 STT 어댑터. OpenAI 호환 /v1/audio/transcriptions 규격을 사용하므로
// 사내 설치형 faster-whisper / whisper.cpp 서버 등 호환 엔드포인트를 그대로 붙일 수 있다.
// (면접 음성 등 민감정보를 외부로 보내지 않으려면 사내 설치형 권장)

export class WhisperStt {
  constructor(cfg, fetchImpl = globalThis.fetch) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return this.cfg.mode === 'whisper' && Boolean(this.cfg.whisperUrl);
  }

  /** @returns {Promise<Array<{offsetMs:number,text:string}>>} 세그먼트 내 상대 시각 */
  async transcribe(buf, { mime, filename }) {
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime }), filename);
    form.append('model', this.cfg.whisperModel);
    form.append('language', 'ko');
    form.append('response_format', 'verbose_json');
    const res = await this.fetch(this.cfg.whisperUrl, {
      method: 'POST',
      headers: this.cfg.whisperKey ? { authorization: `Bearer ${this.cfg.whisperKey}` } : {},
      body: form,
    });
    if (!res.ok) throw new Error(`STT 실패 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    if (Array.isArray(json.segments) && json.segments.length) {
      return json.segments
        .map((s) => ({ offsetMs: Math.round((s.start || 0) * 1000), text: String(s.text || '').trim() }))
        .filter((s) => s.text);
    }
    return json.text ? [{ offsetMs: 0, text: String(json.text).trim() }] : [];
  }
}
