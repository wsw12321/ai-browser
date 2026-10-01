import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import { normalizePath, MAX_TEXT_SIZE } from './files';
export interface SandboxInput {
  code: string;
  files: { path: string; content: string }[];
  timeoutMs?: number;
}
export interface SandboxResult {
  result: unknown;
  logs: string[];
  writes: { path: string; content: string }[];
}
export async function evaluateSandbox({
  code,
  files,
  timeoutMs = 5000,
}: SandboxInput): Promise<SandboxResult> {
  if (code.length > 100000) throw new Error('沙盒代码过长。');
  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  const deadline = Date.now() + Math.min(timeoutMs, 5000);
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  const logs: string[] = [];
  const writes = new Map<string, string>();
  const snapshot = new Map(files.map((f) => [f.path, f.content]));
  try {
    const read = context.newFunction('readFile', (arg) => {
      const path = normalizePath(context.getString(arg));
      const content = writes.get(path) ?? snapshot.get(path);
      if (content === undefined) throw new Error('文件不存在：' + path);
      return context.newString(content);
    });
    context.setProp(context.global, 'readFile', read);
    read.dispose();
    let writeBytes = 0;
    const write = context.newFunction('writeFile', (arg, value) => {
      const path = normalizePath(context.getString(arg));
      if (context.typeof(value) !== 'string') throw new Error('文件内容必须为文字。');
      const content = context.getString(value);
      const bytes = new TextEncoder().encode(content).length;
      if (bytes > MAX_TEXT_SIZE) throw new Error('生成文件超过 5 MB。');
      if (writes.size >= 100 && !writes.has(path)) throw new Error('单次计算最多创建 100 个文件。');
      const nextSize = writeBytes - new TextEncoder().encode(writes.get(path) ?? '').length + bytes;
      if (nextSize > 20 * 1024 * 1024) throw new Error('单次计算生成的文件总计不能超过 20 MB。');
      writes.set(path, content);
      writeBytes = nextSize;
      return context.undefined;
    });
    context.setProp(context.global, 'writeFile', write);
    write.dispose();
    const list = context.newFunction('listFiles', () =>
      context.newString(JSON.stringify([...new Set([...snapshot.keys(), ...writes.keys()])])),
    );
    context.setProp(context.global, '__listFiles', list);
    list.dispose();
    const log = context.newFunction('log', (...args) => {
      if (logs.length < 200)
        logs.push(
          args
            .map((a) => {
              try {
                return typeof context.dump(a) === 'string'
                  ? context.dump(a)
                  : JSON.stringify(context.dump(a));
              } catch {
                return '[无法显示]';
              }
            })
            .join(' ')
            .slice(0, 2000),
        );
      return context.undefined;
    });
    const console = context.newObject();
    context.setProp(console, 'log', log);
    context.setProp(context.global, 'console', console);
    console.dispose();
    log.dispose();
    const bootstrap = context.evalCode(
      'globalThis.listFiles = (() => { const list = __listFiles; return () => JSON.parse(list()); })(); delete globalThis.__listFiles;',
    );
    bootstrap.dispose();
    const evaluated = context.evalCode(code, 'local-computation.js');
    if (evaluated.error) {
      const error = context.dump(evaluated.error);
      evaluated.error.dispose();
      throw new Error(
        error.message === 'interrupted'
          ? '计算超过 5 秒，已终止。'
          : `沙盒执行失败：${error.message ?? JSON.stringify(error)}`,
      );
    }
    let result;
    try {
      result = context.dump(evaluated.value);
    } finally {
      evaluated.value.dispose();
    }
    const encoded = JSON.stringify(result);
    if (encoded && encoded.length > 100000) result = encoded.slice(0, 100000) + '（结果已截断）';
    return {
      result: result ?? null,
      logs,
      writes: [...writes].map(([path, content]) => ({ path, content })),
    };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
