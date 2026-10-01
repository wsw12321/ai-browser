import type { Settings } from '../types';

export const HANDOFF_PREFERRED_MODEL = 'gpt-6.1-sol';
export const TRUSTED_GATEWAY_URL =
  import.meta.env.VITE_GATEWAY_URL?.trim() || 'https://codex.water555.com';

export interface HandoffConnection {
  gatewayUrl: string;
  baseUrl: string;
  apiKey: string;
  apiKeyId: string;
  rememberKey: boolean;
  protocol: 'responses';
}

export interface BrowserHandoff {
  gatewayUrl: string;
  /** A rejected exchange is also retained: the one-time code must never be retried. */
  exchange(): Promise<HandoffConnection>;
}

export interface HandoffModel {
  model: string;
  fallback: boolean;
  isGemini: boolean;
}

// Keep aligned with the gateway's config.AntigravityModels native CPA catalog.
const GEMINI_MODELS = new Set([
  'gemini-pro-agent',
  'gemini-3.1-pro-low',
  'gemini-3-flash',
  'gemini-3.6-flash-high',
  'gemini-3.7-flash-high',
  'gemini-3.8-flash-high',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
]);

export function normalizeGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('可信网关地址配置无效。');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('可信网关地址必须是完整的 HTTP 或 HTTPS Origin。');
  return url.origin;
}

function apiBaseMatches(value: string, gatewayUrl: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === gatewayUrl &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/v1\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function parseConnection(value: unknown, gatewayUrl: string): HandoffConnection {
  if (!value || typeof value !== 'object') throw new Error('网关接入响应格式无效。');
  const data = value as Record<string, unknown>;
  if (
    typeof data.base_url !== 'string' ||
    !apiBaseMatches(data.base_url, gatewayUrl) ||
    typeof data.api_key !== 'string' ||
    !data.api_key ||
    data.api_key.length > 4096 ||
    /\s/.test(data.api_key) ||
    typeof data.api_key_id !== 'string' ||
    !data.api_key_id ||
    data.api_key_id.length > 256 ||
    /[\s\x00-\x1f]/.test(data.api_key_id) ||
    typeof data.remember_key !== 'boolean' ||
    data.protocol !== 'responses'
  )
    throw new Error('网关接入响应无效，请返回网关重新接入。');
  return {
    gatewayUrl,
    baseUrl: gatewayUrl + '/v1',
    apiKey: data.api_key,
    apiKeyId: data.api_key_id,
    rememberKey: data.remember_key,
    protocol: 'responses',
  };
}

let captured: BrowserHandoff | null | undefined;

/** Call before mounting React, so no render, effect, or request sees the code URL. */
export function captureBrowserHandoff(
  location: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location,
  history: Pick<History, 'replaceState' | 'state'> = window.history,
): BrowserHandoff | null {
  if (captured !== undefined) return captured;
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (!fragment.has('handoff_version') && !fragment.has('code')) return (captured = null);

  // Remove the entire handoff fragment even when the protocol or code is invalid.
  history.replaceState(history.state, '', location.pathname + location.search);
  let code = fragment.get('code') ?? '';
  let invalid =
    fragment.get('handoff_version') !== '1' ||
    fragment.getAll('handoff_version').length !== 1 ||
    fragment.getAll('code').length !== 1 ||
    !/^cgb_v1_[A-Za-z0-9_-]{43}$/.test(code);
  let gatewayUrl: string;
  try {
    gatewayUrl = normalizeGatewayUrl(TRUSTED_GATEWAY_URL);
  } catch {
    invalid = true;
    gatewayUrl = 'https://codex.water555.com';
  }
  let exchange: Promise<HandoffConnection> | undefined;
  captured = {
    gatewayUrl,
    exchange() {
      if (exchange) return exchange;
      const oneTimeCode = code;
      code = '';
      exchange = (async () => {
        if (invalid) throw new Error('连接码或接入配置无效，请返回网关重新接入。');
        let response: Response;
        try {
          response = await fetch(gatewayUrl + '/browser-handoffs/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: oneTimeCode }),
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            cache: 'no-store',
            signal: AbortSignal.timeout(20000),
          });
        } catch {
          // Do not surface arbitrary server/network text that could echo the code.
          throw new Error('无法兑换连接码，请检查网络后返回网关重新接入。');
        }
        if (!response.ok) throw new Error('连接码已失效或无法使用，请返回网关重新接入。');
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new Error('网关接入响应格式无效，请返回网关重新接入。');
        }
        return parseConnection(body, gatewayUrl);
      })();
      return exchange;
    },
  };
  return captured;
}

export function chooseHandoffModel(ids: string[]): HandoffModel {
  const visible = new Set(ids.filter((id) => id !== 'codex-auto-review'));
  const model = visible.has(HANDOFF_PREFERRED_MODEL)
    ? HANDOFF_PREFERRED_MODEL
    : [...visible].filter((id) => /^gpt-[a-z0-9][a-z0-9._-]*$/.test(id)).sort()[0] ||
      [...visible].filter((id) => GEMINI_MODELS.has(id)).sort()[0];
  if (!model) throw new Error('此密钥没有可用的 GPT 或 Gemini 模型，请返回网关调整模型权限。');
  return {
    model,
    fallback: model !== HANDOFF_PREFERRED_MODEL,
    isGemini: GEMINI_MODELS.has(model),
  };
}

/** Retrying the inexpensive model check never exchanges the one-time code again. */
export async function checkHandoffModels(
  connection: HandoffConnection,
  signal?: AbortSignal,
): Promise<HandoffModel> {
  const gatewayUrl = normalizeGatewayUrl(TRUSTED_GATEWAY_URL);
  if (connection.gatewayUrl !== gatewayUrl || !apiBaseMatches(connection.baseUrl, gatewayUrl))
    throw new Error('连接不属于可信网关，请返回网关重新接入。');
  let response: Response;
  try {
    response = await fetch(connection.baseUrl + '/models', {
      headers: { Authorization: `Bearer ${connection.apiKey}` },
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error('无法检查模型权限，请检查网络和网关跨域设置后重试。');
  }
  if (!response.ok) throw new Error(`检查模型权限失败（${response.status}），请重试。`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('模型列表格式无效，请重试。');
  }
  if (!body || typeof body !== 'object' || !Array.isArray((body as { data?: unknown }).data))
    throw new Error('模型列表格式无效，请重试。');
  return chooseHandoffModel(
    (body as { data: unknown[] }).data.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const id = (entry as { id?: unknown }).id;
      return typeof id === 'string' ? [id] : [];
    }),
  );
}

export function isDifferentConnection(settings: Settings, connection: HandoffConnection): boolean {
  if (settings.connectionSource) {
    let previousGateway: string;
    try {
      previousGateway = normalizeGatewayUrl(settings.connectionSource.gatewayUrl);
    } catch {
      return true;
    }
    if (
      previousGateway !== connection.gatewayUrl ||
      settings.connectionSource.apiKeyId !== connection.apiKeyId
    )
      return true;
  }
  return (
    !apiBaseMatches(settings.baseUrl, connection.gatewayUrl) ||
    settings.protocol !== connection.protocol ||
    (!!settings.apiKey.trim() && settings.apiKey.trim() !== connection.apiKey)
  );
}
