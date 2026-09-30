// 회의에서 추출된 일정/기한 → iCalendar(.ics). 메일 첨부 시 한 번 클릭으로 캘린더 등록.
const pad = (n) => String(n).padStart(2, '0');

function escText(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// RFC 5545: 한 줄 75 octet 초과 시 folding
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = ch;
    } else cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

function stamp(d = new Date()) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** events: [{ uid, title, date: 'YYYY-MM-DD', time: 'HH:mm' | '', description }] */
export function buildIcs(events, { tz = 'Asia/Seoul', prodId = '-//AI Listener//KO' } = {}) {
  const valid = events.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date));
  if (!valid.length) return null;
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${prodId}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const e of valid) {
    const d = e.date.replace(/-/g, '');
    out.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp()}`);
    if (/^\d{2}:\d{2}$/.test(e.time || '')) {
      const [hh, mm] = e.time.split(':').map(Number);
      const endH = (hh + 1) % 24; // 기본 1시간
      out.push(`DTSTART;TZID=${tz}:${d}T${pad(hh)}${pad(mm)}00`);
      out.push(endH > hh ? `DTEND;TZID=${tz}:${d}T${pad(endH)}${pad(mm)}00` : `DURATION:PT1H`);
    } else {
      // 종일 일정: DTEND 는 다음날(비포함)
      const next = new Date(`${e.date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      out.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, '')}`);
    }
    out.push(fold(`SUMMARY:${escText(e.title)}`));
    if (e.description) out.push(fold(`DESCRIPTION:${escText(e.description)}`));
    out.push('END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}

export function eventsFromMeeting(session) {
  const s = session.summary;
  if (!s || session.type !== 'meeting') return [];
  const ev = s.schedules.map((e, i) => ({
    uid: `${session.id}-s${i}@ai-listener`, title: e.title, date: e.date, time: e.time, description: e.description,
  }));
  s.action_items.forEach((a, i) => {
    if (a.due_date) ev.push({ uid: `${session.id}-a${i}@ai-listener`, title: `[마감] ${a.task}`, date: a.due_date, time: '', description: `담당: ${a.owner || '미정'}` });
  });
  return ev;
}
