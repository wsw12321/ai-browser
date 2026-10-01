import type { SandboxInput, SandboxResult } from './sandbox-engine';
export function runSandbox(input: SandboxInput, signal: AbortSignal): Promise<SandboxResult> {
  if (
    input.files.reduce((bytes, f) => bytes + new TextEncoder().encode(f.content).length, 0) >
    50 * 1024 * 1024
  )
    return Promise.reject(new Error('沙盒输入文本总计不能超过 50 MB，请精简工作区或拆分任务。'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sandbox.worker.ts', import.meta.url), { type: 'module' });
    const close = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      close();
      reject(new DOMException('已停止', 'AbortError'));
    };
    const timer = setTimeout(() => {
      close();
      reject(new Error('计算沙盒已达到运行时间上限，已终止。'));
    }, 10000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    worker.onmessage = (e) => {
      close();
      if (e.data.ok) resolve(e.data.value);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      close();
      reject(new Error('沙盒加载或运行失败：' + e.message));
    };
    worker.postMessage(input);
  });
}
