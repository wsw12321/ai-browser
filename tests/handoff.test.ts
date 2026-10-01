import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HandoffConnection } from '../src/lib/handoff';
import type { Settings } from '../src/types';

const CODE = 'cgb_v1_' + 'a'.repeat(43);
const gatewayUrl = 'https://codex.water555.com';
const wireConnection = {
  base_url: gatewayUrl + '/v1',
  api_key: 'private-api-key',
  api_key_id: 'key-id',
  remember_key: false,
  protocol: 'responses',
};
const connection: HandoffConnection = {
  gatewayUrl,
  baseUrl: gatewayUrl + '/v1',
  apiKey: 'private-api-key',
  apiKeyId: 'key-id',
  rememberKey: false,
  protocol: 'responses',
};

function fragment(code = CODE, version = '1') {
  return {
    hash: `#handoff_version=${version}&code=${code}`,
    pathname: '/desk',
    search: '?theme=dark',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('browser handoff bootstrap and exchange', () => {
  it('scrubs the fragment synchronously and shares one exchange under repeated mounting', async () => {
    const { captureBrowserHandoff } = await import('../src/lib/handoff');
    const history = { state: { position: 2 }, replaceState: vi.fn() };
    const fetch = vi.fn().mockResolvedValue(Response.json(wireConnection));
    vi.stubGlobal('fetch', fetch);
    const handoff = captureBrowserHandoff(fragment(), history)!;
    expect(history.replaceState).toHaveBeenCalledWith({ position: 2 }, '', '/desk?theme=dark');
    expect(fetch).not.toHaveBeenCalled();
    expect(captureBrowserHandoff({ ...fragment(), hash: '' }, history)).toBe(handoff);
    const first = handoff.exchange();
    expect(handoff.exchange()).toBe(first);
    await expect(first).resolves.toEqual(connection);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(gatewayUrl + '/browser-handoffs/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: CODE }),
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
  });

  it('leaves an ordinary navigation fragment alone', async () => {
    const { captureBrowserHandoff } = await import('../src/lib/handoff');
    const history = { state: null, replaceState: vi.fn() };
    expect(captureBrowserHandoff({ ...fragment(), hash: '#files' }, history)).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it.each([
    '#handoff_version=2&code=' + CODE,
    '#handoff_version=1&code=too-short',
    '#handoff_version=1&code=' + CODE + '&code=' + CODE,
    '#handoff_version=1&handoff_version=1&code=' + CODE,
    '#code=' + CODE,
    '#handoff_version=1',
  ])('scrubs malformed fragment %s without sending a request', async (hash) => {
    const { captureBrowserHandoff } = await import('../src/lib/handoff');
    const history = { state: null, replaceState: vi.fn() };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const handoff = captureBrowserHandoff({ ...fragment(), hash }, history)!;
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    await expect(handoff.exchange()).rejects.toThrow('连接码或接入配置无效');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never retries an uncertain or failed exchange and never exposes server text', async () => {
    const { captureBrowserHandoff } = await import('../src/lib/handoff');
    const fetch = vi.fn().mockResolvedValue(new Response('secret echo: ' + CODE, { status: 410 }));
    vi.stubGlobal('fetch', fetch);
    const handoff = captureBrowserHandoff(fragment(), { state: null, replaceState: vi.fn() })!;
    await expect(handoff.exchange()).rejects.toThrow('连接码已失效');
    await expect(handoff.exchange()).rejects.not.toThrow(CODE);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('redacts network failures even if the failure contains the code', async () => {
    const { captureBrowserHandoff } = await import('../src/lib/handoff');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(CODE)));
    const handoff = captureBrowserHandoff(fragment(), { state: null, replaceState: vi.fn() })!;
    await expect(handoff.exchange()).rejects.toThrow('无法兑换连接码');
    await expect(handoff.exchange()).rejects.not.toThrow(CODE);
  });

  it.each([
    { base_url: 'https://attacker.example/v1' },
    { base_url: gatewayUrl + '/other/v1' },
    { base_url: gatewayUrl + '/v1?forward=attacker' },
    { base_url: gatewayUrl + '/v1#secret' },
    { base_url: 'https://user:password@codex.water555.com/v1' },
    { api_key: '' },
    { api_key: 'bad\nheader' },
    { api_key_id: '' },
    { api_key_id: 22 },
    { remember_key: 'false' },
    { protocol: 'chat' },
  ])('rejects invalid exchange data %j without disclosing the secret', async (changes) => {
    const { captureBrowserHandoff } = await import('../src/lib/handoff');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ ...wireConnection, ...changes })),
    );
    const handoff = captureBrowserHandoff(fragment(), { state: null, replaceState: vi.fn() })!;
    await expect(handoff.exchange()).rejects.toThrow('网关接入响应无效');
    await expect(handoff.exchange()).rejects.not.toThrow(wireConnection.api_key);
  });

  it('uses only the configured origin and ignores fragment redirect or gateway parameters', async () => {
    vi.stubEnv('VITE_GATEWAY_URL', 'http://127.0.0.1:8172/');
    const { captureBrowserHandoff, checkHandoffModels } = await import('../src/lib/handoff');
    const localGateway = 'http://127.0.0.1:8172';
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...wireConnection, base_url: localGateway + '/v1/' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'gpt-6.1-sol' }] }));
    vi.stubGlobal('fetch', fetch);
    const handoff = captureBrowserHandoff(
      { ...fragment(), hash: fragment().hash + '&gateway=https://attacker.example' },
      { state: null, replaceState: vi.fn() },
    )!;
    const localConnection = await handoff.exchange();
    expect(localConnection.gatewayUrl).toBe(localGateway);
    expect(localConnection.baseUrl).toBe(localGateway + '/v1');
    await checkHandoffModels(localConnection);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      localGateway + '/browser-handoffs/exchange',
      localGateway + '/v1/models',
    ]);
  });

  it('does not send a code to malformed trusted configuration', async () => {
    vi.stubEnv('VITE_GATEWAY_URL', 'https://gateway.example/path');
    const { captureBrowserHandoff } = await import('../src/lib/handoff');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const handoff = captureBrowserHandoff(fragment(), { state: null, replaceState: vi.fn() })!;
    await expect(handoff.exchange()).rejects.toThrow('接入配置无效');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('model permission check', () => {
  it('prefers gpt-6.1-sol and sorts other GPT models before supported Gemini models', async () => {
    const { chooseHandoffModel } = await import('../src/lib/handoff');
    expect(chooseHandoffModel(['gpt-5.4', 'gpt-6.1-sol', 'gemini-3-flash'])).toEqual({
      model: 'gpt-6.1-sol',
      fallback: false,
      isGemini: false,
    });
    expect(chooseHandoffModel(['gemini-3-flash', 'gpt-5.5', 'gpt-5.4'])).toEqual({
      model: 'gpt-5.4',
      fallback: true,
      isGemini: false,
    });
    expect(
      chooseHandoffModel(['gemini-pro-agent', 'gemini-3.5-flash-lite', 'gemini-3-flash']),
    ).toEqual({
      model: 'gemini-3-flash',
      fallback: true,
      isGemini: true,
    });
  });

  it('excludes auto-review, retired Gemini aliases and unrecognized model families', async () => {
    const { chooseHandoffModel } = await import('../src/lib/handoff');
    expect(() =>
      chooseHandoffModel([
        'codex-auto-review',
        'gemini-3.1-pro-high',
        'gemini-unknown',
        'claude-sonnet',
        'gpt-bad\nname',
      ]),
    ).toThrow('没有可用');
  });

  it('retries models with the exchanged key without repeating exchange or paid requests', async () => {
    const { captureBrowserHandoff, checkHandoffModels } = await import('../src/lib/handoff');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(wireConnection))
      .mockResolvedValueOnce(new Response('secret: ' + connection.apiKey, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [null, { id: 1 }, {}, { id: 'gpt-6.1-sol' }] }));
    vi.stubGlobal('fetch', fetch);
    const handoff = captureBrowserHandoff(fragment(), { state: null, replaceState: vi.fn() })!;
    const result = await handoff.exchange();
    await expect(checkHandoffModels(result)).rejects.toThrow('503');
    await expect(checkHandoffModels(result)).resolves.toEqual({
      model: 'gpt-6.1-sol',
      fallback: false,
      isGemini: false,
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      gatewayUrl + '/browser-handoffs/exchange',
      gatewayUrl + '/v1/models',
      gatewayUrl + '/v1/models',
    ]);
    expect(fetch.mock.calls[2][1]).toMatchObject({
      headers: { Authorization: 'Bearer ' + connection.apiKey },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  });

  it('rejects untrusted model URLs before sending the API key', async () => {
    const { checkHandoffModels } = await import('../src/lib/handoff');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      checkHandoffModels({ ...connection, baseUrl: 'https://attacker.example/v1' }),
    ).rejects.toThrow('可信网关');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, {}, { data: 'models' }, { data: [] }])(
    'reports invalid or empty model list %j',
    async (body) => {
      const { checkHandoffModels } = await import('../src/lib/handoff');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
      await expect(checkHandoffModels(connection)).rejects.toThrow();
    },
  );
});

describe('connection switch decision', () => {
  async function defaults(): Promise<Settings> {
    return { ...(await import('../src/lib/state')).DEFAULT_SETTINGS };
  }

  it('connects a new workspace and the same known key without asking to switch', async () => {
    const { isDifferentConnection } = await import('../src/lib/handoff');
    const settings = await defaults();
    expect(isDifferentConnection(settings, connection)).toBe(false);
    settings.connectionSource = { gatewayUrl, apiKeyId: connection.apiKeyId };
    expect(isDifferentConnection(settings, connection)).toBe(false);
    settings.apiKey = connection.apiKey;
    expect(isDifferentConnection(settings, connection)).toBe(false);
  });

  it('detects changed source, API key, endpoint or protocol while preserving settings', async () => {
    const { isDifferentConnection } = await import('../src/lib/handoff');
    const settings = await defaults();
    for (const patch of [
      { connectionSource: { gatewayUrl, apiKeyId: 'another-key' } },
      { connectionSource: { gatewayUrl: 'https://other.example', apiKeyId: 'key-id' } },
      { apiKey: 'previous-secret' },
      { baseUrl: 'https://other.example/v1' },
      { protocol: 'chat' as const },
    ]) {
      const candidate = { ...settings, ...patch };
      const snapshot = structuredClone(candidate);
      expect(isDifferentConnection(candidate, connection)).toBe(true);
      expect(candidate).toEqual(snapshot);
    }
  });
});
