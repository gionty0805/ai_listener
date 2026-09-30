import { Recorder, capabilities } from './recorder.js';

const $view = document.getElementById('view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
};
const STATUS = { recording: '녹음 중', summarizing: '요약 중', done: '완료', error: '오류' };
let config = null;
let active = null; // 현재 녹음 컨트롤러 (페이지 이탈 방지용)

function toast(msg, ms = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function token() {
  try { return localStorage.getItem('accessToken') || ''; } catch { return ''; }
}

async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'x-access-token': token(), ...(body && !(body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    const t = prompt('접근 코드를 입력하세요');
    if (t !== null) {
      try { localStorage.setItem('accessToken', t); } catch { /* noop */ }
      return api(path, { method, body, headers, raw });
    }
  }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

// ---------------------------------------------------------------- 라우터
async function router() {
  const hash = location.hash || '#/';
  if (active && !hash.startsWith(`#/rec/${active.id}`)) {
    if (!confirm('녹음이 진행 중입니다. 화면을 벗어나면 녹음이 중단됩니다. 계속할까요?')) {
      history.replaceState(null, '', `#/rec/${active.id}`);
      return;
    }
    await active.abort();
  }
  let m;
  if (hash === '#/' || hash === '#') return viewHome();
  if (hash === '#/new/meeting' || hash === '#/new/interview') return viewNew(hash.split('/')[2]);
  if ((m = hash.match(/^#\/rec\/([a-f0-9]{16})$/))) return viewRecord(m[1]);
  if ((m = hash.match(/^#\/s\/([a-f0-9]{16})$/))) return viewResult(m[1]);
  location.hash = '#/';
}

// ---------------------------------------------------------------- 홈
async function viewHome() {
  const cap = capabilities();
  const warn = [];
  if (!cap.secure) warn.push('HTTPS가 아닌 주소에서는 브라우저가 마이크 사용을 차단합니다. HTTPS로 접속하세요.');
  if (config.stt.mode === 'browser' && !cap.speech) warn.push('이 브라우저는 실시간 음성인식을 지원하지 않습니다 (Chrome·Edge·Safari 권장).');
  $view.innerHTML = `
    ${warn.map((w) => `<div class="card" style="border-color:var(--warn)">⚠ ${esc(w)}</div>`).join('')}
    <div class="card">
      <h2>새 녹음 시작</h2>
      <div class="seg">
        <button onclick="location.hash='#/new/meeting'">🗓️<b>회의</b><span class="muted">회의록 · 할 일 · 일정 추출</span></button>
        <button onclick="location.hash='#/new/interview'">🧑‍💼<b>면접</b><span class="muted">질의응답 · 역량 평가 초안</span></button>
      </div>
    </div>
    <div class="card"><h2>기록</h2><div class="list" id="list"><div class="spinner"></div></div></div>`;
  const list = await api('/api/sessions').catch((e) => (toast(e.message), []));
  document.getElementById('list').innerHTML = list.length
    ? list.map((s) => `<a href="#/${s.status === 'recording' ? 'rec' : 's'}/${s.id}">
        <span class="grow">${s.type === 'interview' ? '🧑‍💼' : '🗓️'} ${esc(s.title)}<br><span class="muted">${new Date(s.createdAt).toLocaleString('ko-KR')}</span></span>
        <span class="status ${s.status}">${STATUS[s.status] || s.status}</span></a>`).join('')
    : '<p class="muted">아직 기록이 없습니다.</p>';
}

// ---------------------------------------------------------------- 새 세션
function viewNew(type) {
  const interview = type === 'interview';
  $view.innerHTML = `
    <h1>${interview ? '면접' : '회의'} 녹음 준비</h1>
    <form class="card" id="f">
      <label for="title">제목</label>
      <input id="title" type="text" required placeholder="${interview ? '예: 백엔드 개발자 1차 면접 - 홍길동' : '예: 3분기 서비스 기획 회의'}">
      <label for="participants">${interview ? '면접관 / 지원자' : '참석자'} <span class="muted">(쉼표로 구분)</span></label>
      <input id="participants" type="text" placeholder="${interview ? '면접관: 김팀장, 이선임 / 지원자: 홍길동' : '김팀장, 이선임, 박책임'}">
      ${interview ? `
        <label for="rubric">평가 역량 <span class="muted">(줄바꿈으로 구분 — 모든 지원자에게 같은 기준 적용)</span></label>
        <textarea id="rubric" rows="6">${esc(config.defaultRubric.join('\n'))}</textarea>
        <label for="jd">직무 설명 (JD) <span class="muted">(선택)</span></label>
        <textarea id="jd" placeholder="담당 업무, 자격 요건, 우대 사항"></textarea>` : `
        <label for="agenda">사전 안건 <span class="muted">(선택)</span></label>
        <textarea id="agenda" placeholder="논의할 안건을 적으면 요약 정확도가 올라갑니다"></textarea>`}
      <label for="recipients">결과 수신 이메일 <span class="muted">(선택, 쉼표로 구분)</span></label>
      <input id="recipients" type="text" inputmode="email" placeholder="team@example.com">
      <label class="check"><input id="consent" type="checkbox" required>
        <span>참석자${interview ? '(지원자 포함)' : ''} 전원에게 녹음 및 AI 요약 목적의 개인정보 처리를 고지하고 동의를 받았습니다.</span></label>
      <div class="row" style="margin-top:16px">
        <a class="btn" href="#/">취소</a><span class="grow"></span>
        <button class="primary" type="submit">🎙️ 녹음 시작</button>
      </div>
    </form>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const v = (id) => document.getElementById(id)?.value || '';
    try {
      const s = await api('/api/sessions', {
        method: 'POST',
        body: {
          type, title: v('title'), participants: v('participants'), recipients: v('recipients'),
          rubric: interview ? v('rubric').split('\n') : [], jobDescription: v('jd'), agenda: v('agenda'),
          consent: document.getElementById('consent').checked,
        },
      });
      location.hash = `#/rec/${s.id}`; // 녹음 시작은 사용자 탭(제스처)으로 — 모바일 오디오 정책
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------------------------------------------------------------- 녹음
async function viewRecord(id) {
  const s = await api(`/api/sessions/${id}`).catch((e) => (toast(e.message), null));
  if (!s) return;
  if (s.status !== 'recording') { location.hash = `#/s/${id}`; return; }
  const interview = s.type === 'interview';
  const speakers = interview ? ['면접관', '지원자'] : (s.participants.length ? s.participants.slice(0, 8) : ['참석자']);
  const mode = config.stt.mode;

  $view.innerHTML = `
    <h1>${interview ? '🧑‍💼' : '🗓️'} ${esc(s.title)}</h1>
    <div class="card">
      <div class="row"><span class="dot" id="dot"></span><span class="timer" id="timer">00:00</span><span class="grow"></span>
        <span class="muted" id="state">대기</span></div>
      <div class="meter"><i id="lvl"></i></div>
      <div class="muted" style="margin-top:8px">현재 화자 <span class="muted">(누르면 이후 발화에 적용)</span></div>
      <div class="speakers" id="spk">${speakers.map((p, i) => `<button type="button" data-sp="${esc(p)}" aria-pressed="${i === 0}">${esc(p)}</button>`).join('')}</div>
    </div>
    <div class="card">
      <div class="row"><h2 class="grow">실시간 전사</h2><span class="muted">${mode === 'whisper' ? `서버 STT · ${config.stt.segmentSeconds}초 단위 반영` : '브라우저 음성인식'}</span></div>
      <div class="transcript" id="tr">${s.transcript.map(lineHtml).join('') || '<p class="muted" id="empty">녹음을 시작하면 이곳에 전사 내용이 표시됩니다.</p>'}</div>
      <form class="row" id="noteForm" style="margin-top:10px"><input class="grow" id="note" type="text" placeholder="메모 추가 (예: 화면 공유된 수치, 오인식 정정)"><button type="submit">추가</button></form>
    </div>
    ${config.chunk.liveNotes ? `<div class="card"><h2>중간 요약 <span class="muted">(${config.chunk.minutes}분 단위)</span></h2><div id="chunks">${chunksHtml(s.chunks)}</div></div>` : ''}
    <div class="recbar"><div class="inner">
      <button id="btnStart" class="primary grow">🎙️ 녹음 시작</button>
      <button id="btnPause" hidden>⏸ 일시정지</button>
      <button id="btnStop" class="danger" hidden>⏹ 종료 · 요약</button>
    </div></div>`;

  const $tr = document.getElementById('tr');
  const $ = (x) => document.getElementById(x);
  let speaker = speakers[0];
  let pending = []; // 전송 대기 전사 라인
  let interimEl = null;
  const uploads = []; // 오디오 업로드 promise
  let failedSegs = [];

  const append = (line) => {
    $('empty')?.remove();
    interimEl?.remove();
    interimEl = null;
    $tr.insertAdjacentHTML('beforeend', lineHtml(line));
    $tr.scrollTop = $tr.scrollHeight;
  };

  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    try {
      await api(`/api/sessions/${id}/transcript`, { method: 'POST', body: { lines: batch } });
    } catch (e) {
      pending = batch.concat(pending); // 네트워크 오류 시 다음 주기에 재전송
      toast(`전사 전송 지연: ${e.message}`);
    }
  };

  const uploadSeg = async (seg, attempt = 0) => {
    try {
      const q = new URLSearchParams({ seq: seg.seq, startMs: seg.startMs, speaker: seg.speaker });
      const r = await api(`/api/sessions/${id}/audio?${q}`, { method: 'POST', body: seg.blob, headers: { 'content-type': seg.blob.type } });
      if (r.added) refreshTranscript();
    } catch (e) {
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        return uploadSeg(seg, attempt + 1);
      }
      failedSegs.push(seg);
      toast(`음성 업로드 실패(#${seg.seq}): ${e.message}`);
    }
  };

  const refreshTranscript = async () => {
    const cur = await api(`/api/sessions/${id}`).catch(() => null);
    if (!cur) return;
    $tr.innerHTML = cur.transcript.map(lineHtml).join('');
    $tr.scrollTop = $tr.scrollHeight;
    if ($('chunks')) $('chunks').innerHTML = chunksHtml(cur.chunks);
  };

  const rec = new Recorder({
    mode,
    segmentSeconds: config.stt.segmentSeconds,
    onFinal: (line) => { pending.push(line); append(line); },
    onInterim: (text) => {
      if (!text) { interimEl?.remove(); interimEl = null; return; }
      if (!interimEl) { interimEl = document.createElement('p'); interimEl.className = 'interim'; $tr.append(interimEl); }
      interimEl.textContent = text;
      $tr.scrollTop = $tr.scrollHeight;
    },
    onLevel: (v) => { $('lvl') && ($('lvl').style.width = `${Math.round(v * 100)}%`); },
    onSegment: (seg) => uploads.push(uploadSeg(seg)),
    onError: (msg) => toast(msg, 5000),
    onState: (st) => {
      $('dot')?.classList.toggle('on', st === 'recording');
      $('state') && ($('state').textContent = { recording: '녹음 중', paused: '일시정지', stopping: '정리 중', stopped: '종료', idle: '대기' }[st] || st);
    },
  });

  $('spk').onclick = (e) => {
    const b = e.target.closest('button[data-sp]');
    if (!b) return;
    speaker = b.dataset.sp;
    rec.speaker = speaker;
    $('spk').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  };
  rec.speaker = speaker;

  $('noteForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('note').value.trim();
    if (!text) return;
    const line = { t: rec.elapsed(), speaker: '메모', text, src: 'note' };
    pending.push(line);
    append(line);
    $('note').value = '';
    flush();
  };

  const timer = setInterval(() => { $('timer') && ($('timer').textContent = fmt(rec.elapsed())); }, 500);
  const flusher = setInterval(flush, 5000);
  const poller = config.chunk.liveNotes ? setInterval(async () => {
    const cur = await api(`/api/sessions/${id}`).catch(() => null);
    if (cur && $('chunks')) $('chunks').innerHTML = chunksHtml(cur.chunks);
  }, 30000) : null;
  const beforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };

  const cleanup = () => {
    clearInterval(timer); clearInterval(flusher); if (poller) clearInterval(poller);
    window.removeEventListener('beforeunload', beforeUnload);
    active = null;
  };

  active = { id, abort: async () => { await rec.stop().catch(() => {}); await flush(); cleanup(); } };

  const start = async () => {
    try {
      await rec.start();
      window.addEventListener('beforeunload', beforeUnload);
      $('btnStart').hidden = true;
      $('btnPause').hidden = false;
      $('btnStop').hidden = false;
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? '마이크 권한을 허용해 주세요.' : `마이크를 시작할 수 없습니다: ${e.message}`, 5000);
    }
  };

  $('btnStart').onclick = start;
  $('btnPause').onclick = () => {
    if (rec.state === 'recording') { rec.pause(); $('btnPause').textContent = '▶ 재개'; }
    else { rec.resume(); $('btnPause').textContent = '⏸ 일시정지'; }
  };
  $('btnStop').onclick = async () => {
    if (!confirm('녹음을 종료하고 요약을 생성할까요?')) return;
    $('btnStop').disabled = true;
    $('btnPause').disabled = true;
    await rec.stop();
    await flush();
    await Promise.all(uploads); // 마지막 세그먼트 업로드/전사까지 대기
    if (failedSegs.length) toast(`업로드 실패 구간 ${failedSegs.length}개는 요약에서 제외됩니다.`, 5000);
    try {
      await api(`/api/sessions/${id}/finish`, { method: 'POST', body: { durationMs: rec.elapsed() } });
      cleanup();
      location.hash = `#/s/${id}`;
    } catch (e) {
      toast(e.message);
      $('btnStop').disabled = false;
    }
  };

}

function lineHtml(l) {
  return `<p><span class="t">${fmt(l.t)}</span><span class="sp">${esc(l.speaker || '화자')}</span>${esc(l.text)}</p>`;
}

function chunksHtml(chunks) {
  if (!chunks?.length) return '<p class="muted">구간이 쌓이면 중간 요약이 표시됩니다.</p>';
  return chunks.map((c) => `<div class="notes-chunk"><b>${esc(c.range)}</b> ${esc(c.notes.summary)}
    ${c.notes.action_items.length ? `<br><span class="muted">할 일: ${c.notes.action_items.map((a) => esc(a.task)).join(' · ')}</span>` : ''}</div>`).join('');
}

// ---------------------------------------------------------------- 결과
const ul = (items, f = esc) => (items?.length ? `<ul>${items.map((i) => `<li>${f(i)}</li>`).join('')}</ul>` : '<p class="muted">없음</p>');

function meetingHtml(s) {
  return `
    <h3>개요</h3><p>${esc(s.overview)}</p>
    <h3>핵심 논의</h3>${ul(s.key_points)}
    <h3>결정 사항</h3>${ul(s.decisions, (d) => `${esc(d.decision)}${d.rationale ? ` <span class="muted">— ${esc(d.rationale)}</span>` : ''}`)}
    <h3>할 일</h3>${s.action_items.length ? `<table><tr><th>할 일</th><th>담당</th><th>기한</th><th>우선</th></tr>
      ${s.action_items.map((a) => `<tr><td>${esc(a.task)}</td><td>${esc(a.owner || '미정')}</td><td>${esc(a.due_date || a.due_text || '-')}</td><td>${esc(a.priority)}</td></tr>`).join('')}</table>` : '<p class="muted">없음</p>'}
    <h3>일정</h3>${ul(s.schedules, (e) => `<b>${esc([e.date, e.time].filter(Boolean).join(' ') || '날짜 미정')}</b> ${esc(e.title)} <span class="muted">${esc(e.description)}</span>`)}
    <h3>미결 이슈</h3>${ul(s.open_issues)}
    ${s.next_meeting ? `<h3>다음 회의</h3><p>${esc(s.next_meeting)}</p>` : ''}`;
}

function interviewHtml(s) {
  return `
    <h3>종합 의견</h3><p><span class="rec">${esc(s.recommendation)}</span><br>${esc(s.recommendation_rationale)}</p>
    <h3>지원자 요약</h3><p>${esc(s.candidate_summary)}</p>
    <h3>역량별 평가</h3>
    <table><tr><th>역량</th><th>점수</th><th>평가 및 근거</th></tr>
    ${s.competencies.map((c) => `<tr><td>${esc(c.name)}</td><td><span class="score">${c.score ? `${c.score}/5` : 'N/A'}</span></td>
      <td>${esc(c.assessment)}${c.evidence.length ? `<div class="evidence">${c.evidence.map(esc).join('<br>')}</div>` : ''}</td></tr>`).join('')}</table>
    <h3>강점</h3>${ul(s.strengths)}
    <h3>우려 / 검증 필요</h3>${ul(s.concerns)}
    <h3>추가 확인 질문</h3>${ul(s.follow_up_questions)}
    <details><summary>질의응답 기록 (${s.qa_log.length})</summary>${ul(s.qa_log, (q) => `<span class="muted">${esc(q.time)}</span> <b>Q.</b> ${esc(q.question)}<br><b>A.</b> ${esc(q.answer_summary)}`)}</details>
    ${s.bias_check.flags.length ? `<h3>⚠ 편향 점검</h3>${ul(s.bias_check.flags)}<p class="muted">${esc(s.bias_check.note)}</p>` : ''}
    <p class="disclaimer">본 평가는 AI가 녹취를 기반으로 작성한 참고용 초안입니다. 채용 결정은 면접관의 종합 판단으로 이루어지며, 점수는 면접관 간 평가 기준을 맞추기 위한 보조 자료로 사용하세요.</p>`;
}

async function viewResult(id) {
  clearTimeout(viewResult.t);
  const s = await api(`/api/sessions/${id}`).catch((e) => (toast(e.message), null));
  if (!s) return;
  if (location.hash !== `#/s/${id}`) return;
  if (s.status === 'recording') { location.hash = `#/rec/${id}`; return; }

  const meta = s.summaryMeta;
  $view.innerHTML = `
    <h1>${s.type === 'interview' ? '🧑‍💼' : '🗓️'} ${esc(s.summary?.title || s.title)}</h1>
    <p class="muted">${new Date(s.startedAt).toLocaleString('ko-KR')} · ${esc(s.participants.join(', ') || '참석자 미입력')} · 전사 ${s.transcript.length}줄
      ${meta ? ` · ${esc(meta.engine)}/${esc(meta.strategy)}${meta.chunks ? ` (${meta.chunks}구간)` : ''}` : ''}</p>
    ${s.status === 'summarizing' ? `<div class="card row"><div class="spinner"></div><div><b>요약 생성 중…</b><br><span class="muted">긴 회의는 1~2분 정도 걸릴 수 있습니다. 이 화면은 자동으로 갱신됩니다.</span></div></div>` : ''}
    ${s.status === 'error' ? `<div class="card" style="border-color:var(--danger)"><b>요약 실패</b><p>${esc(s.error)}</p><button id="retry" class="primary">다시 요약</button></div>` : ''}
    ${s.summary ? `<div class="card result">${s.type === 'interview' ? interviewHtml(s.summary) : meetingHtml(s.summary)}</div>
      <div class="card">
        <h2>공유</h2>
        <label for="to">이메일 수신자</label>
        <div class="row"><input id="to" class="grow" type="text" inputmode="email" value="${esc(s.recipients.join(', '))}" placeholder="a@example.com, b@example.com">
          <button id="sendMail" ${config.notify.email ? '' : 'disabled title="SMTP 미설정"'}>✉️ 이메일</button></div>
        <div class="row" style="margin-top:10px">
          <button id="sendHook" ${config.notify.webhook ? '' : 'disabled title="WEBHOOK_URL 미설정"'}>💬 메신저 알림</button>
          <a class="btn" href="/api/sessions/${id}/export.md" id="dl">⬇ Markdown</a>
          <button id="copy">📋 복사</button>
          <span class="grow"></span>
          <button id="resum">↻ 재요약</button>
        </div>
        ${s.notifications.length ? `<p class="muted">발송 이력: ${s.notifications.map((n) => `${n.channel === 'email' ? '이메일' : '메신저'} ${new Date(n.at).toLocaleString('ko-KR')}`).join(' · ')}</p>` : ''}
      </div>` : ''}
    <div class="card"><details><summary>전사 원문 (${s.transcript.length}줄)</summary><div class="transcript" style="max-height:none">${s.transcript.map(lineHtml).join('')}</div></details></div>
    <div class="row"><a class="btn" href="#/">← 목록</a><span class="grow"></span><button id="del" class="danger">삭제</button></div>`;

  const on = (elId, fn) => { const el = document.getElementById(elId); if (el) el.onclick = fn; };
  const run = async (btn, fn, ok) => {
    btn.disabled = true;
    try { await fn(); toast(ok); } catch (e) { toast(e.message, 5000); } finally { btn.disabled = false; }
  };
  on('sendMail', (e) => run(e.target, () => api(`/api/sessions/${id}/notify`, { method: 'POST', body: { email: { to: document.getElementById('to').value } } }), '이메일을 발송했습니다.'));
  on('sendHook', (e) => run(e.target, () => api(`/api/sessions/${id}/notify`, { method: 'POST', body: { webhook: true } }), '메신저 알림을 보냈습니다.'));
  on('copy', (e) => run(e.target, async () => {
    const r = await api(`/api/sessions/${id}/export.md`, { raw: true });
    await navigator.clipboard.writeText(await r.text());
  }, '클립보드에 복사했습니다.'));
  on('dl', async (e) => {
    if (!config.authRequired) return;
    e.preventDefault(); // 접근 코드 헤더가 필요하므로 fetch 로 다운로드
    const r = await api(`/api/sessions/${id}/export.md`, { raw: true });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: `${s.type}_${id}.md` });
    a.click();
  });
  const resummarize = async () => { await api(`/api/sessions/${id}/summarize`, { method: 'POST' }).catch((e) => toast(e.message)); viewResult(id); };
  on('retry', resummarize);
  on('resum', () => confirm('요약을 다시 생성할까요? (API 비용이 발생합니다)') && resummarize());
  on('del', async () => {
    if (!confirm('이 기록(전사·요약·음성)을 영구 삭제할까요?')) return;
    await api(`/api/sessions/${id}`, { method: 'DELETE' }).catch((e) => toast(e.message));
    location.hash = '#/';
  });

  if (s.status === 'summarizing') viewResult.t = setTimeout(() => viewResult(id), 3000);
}

// ---------------------------------------------------------------- 부팅
(async () => {
  config = await api('/api/config');
  const badge = document.getElementById('engine');
  badge.textContent = config.summarizer === 'claude' ? `Claude · ${config.model}` : '데모 모드 (API 키 없음)';
  if (config.summarizer !== 'claude') badge.classList.add('warn');
  window.addEventListener('hashchange', router);
  router();
})();
