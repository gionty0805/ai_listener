// 이메일(SMTP) · 메신저 웹훅(Slack/Teams/일반) 발송
import { toHtml, toMarkdown, toShortText } from './report.js';
import { buildIcs, eventsFromMeeting } from './ics.js';

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export class Notifier {
  constructor({ config, store, fetchImpl = globalThis.fetch }) {
    this.config = config;
    this.store = store;
    this.fetch = fetchImpl;
    this.transport = null;
  }

  status() {
    return { email: Boolean(this.config.smtp.host), webhook: Boolean(this.config.webhook.url) };
  }

  link(session) {
    return this.config.publicBaseUrl ? `${this.config.publicBaseUrl}/#/s/${session.id}` : '';
  }

  async #mailer() {
    if (!this.config.smtp.host) throw Object.assign(new Error('SMTP가 설정되지 않았습니다(SMTP_HOST).'), { status: 400 });
    if (!this.transport) {
      const { default: nodemailer } = await import('nodemailer');
      const { host, port, secure, user, pass } = this.config.smtp;
      this.transport = nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined });
    }
    return this.transport;
  }

  async sendEmail(session, to) {
    const recipients = [...new Set((to || []).map((x) => x.trim()).filter(Boolean))];
    const bad = recipients.filter((r) => !EMAIL_RE.test(r));
    if (!recipients.length || bad.length) {
      throw Object.assign(new Error(bad.length ? `잘못된 이메일 주소: ${bad.join(', ')}` : '수신자가 없습니다.'), { status: 400 });
    }
    if (!session.summary) throw Object.assign(new Error('요약이 아직 완료되지 않았습니다.'), { status: 409 });
    const mailer = await this.#mailer();
    const kind = session.type === 'interview' ? '면접 평가' : '회의록';
    const attachments = [{ filename: `${kind}_${session.id}.md`, content: toMarkdown(session), contentType: 'text/markdown; charset=utf-8' }];
    const ics = buildIcs(eventsFromMeeting(session), { tz: this.config.timezone });
    if (ics) attachments.push({ filename: 'schedule.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=PUBLISH' });
    const info = await mailer.sendMail({
      from: this.config.smtp.from,
      to: recipients.join(', '),
      subject: `[AI Listener] ${kind} - ${session.summary.title || session.title}`,
      html: toHtml(session, this.link(session)),
      text: toMarkdown(session),
      attachments,
    });
    return this.#record(session.id, { channel: 'email', to: recipients, messageId: info.messageId });
  }

  webhookPayload(session) {
    const text = toShortText(session, this.link(session));
    switch (this.config.webhook.format) {
      case 'teams': // Teams Workflows(Power Automate) "웹후크 요청 수신" 트리거용 Adaptive Card
        return {
          type: 'message',
          attachments: [{
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
              body: [{ type: 'TextBlock', text: text.replace(/\*/g, '**'), wrap: true }],
            },
          }],
        };
      case 'generic':
        return { text, session: { id: session.id, type: session.type, title: session.title }, summary: session.summary };
      default: // slack incoming webhook (mrkdwn)
        return { text };
    }
  }

  async sendWebhook(session) {
    if (!this.config.webhook.url) throw Object.assign(new Error('웹훅이 설정되지 않았습니다(WEBHOOK_URL).'), { status: 400 });
    if (!session.summary) throw Object.assign(new Error('요약이 아직 완료되지 않았습니다.'), { status: 409 });
    const res = await this.fetch(this.config.webhook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.webhookPayload(session)),
    });
    if (!res.ok) throw Object.assign(new Error(`웹훅 전송 실패 (HTTP ${res.status})`), { status: 502 });
    return this.#record(session.id, { channel: 'webhook', format: this.config.webhook.format });
  }

  // 요약 완료 직후 자동 발송 (설정된 경우만)
  async auto(session) {
    const jobs = [];
    if (this.config.smtp.autoSend && this.config.smtp.host && session.recipients.length) jobs.push(this.sendEmail(session, session.recipients));
    if (this.config.webhook.autoSend && this.config.webhook.url) jobs.push(this.sendWebhook(session));
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === 'rejected') throw r.reason;
  }

  #record(id, entry) {
    const rec = { ...entry, at: new Date().toISOString() };
    return this.store.update(id, (s) => {
      s.notifications.push(rec);
    }).then(() => rec);
  }
}
