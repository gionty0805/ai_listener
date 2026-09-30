// 요약 결과 → Markdown / HTML(이메일) / 짧은 텍스트(메신저) 변환
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const DISCLAIMER = '※ 본 평가는 AI가 면접 녹취를 기반으로 작성한 참고용 초안이며, 채용 결정은 면접관의 종합 판단으로 이루어집니다.';

function sectionsFor(session) {
  const s = session.summary;
  if (!s) return [];
  if (session.type === 'interview') {
    return [
      ['지원자 요약', [s.candidate_summary]],
      ['종합 의견', [`**${s.recommendation}** — ${s.recommendation_rationale}`]],
      ['역량별 평가', s.competencies.map((c) => `**${c.name}**: ${c.score ? `${c.score}/5` : '판단 불가'} — ${c.assessment}${c.evidence.length ? `\n  - 근거: ${c.evidence.join(' / ')}` : ''}`)],
      ['강점', s.strengths],
      ['우려 / 검증 필요', s.concerns],
      ['추가 확인 질문', s.follow_up_questions],
      ['질의응답 기록', s.qa_log.map((q) => `[${q.time}] Q. ${q.question}\n  - A. ${q.answer_summary}`)],
      ['편향 점검', [...s.bias_check.flags.map((f) => `⚠ ${f}`), s.bias_check.note].filter(Boolean)],
    ];
  }
  return [
    ['개요', [s.overview]],
    ['핵심 논의', s.key_points],
    ['결정 사항', s.decisions.map((d) => d.decision + (d.rationale ? ` (근거: ${d.rationale})` : ''))],
    ['할 일 (Action Items)', s.action_items.map((a) => `[${a.priority}] ${a.task} — 담당: ${a.owner || '미정'}${a.due_date || a.due_text ? `, 기한: ${a.due_date || a.due_text}` : ''}`)],
    ['일정', s.schedules.map((e) => `${[e.date, e.time].filter(Boolean).join(' ') || '날짜 미정'} — ${e.title}${e.description ? ` (${e.description})` : ''}`)],
    ['미결 이슈', s.open_issues],
    ['다음 회의', s.next_meeting ? [s.next_meeting] : []],
  ];
}

function header(session) {
  const kind = session.type === 'interview' ? '면접 평가' : '회의록';
  const date = new Date(session.startedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  return { kind, date, title: session.summary?.title || session.title || kind };
}

export function toMarkdown(session) {
  const h = header(session);
  const out = [`# [${h.kind}] ${h.title}`, '', `- 일시: ${h.date}`, `- 참석자: ${session.participants.join(', ') || '-'}`, ''];
  for (const [title, items] of sectionsFor(session)) {
    if (!items.length) continue;
    out.push(`## ${title}`, '', ...items.map((i) => (title === '개요' || title === '지원자 요약' ? i : `- ${i}`)), '');
  }
  if (session.type === 'interview') out.push(`> ${DISCLAIMER}`, '');
  return out.join('\n');
}

export function toHtml(session, link) {
  const h = header(session);
  const md = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n {2}- /g, '<br>&nbsp;&nbsp;↳ ');
  const body = sectionsFor(session)
    .filter(([, items]) => items.length)
    .map(([title, items]) => `<h3 style="margin:20px 0 8px;color:#1f3a8a">${esc(title)}</h3><ul style="margin:0;padding-left:20px">${items.map((i) => `<li style="margin:4px 0">${md(i)}</li>`).join('')}</ul>`)
    .join('');
  return `<!doctype html><html><body style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;line-height:1.6;color:#111;max-width:720px">
<h2 style="margin-bottom:4px">[${esc(h.kind)}] ${esc(h.title)}</h2>
<div style="color:#555;font-size:13px">일시: ${esc(h.date)} · 참석자: ${esc(session.participants.join(', ') || '-')}</div>
${body}
${session.type === 'interview' ? `<p style="margin-top:24px;color:#777;font-size:12px">${esc(DISCLAIMER)}</p>` : ''}
${link ? `<p style="margin-top:24px"><a href="${esc(link)}">웹에서 전체 내용 보기</a></p>` : ''}
<p style="color:#999;font-size:11px">AI Listener 자동 발송 메일</p></body></html>`;
}

export function toShortText(session, link) {
  const h = header(session);
  const s = session.summary;
  const lines = [`*[${h.kind}] ${h.title}* (${h.date})`];
  if (session.type === 'interview') {
    lines.push(`종합: ${s.recommendation} — ${s.recommendation_rationale}`);
    for (const c of s.competencies) lines.push(`• ${c.name}: ${c.score ? `${c.score}/5` : '판단 불가'}`);
  } else {
    lines.push(s.overview);
    if (s.decisions.length) lines.push('', '*결정 사항*', ...s.decisions.map((d) => `• ${d.decision}`));
    if (s.action_items.length) lines.push('', '*할 일*', ...s.action_items.map((a) => `• ${a.task} (${a.owner || '미정'}${a.due_date || a.due_text ? `, ~${a.due_date || a.due_text}` : ''})`));
    if (s.schedules.length) lines.push('', '*일정*', ...s.schedules.map((e) => `• ${[e.date, e.time].filter(Boolean).join(' ') || '날짜 미정'} ${e.title}`));
  }
  if (link) lines.push('', link);
  return lines.join('\n');
}
