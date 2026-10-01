import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import {
  initialState,
  backupState,
  parseBackup,
  saveState,
  loadState,
  applyHandoff,
  restoreSettings,
} from '../src/lib/state';
import type { HandoffConnection } from '../src/lib/handoff';
describe('local persistence and backup', () => {
  it('never exports an API key', () => {
    const s = initialState();
    s.settings.apiKey = 'private-secret';
    s.settings.rememberKey = true;
    const backup = backupState(s);
    expect(backup).not.toContain('private-secret');
    expect(parseBackup(backup).settings.apiKey).toBe('');
  });
  it('does not persist a session key unless explicitly requested', async () => {
    const s = initialState();
    s.settings.apiKey = 'private-secret';
    await saveState(s);
    expect((await loadState())?.settings.apiKey).toBe('');
    s.settings.rememberKey = true;
    await saveState(s);
    expect((await loadState())?.settings.apiKey).toBe('private-secret');
  });
  it('serializes writes so the most recent state survives', async () => {
    const s = initialState();
    const first = saveState(s);
    s.settings.model = 'second';
    const second = saveState(s);
    await Promise.all([first, second]);
    expect((await loadState())?.settings.model).toBe('second');
  });
  it('rejects invalid or unsafe backup files', () => {
    const s = initialState();
    s.files = [
      { path: '../outside', kind: 'text', content: 'x', mime: 'text/plain', size: 1, updatedAt: 0 },
    ];
    expect(() => parseBackup(JSON.stringify(s))).toThrow(/路径/);
    expect(() => parseBackup('{}')).toThrow();
  });
  it('defaults new workspaces to gpt-6.1-sol', () => {
    expect(initialState().settings.model).toBe('gpt-6.1-sol');
  });
  it('applies a checked handoff atomically while preserving the workspace and history', () => {
    const s = initialState();
    s.files = [
      {
        path: 'notes.txt',
        kind: 'text',
        content: 'keep',
        mime: 'text/plain',
        size: 4,
        updatedAt: 1,
      },
    ];
    s.conversations[0].messages.push({
      id: 'message',
      role: 'user',
      content: 'previous conversation',
      createdAt: 1,
    });
    s.conversations[0].apiHistory.push({ role: 'user', content: 'previous conversation' });
    s.settings.apiKey = 'old-private-secret';
    s.settings.protocol = 'chat';
    s.settings.autoApprove = true;
    s.settings.systemPrompt = 'keep my instructions';
    const before = structuredClone(s);
    const connection: HandoffConnection = {
      gatewayUrl: 'https://codex.water555.com',
      baseUrl: 'https://codex.water555.com/v1',
      apiKey: 'new-private-secret',
      apiKeyId: 'new-key-id',
      rememberKey: false,
      protocol: 'responses',
    };
    const result = applyHandoff(s, connection, 'gemini-3-flash');
    expect(s).toEqual(before);
    expect(result.files).toBe(s.files);
    expect(result.changes).toBe(s.changes);
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations[1]).toBe(s.conversations[0]);
    expect(result.activeConversationId).toBe(result.conversations[0].id);
    expect(result.activeConversationId).not.toBe(s.activeConversationId);
    expect(result.conversations[0].messages).toEqual([]);
    expect(result.conversations[0].apiHistory).toEqual([]);
    expect(result.settings).toEqual({
      ...before.settings,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      model: 'gemini-3-flash',
      protocol: 'responses',
      rememberKey: false,
      connectionSource: { gatewayUrl: connection.gatewayUrl, apiKeyId: connection.apiKeyId },
    });
  });
  it('keeps connection identity across reload and backup without exporting the secret', async () => {
    const s = initialState();
    s.settings.apiKey = 'handoff-secret';
    s.settings.connectionSource = {
      gatewayUrl: 'https://codex.water555.com',
      apiKeyId: 'gateway-key-id',
    };
    await saveState(s);
    const restored = await loadState();
    expect(restored?.settings.apiKey).toBe('');
    expect(restored?.settings.connectionSource).toEqual(s.settings.connectionSource);
    s.settings.rememberKey = true;
    await saveState(s);
    expect((await loadState())?.settings.apiKey).toBe('handoff-secret');
    const backup = backupState(s);
    expect(backup).not.toContain('handoff-secret');
    const imported = parseBackup(backup);
    expect(imported.settings.rememberKey).toBe(false);
    expect(imported.settings.connectionSource).toEqual(s.settings.connectionSource);
    // Choosing not to remember a replacement removes any previously persisted key.
    s.settings.rememberKey = false;
    s.settings.apiKey = 'replacement-session-secret';
    await saveState(s);
    expect((await loadState())?.settings.apiKey).toBe('');
  });
  it('restores legacy backups and discards malformed optional connection metadata', () => {
    const s = initialState();
    s.settings.model = 'gpt-5.4';
    expect(parseBackup(JSON.stringify(s)).settings.model).toBe('gpt-5.4');
    expect(parseBackup(JSON.stringify(s)).settings.connectionSource).toBeUndefined();
    for (const source of [
      null,
      'invalid',
      {},
      { gatewayUrl: 'https://codex.water555.com', apiKeyId: '' },
      { gatewayUrl: 'https://codex.water555.com', apiKeyId: 123 },
      { gatewayUrl: 'https://codex.water555.com/path', apiKeyId: 'key-id' },
      { gatewayUrl: 'https://user:secret@codex.water555.com', apiKeyId: 'key-id' },
    ]) {
      const backup = JSON.stringify({
        ...s,
        settings: { ...s.settings, connectionSource: source },
      });
      expect(parseBackup(backup).settings.connectionSource).toBeUndefined();
    }
    expect(
      restoreSettings({
        connectionSource: { gatewayUrl: 'https://codex.water555.com/', apiKeyId: 'key-id' },
      }).connectionSource,
    ).toEqual({ gatewayUrl: 'https://codex.water555.com', apiKeyId: 'key-id' });
  });
});
