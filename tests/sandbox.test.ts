import { describe, it, expect } from 'vitest';
import { evaluateSandbox } from '../src/lib/sandbox-engine';
describe('QuickJS computation isolation', () => {
  it('calculates and generates files without modifying source data', async () => {
    const files = [{ path: 'data.csv', content: '2,3,5' }];
    const r = await evaluateSandbox({
      files,
      code: 'const sum = readFile("data.csv").split(",").map(Number).reduce((a,b)=>a+b,0); console.log(sum); writeFile("result.txt", String(sum)); listFiles();',
    });
    expect(r.logs).toEqual(['10']);
    expect(r.writes).toEqual([{ path: 'result.txt', content: '10' }]);
    expect(r.result).toEqual(['data.csv', 'result.txt']);
    expect(files[0].content).toBe('2,3,5');
  });
  it('exposes no host, network, browser storage or OS interfaces', async () => {
    const r = await evaluateSandbox({
      files: [],
      code: '[typeof fetch,typeof XMLHttpRequest,typeof window,typeof document,typeof localStorage,typeof indexedDB,typeof process,typeof require,typeof Worker,typeof WebAssembly]',
    });
    expect(r.result).toEqual(Array(10).fill('undefined'));
  });
  it('cannot access host globals through Function constructors', async () => {
    const r = await evaluateSandbox({
      files: [],
      code: `Function('return typeof process + ":" + typeof fetch')()`,
    });
    expect(r.result).toBe('undefined:undefined');
  });
  it('rejects paths outside the local workspace', async () => {
    await expect(
      evaluateSandbox({ files: [], code: 'writeFile("../outside", "x")' }),
    ).rejects.toThrow();
  });
  it('interrupts an infinite loop', async () => {
    await expect(
      evaluateSandbox({ files: [], code: 'while(true) {}', timeoutMs: 30 }),
    ).rejects.toThrow(/终止/);
  });
});
