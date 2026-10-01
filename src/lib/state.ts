import type { AppState, Conversation, Settings } from '../types';
import {
  HANDOFF_PREFERRED_MODEL,
  TRUSTED_GATEWAY_URL,
  normalizeGatewayUrl,
  type HandoffConnection,
} from './handoff';
export const DEFAULT_SETTINGS: Settings = {
  baseUrl: TRUSTED_GATEWAY_URL.replace(/\/+$/, '') + '/v1',
  apiKey: '',
  model: HANDOFF_PREFERRED_MODEL,
  protocol: 'responses',
  reasoning: '',
  rememberKey: false,
  autoApprove: false,
  systemPrompt: '',
  maxRounds: 20,
};
export function newConversation(): Conversation {
  return {
    id: crypto.randomUUID(),
    title: '新的对话',
    messages: [],
    apiHistory: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
export function initialState(): AppState {
  const c = newConversation();
  return {
    version: 1,
    files: [],
    changes: [],
    conversations: [c],
    activeConversationId: c.id,
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** Drop malformed optional metadata from older or externally supplied workspaces. */
export function restoreSettings(value: Partial<Settings> | null | undefined): Settings {
  const settings = { ...DEFAULT_SETTINGS, ...value };
  if (!['responses', 'chat'].includes(settings.protocol)) settings.protocol = 'responses';
  const source = settings.connectionSource;
  delete settings.connectionSource;
  if (
    source &&
    typeof source.gatewayUrl === 'string' &&
    typeof source.apiKeyId === 'string' &&
    source.apiKeyId.length > 0 &&
    source.apiKeyId.length <= 256 &&
    !/[\s\x00-\x1f]/.test(source.apiKeyId)
  ) {
    try {
      settings.connectionSource = {
        gatewayUrl: normalizeGatewayUrl(source.gatewayUrl),
        apiKeyId: source.apiKeyId,
      };
    } catch {
      // Optional metadata cannot make an otherwise compatible backup unusable.
    }
  }
  return settings;
}

/** Apply only after a successful model check and any required user confirmation. */
export function applyHandoff(
  state: AppState,
  connection: HandoffConnection,
  model: string,
): AppState {
  const conversation = newConversation();
  return {
    ...state,
    conversations: [conversation, ...state.conversations],
    activeConversationId: conversation.id,
    settings: {
      ...state.settings,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      protocol: connection.protocol,
      model,
      rememberKey: connection.rememberKey,
      connectionSource: { gatewayUrl: connection.gatewayUrl, apiKeyId: connection.apiKeyId },
    },
  };
}
let dbPromise: Promise<IDBDatabase> | undefined;
function database() {
  return (dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('localdesk', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('state');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = undefined;
      reject(req.error);
    };
  }));
}
export async function loadState(): Promise<AppState | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const r = db.transaction('state').objectStore('state').get('workspace');
    r.onsuccess = () => {
      const state = r.result as AppState | undefined;
      resolve(state ? { ...state, settings: restoreSettings(state.settings) } : null);
    };
    r.onerror = () => reject(r.error);
  });
}
interface PendingSave {
  snapshot: AppState;
  waiters: { resolve: () => void; reject: (error: unknown) => void }[];
}
let pendingSave: PendingSave | null = null;
let flushing = false;
async function flushSaves() {
  if (flushing) return;
  flushing = true;
  try {
    while (pendingSave) {
      const job = pendingSave;
      pendingSave = null;
      try {
        const db = await database();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('state', 'readwrite');
          tx.objectStore('state').put(job.snapshot, 'workspace');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
        for (const waiter of job.waiters) waiter.resolve();
      } catch (error) {
        for (const waiter of job.waiters) waiter.reject(error);
      }
    }
  } finally {
    flushing = false;
  }
}
export function saveState(state: AppState): Promise<void> {
  const snapshot = structuredClone(state);
  if (!snapshot.settings.rememberKey) snapshot.settings.apiKey = '';
  return new Promise<void>((resolve, reject) => {
    if (pendingSave) {
      // Streaming can produce updates faster than IndexedDB commits. Retain only
      // the latest waiting snapshot, rather than queueing copies of large attachments.
      pendingSave.snapshot = snapshot;
      pendingSave.waiters.push({ resolve, reject });
    } else pendingSave = { snapshot, waiters: [{ resolve, reject }] };
    void flushSaves();
  });
}
export function backupState(state: AppState): string {
  const backup = structuredClone(state);
  backup.settings.apiKey = '';
  backup.settings.rememberKey = false;
  return JSON.stringify(backup, null, 2);
}
export function parseBackup(json: string): AppState {
  const x = JSON.parse(json) as AppState;
  if (
    x.version !== 1 ||
    !Array.isArray(x.files) ||
    !Array.isArray(x.conversations) ||
    !x.conversations.length
  )
    throw new Error('这不是有效的 Localdesk 工作区备份。');
  if (x.files.length > 2500 || x.conversations.length > 500) throw new Error('备份内容过大。');
  for (const f of x.files) {
    if (
      !f ||
      typeof f.path !== 'string' ||
      typeof f.content !== 'string' ||
      !['text', 'image', 'binary'].includes(f.kind)
    )
      throw new Error('备份文件格式无效。');
    if (/^(\/|[a-z]:)|(^|[\\/])\.\.([\\/]|$)|[\x00-\x1f]/i.test(f.path))
      throw new Error('备份包含无效路径。');
    if (f.dataUrl && !/^data:[^;,]*;base64,[a-z\d+/=\s]+$/i.test(f.dataUrl))
      throw new Error('备份附件格式无效。');
  }
  if (new Set(x.files.map((f) => f.path)).size !== x.files.length)
    throw new Error('备份包含重复文件。');
  for (const c of x.conversations) {
    if (
      typeof c.id !== 'string' ||
      typeof c.title !== 'string' ||
      !Array.isArray(c.messages) ||
      !Array.isArray(c.apiHistory)
    )
      throw new Error('备份对话格式无效。');
    for (const m of c.messages)
      if (!['user', 'assistant', 'tool'].includes(m.role) || typeof m.content !== 'string')
        throw new Error('备份消息格式无效。');
  }
  // API history is compatible only with the selected protocol stored in the backup.
  x.settings = { ...restoreSettings(x.settings), apiKey: '', rememberKey: false };
  x.changes = Array.isArray(x.changes) ? x.changes.slice(-100) : [];
  if (!x.conversations.some((c) => c.id === x.activeConversationId))
    x.activeConversationId = x.conversations[0].id;
  return x;
}
