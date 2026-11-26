import { buildApp } from './app.ts';
import { getDb, closeDb } from './db/index.ts';
import { purgeExpiredSessions } from './auth.ts';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

async function main() {
  getDb(); // 首次启动时建库并应用 schema
  purgeExpiredSessions();

  const app = await buildApp({ logger: true });
  const close = async () => {
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  await app.listen({ port, host });
  console.log(`Hireloop API 已启动 → http://${host}:${port}`);
}

main().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});