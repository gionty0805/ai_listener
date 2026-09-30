// 브라우저 녹음 엔진
//  - getUserMedia 로 마이크 확보 (HTTPS 또는 localhost 에서만 동작)
//  - STT 모드 browser: Web Speech API 로 실시간 전사 → 확정 문장을 onFinal 로 전달
//  - STT 모드 whisper: MediaRecorder 를 N초마다 재시작해 "독립적으로 재생 가능한" 세그먼트 파일 생성 → onSegment
//    (timeslice 방식은 첫 조각에만 헤더가 있어 조각 단위 STT가 불가능하므로 세그먼트 회전 방식을 사용)
//  - Screen Wake Lock 으로 모바일 화면 꺼짐(=녹음 중단) 방지

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function capabilities() {
  return {
    secure: window.isSecureContext,
    mic: Boolean(navigator.mediaDevices?.getUserMedia),
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    speech: Boolean(SR),
    wakeLock: 'wakeLock' in navigator,
  };
}

function pickMime() {
  const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return c.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
}

export class Recorder {
  constructor({ mode, segmentSeconds = 300, lang = 'ko-KR', onFinal, onInterim, onLevel, onSegment, onError, onState }) {
    Object.assign(this, { mode, segmentSeconds, lang, onFinal, onInterim, onLevel, onSegment, onError, onState });
    this.state = 'idle';
    this.speaker = '';
    this.accumPaused = 0;
    this.seq = 0;
  }

  elapsed() {
    if (!this.startedAt) return 0;
    const pausedNow = this.state === 'paused' ? performance.now() - this.pausedAt : 0;
    return Math.round(performance.now() - this.startedAt - this.accumPaused - pausedNow);
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.startedAt = performance.now();
    this.#setState('recording');
    this.#meter();
    await this.#wakeLock();
    document.addEventListener('visibilitychange', this.#onVisibility);
    if (this.mode === 'whisper') this.#startSegment();
    else this.#startSpeech();
  }

  pause() {
    if (this.state !== 'recording') return;
    this.pausedAt = performance.now();
    this.#setState('paused');
    if (this.mode === 'whisper') this.mr?.state === 'recording' && this.mr.pause();
    else this.sr?.stop();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.accumPaused += performance.now() - this.pausedAt;
    this.#setState('recording');
    if (this.mode === 'whisper') this.mr?.state === 'paused' && this.mr.resume();
    else this.#startSpeech();
  }

  async stop() {
    if (this.state === 'paused') this.resume();
    this.#setState('stopping');
    const done = [];
    if (this.mr && this.mr.state !== 'inactive') {
      done.push(new Promise((r) => { this.mrStopResolve = r; }));
      clearTimeout(this.segTimer);
      this.mr.stop();
    }
    if (this.sr) {
      this.sr.onend = null;
      try { this.sr.stop(); } catch { /* noop */ }
    }
    await Promise.all(done);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close();
    cancelAnimationFrame(this.raf);
    this.wake?.release?.().catch(() => {});
    document.removeEventListener('visibilitychange', this.#onVisibility);
    this.#setState('stopped');
  }

  #setState(s) {
    this.state = s;
    this.onState?.(s);
  }

  // ---- Web Speech API ----
  #startSpeech() {
    if (!SR) {
      this.onError?.('이 브라우저는 실시간 음성인식을 지원하지 않습니다. Chrome/Edge/Safari 최신 버전을 사용하거나 서버 STT(whisper)를 설정하세요.', true);
      return;
    }
    const sr = new SR();
    sr.lang = this.lang;
    sr.continuous = true;
    sr.interimResults = true;
    let segStart = null;
    sr.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (segStart === null) segStart = this.elapsed();
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) this.onFinal?.({ t: segStart, speaker: this.speaker, text });
          segStart = null;
        } else interim += r[0].transcript;
      }
      this.onInterim?.(interim);
    };
    sr.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.onError?.('음성인식 권한이 거부되었습니다.', true);
        this.state = 'error';
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.onError?.(`음성인식 오류: ${e.error} (자동 재시작)`);
      }
    };
    // 브라우저는 침묵·시간 경과 시 인식을 스스로 종료함 → 녹음 중이면 즉시 재시작
    sr.onend = () => {
      this.onInterim?.('');
      if (this.state === 'recording') setTimeout(() => this.state === 'recording' && this.#safeStart(sr), 250);
    };
    this.sr = sr;
    this.#safeStart(sr);
  }

  #safeStart(sr) {
    try { sr.start(); } catch { /* already started */ }
  }

  // ---- 세그먼트 회전 녹음 ----
  #startSegment() {
    const mime = pickMime();
    const mr = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    const chunks = [];
    const seq = this.seq++;
    const startMs = this.elapsed();
    const speaker = this.speaker;
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      const blob = new Blob(chunks, { type: (mr.mimeType || mime || 'audio/webm').split(';')[0] });
      if (blob.size) this.onSegment?.({ blob, seq, startMs, speaker });
      if (this.state === 'recording' || this.state === 'paused') this.#startSegment();
      else this.mrStopResolve?.();
    };
    mr.start();
    this.mr = mr;
    this.segTimer = setTimeout(() => mr.state !== 'inactive' && mr.stop(), this.segmentSeconds * 1000);
  }

  // ---- 입력 레벨 미터 ----
  #meter() {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      const an = this.audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        this.onLevel?.(this.state === 'recording' ? Math.min(1, peak / 64) : 0);
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* meter optional */ }
  }

  async #wakeLock() {
    try { this.wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  }

  #onVisibility = () => {
    if (document.visibilityState === 'visible' && this.state !== 'stopped') this.#wakeLock();
    else if (document.visibilityState === 'hidden' && this.mode !== 'whisper') {
      this.onError?.('화면을 벗어나면 모바일 브라우저가 음성인식을 중단할 수 있습니다. 녹음 중에는 이 화면을 유지하세요.');
    }
  };
}
