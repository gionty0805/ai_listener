import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
if (!config.accessToken && !config.allowNoAuth) {
  console.error('APP_ACCESS_TOKEN 이 설정되지 않았습니다. 운영 환경에서는 접근 코드가 필요합니다 (의도적으로 끄려면 ALLOW_NO_AUTH=true).');
  process.exit(1);
}
if (!config.accessToken) console.warn('⚠ 접근 코드 없이 실행 중입니다. 같은 네트워크의 누구나 기록을 열람할 수 있습니다.');
const { server } = await createApp(config);

server.listen(config.port, () => {
  console.log(`AI Listener → http://localhost:${config.port}`);
  console.log(`  요약 엔진: ${config.summarizer}${config.summarizer === 'claude' ? ` (${config.claude.model})` : ' (ANTHROPIC_API_KEY 미설정 → 데모 모드)'}`);
  console.log(`  STT: ${config.stt.mode} · 청크: ${config.chunk.minutes}분/${config.chunk.maxChars}자`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
