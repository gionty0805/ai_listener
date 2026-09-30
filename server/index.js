import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const { server } = await createApp(config);

server.listen(config.port, () => {
  console.log(`AI Listener → http://localhost:${config.port}`);
  console.log(`  요약 엔진: ${config.summarizer}${config.summarizer === 'claude' ? ` (${config.claude.model})` : ' (ANTHROPIC_API_KEY 미설정 → 데모 모드)'}`);
  console.log(`  STT: ${config.stt.mode} · 청크: ${config.chunk.minutes}분/${config.chunk.maxChars}자`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
