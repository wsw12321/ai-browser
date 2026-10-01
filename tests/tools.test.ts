import { describe, it, expect } from 'vitest';
import { applyChanges, planChanges, readTool } from '../src/lib/tools';
import { normalizePath, textFile } from '../src/lib/files';
const call = (name: string, args: unknown) => ({
  id: 'test',
  name,
  arguments: JSON.stringify(args),
});
describe('local workspace tools', () => {
  it.each(['../secret', '/etc/passwd', 'C:\\secret', 'a/../../key', '\0x'])(
    'rejects paths outside the workspace: %s',
    (path) => expect(() => normalizePath(path)).toThrow(),
  );
  it('normalizes relative paths', () =>
    expect(normalizePath('./folder\\notes.md')).toBe('folder/notes.md'));
  it('reads exact requested lines and searches locally', () => {
    const files = [textFile('notes.txt', 'alpha\nbeta\ngamma')];
    expect(
      JSON.parse(
        readTool(call('read_file', { path: 'notes.txt', start_line: 2, end_line: 2 }), files)!,
      ),
    ).toMatchObject({ content: 'beta', total_lines: 3 });
    expect(JSON.parse(readTool(call('search_files', { query: 'beta' }), files)!)).toMatchObject({
      hits: [{ path: 'notes.txt', line: 2, text: 'beta' }],
    });
  });
  it('rejects unsupported execution commands', () =>
    expect(() => planChanges(call('exec_command', { cmd: 'npm install' }), [])).toThrow(
      /浏览器不支持/,
    ));
  it('requires a unique edit context', () =>
    expect(() =>
      planChanges(call('edit_file', { path: 'n.txt', old_text: 'x', new_text: 'y' }), [
        textFile('n.txt', 'xx'),
      ]),
    ).toThrow(/多次/));
  it('plans changes without mutating files and retains undo snapshots', () => {
    const files = [textFile('n.txt', 'before')];
    const changes = planChanges(call('write_file', { path: 'n.txt', content: 'after' }), files);
    expect(files[0].content).toBe('before');
    expect(changes[0].before?.content).toBe('before');
    expect(applyChanges(files, changes)[0].content).toBe('after');
    expect(
      applyChanges(applyChanges(files, changes), [{ ...changes[0], after: changes[0].before }])[0]
        .content,
    ).toBe('before');
  });
  it('never overwrites original binary documents with text', () =>
    expect(() =>
      planChanges(call('write_file', { path: 'a.pdf', content: 'new' }), [
        { ...textFile('a.pdf', 'extracted'), kind: 'binary' },
      ]),
    ).toThrow(/二进制/));
  it('applies Codex style add, update and delete atomically', () => {
    const files = [textFile('a.txt', 'one\ntwo\n'), textFile('old.txt', 'old')];
    const patch =
      '*** Begin Patch\n*** Add File: new.md\n+hello\n*** Update File: a.txt\n@@\n one\n-two\n+three\n*** Delete File: old.txt\n*** End Patch';
    const changes = planChanges(call('apply_patch', { patch }), files);
    const next = applyChanges(files, changes);
    expect(next.map((f) => f.path)).toEqual(['a.txt', 'new.md']);
    expect(next[0].content).toBe('one\nthree\n');
    expect(files[0].content).toBe('one\ntwo\n');
  });
  it('rejects a whole patch if one update fails', () => {
    const files = [textFile('a.txt', 'a')];
    expect(() =>
      planChanges(
        call('apply_patch', {
          patch:
            '*** Begin Patch\n*** Add File: n.txt\n+ok\n*** Update File: a.txt\n@@\n-missing\n+oops\n*** End Patch',
        }),
        files,
      ),
    ).toThrow();
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe('a');
  });
});
