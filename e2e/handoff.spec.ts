import { test, expect, type Page } from '@playwright/test';

const gateway = 'https://codex.water555.com';
const key = 'sk-browser-handoff-test-secret';
const code = 'cgb_v1_' + 'a'.repeat(43);
const launch = '/?launch=1#handoff_version=1&code=' + code;
const connection = {
  base_url: gateway + '/v1',
  api_key: key,
  api_key_id: 'key-web',
  remember_key: false,
  protocol: 'responses',
};
async function mockGateway(
  page: Page,
  options: {
    remember?: boolean;
    models?: string[];
    failModels?: number;
    failExchange?: boolean;
  } = {},
) {
  const calls = { exchange: 0, models: 0, responses: 0 };
  await page.route(gateway + '/**', async (route) => {
    const request = route.request();
    expect(request.headers().cookie).toBeUndefined();
    if (request.url().endsWith('/browser-handoffs/exchange')) {
      calls.exchange++;
      expect(request.postDataJSON()).toEqual({ code });
      expect(new URL(page.url()).hash).toBe('');
      await route.fulfill({
        status: options.failExchange ? 410 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          options.failExchange
            ? { error: { message: key } }
            : {
                ...connection,
                remember_key: options.remember ?? false,
              },
        ),
      });
    } else if (request.url().endsWith('/models')) {
      calls.models++;
      expect(request.headers().authorization).toBe('Bearer ' + key);
      await route.fulfill({
        status: calls.models <= (options.failModels ?? 0) ? 503 : 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: (options.models ?? ['gpt-6.1-sol']).map((id) => ({ id })) }),
      });
    } else {
      calls.responses++;
      await route.abort();
    }
  });
  return calls;
}
async function stored(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('localdesk', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<any>((resolve) => {
      const request = db.transaction('state').objectStore('state').get('workspace');
      request.onsuccess = () => {
        resolve(request.result);
        db.close();
      };
    });
  });
}
async function seedExisting(page: Page) {
  await page.goto('/');
  await expect(page.locator('.new-chat')).toBeEnabled();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('localdesk', 1);
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('state', 'readwrite');
      const store = tx.objectStore('state');
      const r = store.get('workspace');
      r.onsuccess = () => {
        const s = r.result;
        s.settings = {
          ...s.settings,
          baseUrl: 'https://old.example/v1',
          apiKey: 'old-key',
          rememberKey: true,
          model: 'old-model',
        };
        s.files = [
          {
            path: 'kept.md',
            kind: 'text',
            content: 'keep my work',
            mime: 'text/plain',
            size: 12,
            updatedAt: 1,
          },
        ];
        s.conversations[0].title = '历史对话';
        s.conversations[0].messages = [
          { id: 'old-msg', role: 'user', content: '历史内容', createdAt: 1 },
        ];
        store.put(s, 'workspace');
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
    });
  });
}

test('first handoff scrubs code, exchanges once, checks model and keeps key only in memory', async ({
  page,
}) => {
  const calls = await mockGateway(page);
  await page.goto(launch);
  await expect(page.getByRole('status')).toContainText('已连接，可以开始对话');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeFocused();
  expect(calls).toEqual({ exchange: 1, models: 1, responses: 0 });
  expect(new URL(page.url()).hash).toBe('');
  await expect.poll(async () => (await stored(page))?.settings.apiKey).toBe('');
  expect((await stored(page)).settings.connectionSource.apiKeyId).toBe('key-web');
  await page.reload();
  await expect(page.getByPlaceholder('写下你想做的事，连接模型后就能开始…')).toBeVisible();
  expect(calls.exchange).toBe(1);
});

test('remembered key survives reload and backup still excludes it', async ({ page }) => {
  await mockGateway(page, { remember: true });
  await page.goto(launch);
  await expect(page.getByRole('status')).toContainText('已连接');
  await expect.poll(async () => (await stored(page))?.settings.apiKey).toBe(key);
  await page.reload();
  await expect(page.getByPlaceholder('告诉 AI 你想完成什么，或先添加文件…')).toBeVisible();
  await page.getByRole('button', { name: '工作区菜单' }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出工作区备份' }).click();
  const stream = await (await downloaded).createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const backup = Buffer.concat(chunks).toString();
  expect(backup).not.toContain(key);
  expect(JSON.parse(backup).settings.rememberKey).toBe(false);
});

test('cancel switching preserves connection, files and history', async ({ page }) => {
  await seedExisting(page);
  const before = await stored(page);
  const calls = await mockGateway(page);
  await page.goto(launch);
  const dialog = page.getByRole('dialog', { name: '切换工作台连接' });
  await expect(dialog).toContainText('现有文件和历史对话都会保留');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: 'old-model', exact: true })).toBeEnabled();
  expect(await stored(page)).toEqual(before);
  expect(calls).toEqual({ exchange: 1, models: 0, responses: 0 });
});

test('switch confirmation keeps workspace and starts a new conversation', async ({ page }) => {
  await seedExisting(page);
  await mockGateway(page);
  await page.goto(launch);
  await page.getByRole('button', { name: '确认切换' }).click();
  await expect(page.getByRole('status')).toContainText('已连接');
  await expect.poll(async () => (await stored(page)).settings.model).toBe('gpt-6.1-sol');
  const s = await stored(page);
  expect(s.files[0].content).toBe('keep my work');
  expect(s.conversations).toHaveLength(2);
  expect(s.conversations.find((c: any) => c.title === '历史对话').messages[0].content).toBe(
    '历史内容',
  );
  expect(s.conversations.find((c: any) => c.id === s.activeConversationId).messages).toEqual([]);
});

test('model failure is retryable without exchanging again or altering previous settings', async ({
  page,
}) => {
  await seedExisting(page);
  const before = await stored(page);
  const calls = await mockGateway(page, {
    failModels: 1,
    models: ['codex-auto-review', 'gpt-z', 'gpt-a'],
  });
  await page.goto(launch);
  await page.getByRole('button', { name: '确认切换' }).click();
  await expect(page.getByRole('button', { name: '重试检查' })).toBeVisible();
  expect(await stored(page)).toEqual(before);
  await page.getByRole('button', { name: '重试检查' }).click();
  await expect(page.getByRole('status')).toContainText('当前模型：gpt-a');
  expect(calls).toEqual({ exchange: 1, models: 2, responses: 0 });
});

test('Gemini fallback states text-only capability and does not send paid requests', async ({
  page,
}) => {
  const calls = await mockGateway(page, { models: ['codex-auto-review', 'gemini-pro-agent'] });
  await page.goto(launch);
  await expect(page.getByRole('status')).toContainText('Gemini 当前仅支持文本');
  await expect(page.locator('.composer-footnote')).toContainText('Gemini 当前仅支持文本');
  expect(calls.responses).toBe(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
});

test('expired exchange offers gateway return without exposing secret response', async ({
  page,
}) => {
  const calls = await mockGateway(page, { failExchange: true });
  await page.goto(launch);
  await expect(page.getByRole('alert')).toContainText('连接码已失效');
  await expect(page.getByRole('link', { name: '返回网关重新接入' })).toHaveAttribute(
    'href',
    gateway,
  );
  await expect(page.locator('body')).not.toContainText(key);
  expect(calls).toEqual({ exchange: 1, models: 0, responses: 0 });
});
