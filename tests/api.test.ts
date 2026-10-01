import { afterEach, describe, it, expect, vi } from 'vitest';
import { endpoint, runAgent } from '../src/lib/api';
import { DEFAULT_SETTINGS } from '../src/lib/state';
import type { AgentOptions } from '../src/types';
const response = (output: unknown[]) =>
  new Response(JSON.stringify({ status: 'completed', output }), {
    headers: { 'Content-Type': 'application/json' },
  });
const message = (text: string) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});
function options(extra: Partial<AgentOptions> = {}): AgentOptions {
  return {
    settings: { ...DEFAULT_SETTINGS, apiKey: 'secret' },
    history: [],
    text: '你好',
    attachments: [],
    files: [],
    tools: [],
    signal: new AbortController().signal,
    executeTool: vi.fn(async () => '{"ok":true}'),
    onText: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    ...extra,
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('stateless direct model connection', () => {
  it('accepts base or complete endpoint URLs without duplicating paths', () => {
    expect(endpoint('https://service.test/v1/responses', 'responses')).toBe(
      'https://service.test/v1/responses',
    );
    expect(endpoint('https://service.test/v1/chat/completions?x=1', 'models')).toBe(
      'https://service.test/v1/models?x=1',
    );
    expect(() => endpoint('javascript:alert(1)', 'responses')).toThrow();
  });
  it('uses store=false, includes reasoning, executes local tools and resends full history', async () => {
    const reasoning = { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'opaque' };
    const tool = {
      type: 'function_call',
      call_id: 'call1',
      name: 'read_file',
      arguments: '{"path":"a.txt"}',
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response([reasoning, tool]))
      .mockResolvedValueOnce(response([message('完成')]));
    vi.stubGlobal('fetch', fetch);
    const o = options();
    const result = await runAgent(o);
    expect(o.executeTool).toHaveBeenCalledWith({
      id: 'call1',
      name: 'read_file',
      arguments: tool.arguments,
    });
    expect(result.text).toBe('完成');
    const first = JSON.parse(fetch.mock.calls[0][1].body);
    const second = JSON.parse(fetch.mock.calls[1][1].body);
    expect(first).toMatchObject({
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
    });
    expect(first.previous_response_id).toBeUndefined();
    expect(second.input).toContainEqual(reasoning);
    expect(second.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call1',
      output: '{"ok":true}',
    });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
    expect(first).not.toHaveProperty('apiKey');
  });
  it('decodes split UTF-8 and CRLF SSE boundaries', async () => {
    const s =
      'data: ' +
      JSON.stringify({ type: 'response.output_text.delta', delta: '你好 🌿' }) +
      '\r\n\r\ndata: ' +
      JSON.stringify({ type: 'response.completed', response: { output: [message('你好 🌿')] } }) +
      '\r\n\r\n';
    const bytes = new TextEncoder().encode(s);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                for (const b of bytes) c.enqueue(Uint8Array.of(b));
                c.close();
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ),
    );
    const o = options();
    expect((await runAgent(o)).text).toBe('你好 🌿');
    expect(o.onText).toHaveBeenCalledWith('你好 🌿');
  });
  it('does not execute tool calls from a truncated response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'data: ' +
              JSON.stringify({
                type: 'response.output_item.done',
                output_index: 0,
                item: { type: 'function_call', call_id: 'x', name: 'write_file', arguments: '{}' },
              }) +
              '\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ),
    );
    const o = options();
    await expect(runAgent(o)).rejects.toThrow(/提前结束/);
    expect(o.executeTool).not.toHaveBeenCalled();
  });
  it('includes images inline without server file uploads', async () => {
    const fetch = vi.fn(async (_url: unknown, _init: RequestInit) => response([message('图片')]));
    vi.stubGlobal('fetch', fetch);
    await runAgent(
      options({
        attachments: [
          {
            path: 'image.png',
            kind: 'image',
            content: '',
            mime: 'image/png',
            size: 1,
            updatedAt: 0,
            dataUrl: 'data:image/png;base64,AA==',
          },
        ],
      }),
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body as string).input[0].content).toContainEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,AA==',
      detail: 'auto',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('supports Chat Completions tool continuation', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 't1',
                      type: 'function',
                      function: { name: 'list_files', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
          }),
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const o = options({ settings: { ...DEFAULT_SETTINGS, apiKey: 'secret', protocol: 'chat' } });
    expect((await runAgent(o)).text).toBe('OK');
    expect(fetch.mock.calls[0][0]).toContain('/chat/completions');
    expect(JSON.parse(fetch.mock.calls[1][1].body).messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 't1',
      content: '{"ok":true}',
    });
  });
  it('limits agent loops while preserving completed tool history', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response([{ type: 'function_call', call_id: 'x', name: 'list_files', arguments: '{}' }]),
      ),
    );
    const onHistory = vi.fn();
    await expect(
      runAgent(
        options({ settings: { ...DEFAULT_SETTINGS, apiKey: 'secret', maxRounds: 2 }, onHistory }),
      ),
    ).rejects.toThrow(/上限/);
    expect(onHistory.mock.lastCall?.[0].at(-1).type).toBe('function_call_output');
  });
});
