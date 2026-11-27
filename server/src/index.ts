import { buildApp } from './app.ts';
import { getDb, closeDb } from './db/index.ts';
import { purgeExpiredSessions } from './auth.ts';
import { bitableStatus } from './integrations/bitable.ts';
import { startBitableEvents, stopBitableEvents } from './integrations/bitable-events.ts';
import { reconcileBitable } from './services/bitable-sync.ts';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

async function main() {
  getDb(); // 首次启动时建库并应用 schema
  purgeExpiredSessions();

  const app = await buildApp({ logger: true });
  const close = async () => {
    stopBitableEvents();
    clearInterval(reconcileTimer);
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  await app.listen({ port, host });
  console.log(`Hireloop API 已启动 → http://${host}:${port}`);

  const connection = startBitableEvents();
  if (!connection.started) console.log(`多维表格长连接未启动：${connection.reason}`);

  let reconciling = false;
  const reconcileTimer = setInterval(() => {
    const status = bitableStatus();
    if (!status.enabled || !status.appToken || !status.fallbackMinutes || reconciling) return;
    const last = status.lastReconcileAt ? Date.parse(status.lastReconcileAt) : 0;
    if (Date.now() - last < status.fallbackMinutes * 60_000) return;
    reconciling = true;
    void reconcileBitable()
      .catch((error: unknown) => console.error('多维表格兜底对账失败:', error))
      .finally(() => {
        reconciling = false;
      });
  }, 60_000);
  reconcileTimer.unref();
}

main().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});