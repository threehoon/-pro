import Lark from '@larksuiteoapi/node-sdk';
import { storedBitableConfig } from './bitable.ts';
import { feishuAppCredentials } from './feishu.ts';
import { applyBitableEvent, normalizeBitableEvent, recordBitableEvent } from '../services/bitable-sync.ts';

export interface BitableEventState {
  running: boolean;
  startedAt: string | null;
  lastError: string | null;
  lastEventAt: string | null;
  connection: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
}

let client: Lark.WSClient | null = null;
let state: BitableEventState = {
  running: false,
  startedAt: null,
  lastError: null,
  lastEventAt: null,
  connection: 'idle',
};

export function bitableEventState(): BitableEventState {
  return { ...state };
}

export interface StartResult {
  started: boolean;
  reason: string;
}

/**
 * 用飞书长连接收「多维表格记录变更」事件：不需要公网回调地址，建连即鉴权。
 * 注意事件必须在 3 秒内应答，所以这里只落库，真正的回写交给队列。
 */
export function startBitableEvents(): StartResult {
  // 测试里不建长连接：会真的去连飞书并留下重连定时器，测试只需要 handleBitableEventForTest。
  if (process.env.NODE_ENV === 'test') return { started: false, reason: '测试环境不建长连接' };
  // 同一个库被两个进程服务时，长连接只能有一个持有者，否则同一事件会被处理两遍。
  if (process.env.HIRELOOP_BITABLE === 'off') {
    return { started: false, reason: '本实例以 HIRELOOP_BITABLE=off 运行，同步交给另一个实例' };
  }
  const config = storedBitableConfig();
  if (!config.enabled) return { started: false, reason: '多维表格同步没有开启' };
  if (!config.appToken) return { started: false, reason: '还没有填写 Base 的 app_token' };
  const credentials = feishuAppCredentials();
  if (!credentials) return { started: false, reason: '还没有配置飞书应用凭证' };
  if (state.running) return { started: true, reason: '长连接已经在运行' };

  const dispatcher = new Lark.EventDispatcher({}).register({
    'drive.file.bitable_record_changed_v1': async (data: unknown) => {
      await handleRecordChanged(data);
    },
  });

  try {
    client = new Lark.WSClient({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      autoReconnect: true,
      onReady: () => {
        state = { ...state, connection: 'connected', lastError: null };
      },
      onReconnecting: () => {
        state = { ...state, connection: 'reconnecting' };
      },
      onReconnected: () => {
        state = { ...state, connection: 'connected' };
      },
      onError: (error: Error) => {
        state = { ...state, connection: 'failed', lastError: error.message, running: false };
      },
    });
    client.start({ eventDispatcher: dispatcher });
  } catch (error) {
    state = { ...state, lastError: error instanceof Error ? error.message : String(error), connection: 'failed' };
    return { started: false, reason: state.lastError ?? '长连接启动失败' };
  }

  state = { running: true, startedAt: new Date().toISOString(), lastError: null, lastEventAt: null, connection: 'connecting' };
  return { started: true, reason: '长连接已启动' };
}

export function stopBitableEvents(): void {
  if (client) {
    try {
      client.close({ force: true });
    } catch {
      // 关闭失败不影响进程退出
    }
  }
  client = null;
  state = { ...state, running: false, connection: 'idle' };
}

/** 配置改完后重新建连（凭证或开关变了都要重连，否则旧连接还在收旧表的事件）。 */
export function restartBitableEvents(): StartResult {
  stopBitableEvents();
  return startBitableEvents();
}

async function handleRecordChanged(raw: unknown): Promise<void> {
  const config = storedBitableConfig();
  const event = normalizeBitableEvent(raw, config.fields);
  if (!event) return;
  state = { ...state, lastEventAt: new Date().toISOString() };
  if (!recordBitableEvent(event, raw)) return;
  // 立即返回给飞书，回写异步做：3 秒内不 ack 会被记成超时并重推。
  setTimeout(() => {
    void applyBitableEvent(event).catch(() => undefined);
  }, 0);
}

/** 测试用：直接喂一个事件体，走和线上一样的解析与写入逻辑。 */
export async function handleBitableEventForTest(raw: unknown): Promise<{ applied: number; ignored: number; conflicts: number } | null> {
  const config = storedBitableConfig();
  const event = normalizeBitableEvent(raw, config.fields);
  if (!event) return null;
  recordBitableEvent(event, raw);
  return applyBitableEvent(event);
}
