import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { initialState, backupState, parseBackup, saveState, loadState } from '../src/lib/state';
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
});
