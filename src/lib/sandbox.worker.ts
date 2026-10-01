import { evaluateSandbox, type SandboxInput } from './sandbox-engine';
self.onmessage = async (e: MessageEvent<SandboxInput>) => {
  try {
    self.postMessage({ ok: true, value: await evaluateSandbox(e.data) });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
