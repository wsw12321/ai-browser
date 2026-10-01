import type { FileChange, ToolCall, ToolDefinition, WorkspaceFile } from '../types';
import { normalizePath, textFile } from './files';
export const toolDefinitions: ToolDefinition[] = [
  tool(
    'list_files',
    'List all local workspace files. Nothing outside this workspace is accessible.',
    {},
  ),
  tool(
    'read_file',
    'Read a local text file or locally extracted PDF/DOCX text, optionally a line range. For images the user must attach them to a message. Never claim to have read unsupported binary formats.',
    {
      path: { type: 'string' },
      start_line: { type: ['integer', 'null'] },
      end_line: { type: ['integer', 'null'] },
    },
  ),
  tool(
    'search_files',
    'Search for literal text across workspace text and extracted documents. Returns matching lines.',
    { query: { type: 'string' } },
  ),
  tool(
    'write_file',
    'Create or replace a UTF-8 text file. Changes require user approval unless auto-approve is enabled. Never overwrite binary documents; create a new text result.',
    { path: { type: 'string' }, content: { type: 'string' } },
  ),
  tool(
    'edit_file',
    'Replace an exact unique text fragment in a text file. Fails if the fragment is absent or ambiguous.',
    { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
  ),
  tool('delete_file', 'Delete a workspace file, with approval. Changes are reversible.', {
    path: { type: 'string' },
  }),
  tool(
    'apply_patch',
    'Apply Codex style patches: *** Begin Patch, *** Add File: path (+ lines), *** Update File: path (@@ followed by context/+/− lines), *** Delete File: path, *** End Patch. Updates require exact unique context. Atomic and reversible.',
    { patch: { type: 'string' } },
  ),
  tool(
    'run_javascript',
    'Run synchronous JavaScript in a local QuickJS WebAssembly sandbox. Available: readFile(path), writeFile(path, text), listFiles(), console.log(...). Returns last expression and logs; writes require approval. No network, browser APIs, process, Node.js, Python, shell, package installation, DOM or OS access. 5 second CPU limit, 32 MB memory. Use for data analysis, calculations and generation.',
    { code: { type: 'string' } },
  ),
];
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
): ToolDefinition {
  return {
    type: 'function',
    name,
    description,
    strict: true,
    parameters: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  };
}
export function parseArgs(call: ToolCall): Record<string, unknown> {
  const args = JSON.parse(call.arguments);
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('工具参数必须是 JSON 对象。');
  return args;
}
function required(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string') throw new Error(`缺少文字参数 ${key}。`);
  return args[key];
}
export function readTool(call: ToolCall, files: WorkspaceFile[]): string | undefined {
  const args = parseArgs(call);
  if (call.name === 'list_files')
    return JSON.stringify(
      files.map((f) => ({
        path: f.path,
        kind: f.kind,
        size: f.size,
        readable: f.kind === 'text' || !!f.content,
      })),
      null,
      2,
    );
  if (call.name === 'read_file') {
    const path = normalizePath(required(args, 'path'));
    const f = files.find((f) => f.path === path);
    if (!f) throw new Error(`文件不存在：${path}`);
    if (f.kind === 'image')
      throw new Error('这是图片，请让用户把该图片附加到消息，再进行视觉分析。');
    if (f.kind === 'binary' && !f.content)
      throw new Error('浏览器无法读取这种二进制格式。请提供文本、CSV、PDF、DOCX 或图片。');
    const lines = f.content.split('\n');
    const start = args.start_line ?? 1;
    const end = args.end_line ?? Math.min(lines.length, (start as number) + 999);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      (start as number) < 1 ||
      (end as number) < (start as number)
    )
      throw new Error('行号必须是有效正整数。');
    return JSON.stringify({
      path,
      total_lines: lines.length,
      start_line: start,
      end_line: Math.min(end as number, lines.length),
      content: lines
        .slice((start as number) - 1, end as number)
        .join('\n')
        .slice(0, 100000),
      note: 'Large content may be truncated. Request additional line ranges if needed.',
    });
  }
  if (call.name === 'search_files') {
    const query = required(args, 'query');
    if (!query) throw new Error('搜索词不能为空。');
    const hits = [];
    for (const f of files)
      for (const [i, line] of f.content.split('\n').entries())
        if (line.includes(query)) {
          hits.push({ path: f.path, line: i + 1, text: line.slice(0, 1000) });
          if (hits.length === 100) return JSON.stringify({ hits, truncated: true });
        }
    return JSON.stringify({ hits, truncated: false });
  }
  return undefined;
}
export function planChanges(call: ToolCall, files: WorkspaceFile[]): FileChange[] {
  const args = parseArgs(call);
  let ops: { path: string; content: string | null }[] = [];
  if (call.name === 'write_file')
    ops = [{ path: required(args, 'path'), content: required(args, 'content') }];
  else if (call.name === 'delete_file') ops = [{ path: required(args, 'path'), content: null }];
  else if (call.name === 'edit_file') {
    const path = normalizePath(required(args, 'path'));
    const f = files.find((f) => f.path === path);
    if (!f) throw new Error('文件不存在。');
    const old = required(args, 'old_text');
    if (!old || !f.content.includes(old)) throw new Error('找不到要替换的文字。');
    if (f.content.indexOf(old) !== f.content.lastIndexOf(old))
      throw new Error('该文字出现多次，请提供更完整的上下文。');
    ops = [{ path, content: f.content.replace(old, required(args, 'new_text')) }];
  } else if (call.name === 'apply_patch') ops = parsePatch(required(args, 'patch'), files);
  else
    throw new Error(
      `浏览器不支持工具 ${call.name}。系统命令、安装软件、Python 与终端操作无法执行；可改用 run_javascript 本地沙盒。`,
    );
  return ops.map(({ path, content }) => {
    path = normalizePath(path);
    const before = files.find((f) => f.path === path) ?? null;
    if (content === null && !before) throw new Error(`文件不存在：${path}`);
    if (content !== null && before && before.kind !== 'text')
      throw new Error('不能用文字覆盖原始图片或二进制文档，请创建新的文本文件。');
    return {
      id: crypto.randomUUID(),
      path,
      before,
      after: content === null ? null : textFile(path, content),
      timestamp: Date.now(),
      source: 'ai',
    };
  });
}
function parsePatch(
  patch: string,
  files: WorkspaceFile[],
): { path: string; content: string | null }[] {
  const lines = patch.replace(/\r\n/g, '\n').trimEnd().split('\n');
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch')
    throw new Error('补丁必须用 *** Begin Patch 与 *** End Patch 包围。');
  const ops: { path: string; content: string | null }[] = [];
  let i = 1;
  while (i < lines.length - 1) {
    const header = lines[i++];
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(header);
    if (!match) throw new Error(`无法识别补丁行：${header}`);
    const [, action, raw] = match;
    const path = normalizePath(raw);
    if (ops.some((o) => o.path === path)) throw new Error('同一个补丁不能重复操作同一文件。');
    const file = files.find((f) => f.path === path);
    if (action === 'Delete') {
      if (!file) throw new Error(`文件不存在：${path}`);
      ops.push({ path, content: null });
      continue;
    }
    if (action === 'Add') {
      if (file) throw new Error(`文件已经存在：${path}`);
      const content = [];
      while (i < lines.length - 1 && !lines[i].startsWith('*** ')) {
        if (!lines[i].startsWith('+')) throw new Error('新增文件的每行必须以 + 开始。');
        content.push(lines[i++].slice(1));
      }
      ops.push({ path, content: content.join('\n') + '\n' });
      continue;
    }
    if (!file || file.kind !== 'text') throw new Error(`补丁只能更新已存在的文本文件：${path}`);
    let content = file.content;
    let hunks = 0;
    while (i < lines.length - 1 && !lines[i].startsWith('*** ')) {
      if (!lines[i].startsWith('@@')) throw new Error('更新补丁需要 @@ 上下文分块。');
      i++;
      const old = [],
        next = [];
      while (i < lines.length - 1 && !lines[i].startsWith('@@') && !lines[i].startsWith('*** ')) {
        const line = lines[i++];
        if (line[0] === ' ') {
          old.push(line.slice(1));
          next.push(line.slice(1));
        } else if (line[0] === '-') old.push(line.slice(1));
        else if (line[0] === '+') next.push(line.slice(1));
        else throw new Error('补丁行必须以空格、+ 或 - 开始。');
      }
      const from = old.join('\n'),
        to = next.join('\n');
      if (!from || !content.includes(from) || content.indexOf(from) !== content.lastIndexOf(from))
        throw new Error('补丁上下文不存在或不唯一，未修改任何文件。');
      content = content.replace(from, to);
      hunks++;
    }
    if (!hunks) throw new Error('更新补丁没有内容。');
    ops.push({ path, content });
  }
  if (!ops.length) throw new Error('补丁没有文件操作。');
  return ops;
}
export function applyChanges(files: WorkspaceFile[], changes: FileChange[]): WorkspaceFile[] {
  const next = new Map(files.map((f) => [f.path, f]));
  for (const c of changes) {
    if (c.after) next.set(c.path, c.after);
    else next.delete(c.path);
  }
  if (next.size > 2500) throw new Error('工作区最多保存 2500 个文件。');
  return [...next.values()].sort((a, b) => a.path.localeCompare(b.path));
}
