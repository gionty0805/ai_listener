// 장시간 회의 대응 청크 분할.
//
// 전사 라인: { t: 녹음 시작 기준 ms, speaker, text }
// 청크 경계 규칙
//   1) 시간 기준: chunkMinutes 마다 끊는다 (녹음 중 중간요약 주기와 동일)
//   2) 크기 기준: 한 청크가 maxChars 를 넘으면 시간과 무관하게 끊는다
//   3) 문장(라인) 단위로만 끊는다 — 발화 중간에서 자르지 않는다
//   4) 다음 청크 요약 시 직전 청크의 마지막 몇 줄을 "이전 맥락"으로 함께 전달(overlap)

export function formatTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function renderLines(lines) {
  return lines.map((l) => `[${formatTime(l.t)}] ${l.speaker || '화자'}: ${l.text}`).join('\n');
}

export function transcriptChars(lines) {
  return lines.reduce((n, l) => n + (l.text?.length || 0) + 12, 0);
}

/**
 * 아직 청크에 포함되지 않은 라인(fromLine 이후)에서 "닫힌" 청크들을 잘라낸다.
 * final=false (녹음 중): 시간/크기 조건을 만족한 청크만 반환하고 나머지는 대기.
 * final=true  (종료 시): 남은 라인을 모두 마지막 청크로 반환.
 */
export function planChunks(lines, fromLine, { minutes, maxChars }, final = false) {
  const windowMs = minutes * 60_000;
  const out = [];
  let start = fromLine;
  let chars = 0;
  for (let i = fromLine; i < lines.length; i++) {
    chars += (lines[i].text?.length || 0) + 12;
    const next = lines[i + 1];
    const timeCut = next && next.t - lines[start].t >= windowMs;
    const sizeCut = chars >= maxChars;
    if (timeCut || sizeCut) {
      out.push({ lineFrom: start, lineTo: i + 1, startMs: lines[start].t, endMs: lines[i].t });
      start = i + 1;
      chars = 0;
    }
  }
  if (final && start < lines.length) {
    out.push({ lineFrom: start, lineTo: lines.length, startMs: lines[start].t, endMs: lines[lines.length - 1].t });
  }
  return out;
}

export function overlapContext(lines, lineFrom, overlapLines = 6) {
  return lines.slice(Math.max(0, lineFrom - overlapLines), lineFrom);
}
