import { test, expect } from '@playwright/test';

const gateway = 'http://127.0.0.1:4180';
test.skip(!process.env.E2E_GATEWAY_FIXTURE, 'Requires the opt-in Go gateway fixture.');

test('real gateway exchange and CORS work in StrictMode without cookies, replay or paid requests', async ({
  page,
  request,
  context,
}, info) => {
  const setup = await request.post(gateway + '/test/setup', { data: {} });
  expect(setup.status()).toBe(201);
  const launch = await setup.json();
  const code = new URLSearchParams(new URL(launch.launch_url).hash.slice(1)).get('code');
  await context.addCookies([{ name: 'gateway_session', value: 'must-not-be-sent', url: gateway }]);
  await page.goto(launch.launch_url);
  await expect(page.getByRole('status')).toContainText('已连接，可以开始对话');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeFocused();
  expect(new URL(page.url()).hash).toBe('');
  const stats = await (await request.get(gateway + '/test/stats')).json();
  expect(stats.exchanges).toBe(1);
  expect(stats.models).toBe(1);
  expect(stats.responses).toBe(0);
  expect(stats.exchange_cookies).toEqual(['']);
  expect(stats.model_authorizations).toEqual(['Bearer ' + launch.api_key]);
  const replay = await page.evaluate(
    async ({ gateway, code }) => {
      const response = await fetch(gateway + '/browser-handoffs/exchange', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      return response.status;
    },
    { gateway, code },
  );
  expect(replay).toBe(410); // Error response must also pass the browser's CORS checks.
  await page.screenshot({
    path: `artifacts/${info.project.name}-handoff-connected.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByPlaceholder('写下你想做的事，连接模型后就能开始…')).toBeVisible();
});

test('real CORS model error can be retried with the exchanged secret and fallback is visible', async ({
  page,
  request,
}, info) => {
  const setup = await request.post(gateway + '/test/setup', {
    data: {
      model_failures: 1,
      models: ['codex-auto-review', 'gemini-pro-agent'],
      remember_key: true,
    },
  });
  const launch = await setup.json();
  await page.goto(launch.launch_url);
  await expect(page.getByRole('alert')).toContainText('503');
  await page.screenshot({
    path: `artifacts/${info.project.name}-handoff-retry.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: '重试检查' }).click();
  await expect(page.getByRole('status')).toContainText('当前模型：gemini-pro-agent');
  await expect(page.locator('.composer-footnote')).toContainText('Gemini 当前仅支持文本');
  const stats = await (await request.get(gateway + '/test/stats')).json();
  expect(stats.exchanges).toBe(1);
  expect(stats.models).toBe(2);
  expect(stats.responses).toBe(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.reload();
  await expect(page.getByPlaceholder('告诉 AI 你想完成什么，或先添加文件…')).toBeVisible();
});
