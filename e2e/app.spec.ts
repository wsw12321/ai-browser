import { test, expect, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
const url = 'https://models.example.test/v1';
async function setup(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '发送消息' })).toBeDisabled();
  await page.getByRole('button', { name: 'gpt-5.4', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '连接你的 AI' });
  await dialog.getByLabel('API URL').fill(url);
  await dialog.getByLabel('API Key', { exact: true }).fill('test-private-key');
  await dialog.getByRole('button', { name: '保存设置' }).click();
}
async function filesTab(page: Page) {
  if (await page.getByRole('navigation', { name: '主导航' }).isVisible())
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /文件/ })
      .click();
}
async function chatTab(page: Page) {
  if (await page.getByRole('navigation', { name: '主导航' }).isVisible())
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '对话' })
      .click();
}
const msg = (text: string) => ({
  type: 'message',
  id: 'm1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const tool = (name: string, args: unknown, id: string) => ({
  type: 'function_call',
  id: 'fc_' + id,
  call_id: id,
  name,
  arguments: JSON.stringify(args),
  status: 'completed',
});
function sse(output: unknown[], text = '') {
  return (
    (text
      ? 'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: text }) + '\n\n'
      : '') +
    'data: ' +
    JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp1', status: 'completed', output },
    }) +
    '\n\n'
  );
}
test('local import → model reads → approved write → persistence and export', async ({ page }) => {
  await setup(page);
  let calls = 0;
  const requests: any[] = [];
  await page.route(url + '/responses', async (route) => {
    requests.push(route.request().postDataJSON());
    calls++;
    const output =
      calls === 1
        ? [tool('read_file', { path: 'notes.txt', start_line: null, end_line: null }, 'read1')]
        : calls === 2
          ? [
              tool(
                'write_file',
                { path: '总结.md', content: '# 总结\n这是本地生成的结果。' },
                'write1',
              ),
            ]
          : [msg('已经整理并保存为 **总结.md**。')];
    await route.fulfill({
      contentType: 'text/event-stream',
      body: sse(output, calls === 3 ? '已经整理并保存为 **总结.md**。' : ''),
    });
  });
  await page.locator('input[aria-label="上传附件"]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('会议记录：完成网站'),
  });
  await expect(page.getByRole('button', { name: '移除附件 notes.txt' })).toBeVisible();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('请阅读附件并生成总结');
  await page.getByRole('button', { name: '发送消息' }).click();
  const approval = page.getByRole('dialog', { name: '确认 1 个文件改动' });
  await expect(approval).toBeVisible();
  await expect(approval).toContainText('总结.md');
  await approval.getByRole('button', { name: '允许并保存到本地' }).click();
  await expect(page.getByText('已经整理并保存为', { exact: false })).toBeVisible();
  expect(requests[0].store).toBe(false);
  expect(requests[1].input.at(-1).output).toContain('会议记录');
  expect(requests[2].input.at(-1).output).toContain('files_changed');
  await filesTab(page);
  await page.getByRole('button', { name: /总结.md.*B/ }).click();
  await expect(page.getByRole('textbox', { name: '文件内容' })).toHaveValue(
    '# 总结\n这是本地生成的结果。',
  );
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载文件', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('总结.md');
  await page.reload();
  await filesTab(page);
  await expect(page.getByRole('button', { name: /总结.md.*B/ })).toBeVisible();
  await page.getByRole('button', { name: 'gpt-5.4', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('API Key', { exact: true })).toHaveValue('');
});
test('rejected modifications leave files untouched', async ({ page }) => {
  await setup(page);
  let round = 0;
  await page.route(url + '/responses', async (route) => {
    round++;
    const output =
      round === 1
        ? [tool('write_file', { path: 'unapproved.txt', content: 'must not exist' }, 'w')]
        : [msg('尊重你的决定，未修改文件。')];
    if (round === 2)
      expect(route.request().postDataJSON().input.at(-1).output).toContain('用户拒绝');
    await route.fulfill({
      contentType: 'text/event-stream',
      body: sse(output, round === 2 ? '尊重你的决定，未修改文件。' : ''),
    });
  });
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('创建文件');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.getByRole('button', { name: '拒绝改动' }).click();
  await expect(page.getByText('尊重你的决定，未修改文件。')).toBeVisible();
  await filesTab(page);
  await expect(page.getByRole('button', { name: /unapproved.txt/ })).toHaveCount(0);
});
test('real bundled local sandbox computes, produces a file and blocks host APIs', async ({
  page,
}) => {
  await setup(page);
  let round = 0;
  let result: any;
  await page.route(url + '/responses', async (route) => {
    round++;
    if (round === 2) result = JSON.parse(route.request().postDataJSON().input.at(-1).output);
    const output =
      round === 1
        ? [
            tool(
              'run_javascript',
              {
                code: 'console.log(typeof fetch, typeof process, typeof localStorage); const sum=[2,3,5].reduce((a,b)=>a+b,0); writeFile("result.txt",String(sum)); sum;',
              },
              'js',
            ),
          ]
        : [msg('本地计算已完成。')];
    await route.fulfill({
      contentType: 'text/event-stream',
      body: sse(output, round === 2 ? '本地计算已完成。' : ''),
    });
  });
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('在本地计算并生成文件');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.getByRole('button', { name: '允许并保存到本地' }).click();
  await expect(page.getByText('本地计算已完成。')).toBeVisible();
  expect(result.result).toBe(10);
  expect(result.logs).toEqual(['undefined undefined undefined']);
  await filesTab(page);
  await page.getByRole('button', { name: /result.txt.*B/ }).click();
  await expect(page.getByRole('textbox', { name: '文件内容' })).toHaveValue('10');
});
test('supports image attachments inline and local DOCX extraction', async ({ page }) => {
  await setup(page);
  let request: any;
  await page.route(url + '/responses', async (route) => {
    request = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'text/event-stream',
      body: sse([msg('附件已收到。')], '附件已收到。'),
    });
  });
  const docx = zipSync({
    'word/document.xml': strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>这是 DOCX 正文</w:t></w:r></w:p></w:body></w:document>',
    ),
  });
  await page.locator('input[aria-label="上传附件"]').setInputFiles([
    {
      name: 'test.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from(docx),
    },
    {
      name: 'image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cD1sAAAAASUVORK5CYII=',
        'base64',
      ),
    },
  ]);
  await expect(page.getByRole('button', { name: '移除附件 image.png' })).toBeVisible();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('分析附件');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText('附件已收到。')).toBeVisible();
  expect(request.input[0].content.find((c: any) => c.type === 'input_image').image_url).toMatch(
    /^data:image\/png;base64,/,
  );
  await filesTab(page);
  await page.getByRole('button', { name: /test.docx.*正文/ }).click();
  await expect(page.locator('.document-preview')).toContainText('这是 DOCX 正文');
});
test('edits, undo, ZIP export and backup exclude credentials', async ({ page }) => {
  await setup(page);
  await filesTab(page);
  await page.getByRole('button', { name: '新建文件', exact: true }).click();
  await page.getByPlaceholder('例如：笔记.md 或 项目/index.html').fill('note.md');
  await page.getByRole('button', { name: '创建文件', exact: true }).click();
  await page.getByRole('textbox', { name: '文件内容' }).fill('local draft');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: /改动记录/ }).click();
  await page.getByRole('button', { name: '撤销 note.md', exact: true }).first().click();
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('button', { name: /note.md.*B/ }).click();
  await expect(page.getByRole('textbox', { name: '文件内容' })).toHaveValue('');
  await page.getByRole('button', { name: '工作区菜单' }).click();
  const promise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出工作区备份' }).click();
  const download = await promise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const c of stream!) chunks.push(c);
  const backup = JSON.parse(Buffer.concat(chunks).toString());
  expect(backup.settings.apiKey).toBe('');
  expect(backup.files[0].path).toBe('note.md');
  await page.getByRole('button', { name: '工作区菜单' }).click();
  const zip = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载全部文件 ZIP' }).click();
  expect((await zip).suggestedFilename()).toBe('localdesk-files.zip');
});
test('can stop an approval and rejects system execution tools', async ({ page }) => {
  await setup(page);
  let round = 0;
  await page.route(url + '/responses', async (route) => {
    round++;
    const output =
      round === 1
        ? [tool('exec_command', { cmd: 'npm install' }, 'shell')]
        : round === 2
          ? [tool('write_file', { path: 'pending.txt', content: 'unapproved' }, 'write')]
          : [msg('完成')];
    if (round === 2)
      expect(route.request().postDataJSON().input.at(-1).output).toContain('浏览器不支持');
    await route.fulfill({ contentType: 'text/event-stream', body: sse(output) });
  });
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('执行命令');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByRole('dialog', { name: '确认 1 个文件改动' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '停止任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
  await filesTab(page);
  await expect(page.getByRole('button', { name: /pending.txt/ })).toHaveCount(0);
});
test('responsive layout has no horizontal overflow and static preview cannot run scripts', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.locator('.new-chat')).toBeEnabled();
  await expect(page.getByText('把想法，')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({ path: `artifacts/${info.project.name}-welcome.png`, fullPage: true });
  await page.locator('input[aria-label="上传附件"]').setInputFiles({
    name: 'index.html',
    mimeType: 'text/html',
    buffer: Buffer.from(
      '<h1>安全本地预览</h1><script>parent.document.body.dataset.compromised="yes";fetch("https://bad.example/")</script>',
    ),
  });
  await filesTab(page);
  await page.getByRole('button', { name: /index.html.*B/ }).click();
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(
    page
      .frameLocator('iframe[title="安全网页预览"]')
      .getByRole('heading', { name: '安全本地预览' }),
  ).toBeVisible();
  expect(await page.locator('body').getAttribute('data-compromised')).toBeNull();
  if (info.project.name === 'mobile') {
    for (const width of [320, 375, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    }
  }
});

test('extracts a PDF and imports a ZIP completely in the browser', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.new-chat')).toBeEnabled();
  const stream = 'BT /F1 12 Tf 50 700 Td (Local PDF text) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf +=
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const zip = zipSync({
    'folder/data.csv': strToU8('name,value\nA,2\nB,3'),
    'folder/readme.md': strToU8('# Local ZIP'),
  });
  await page.locator('input[aria-label="上传附件"]').setInputFiles([
    { name: 'local.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) },
    { name: 'files.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) },
  ]);
  await expect(page.getByRole('button', { name: '移除附件 local.pdf' })).toBeVisible();
  await filesTab(page);
  await page.getByRole('button', { name: /local.pdf.*正文/ }).click();
  await expect(page.locator('.document-preview')).toContainText('Local PDF text');
  await page.getByRole('button', { name: '返回文件列表' }).click();
  await page.getByRole('button', { name: /folder\/data.csv.*B/ }).click();
  await expect(page.getByRole('textbox', { name: '文件内容' })).toHaveValue('name,value\nA,2\nB,3');
});

test('fetches provider models and restores a key-free workspace backup', async ({ page }) => {
  await setup(page);
  await page.route(url + '/models', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'my-top-model' }, { id: 'my-fast-model' }] }),
    }),
  );
  await page.getByRole('button', { name: 'gpt-5.4', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '连接你的 AI' });
  await dialog.getByRole('button', { name: '获取模型列表' }).click();
  await expect(dialog.getByText('已获取 2 个模型。')).toBeVisible();
  await dialog.getByPlaceholder('输入服务提供的模型 ID').fill('my-top-model');
  await dialog.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('button', { name: 'my-top-model', exact: true })).toBeVisible();
  const backup = {
    version: 1,
    files: [
      {
        path: 'restored.md',
        kind: 'text',
        mime: 'text/plain',
        content: '# restored workspace',
        size: 20,
        updatedAt: 1,
      },
    ],
    changes: [],
    conversations: [
      {
        id: 'restored',
        title: '恢复的对话',
        messages: [],
        apiHistory: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    activeConversationId: 'restored',
    settings: {
      baseUrl: url,
      apiKey: '',
      model: 'my-top-model',
      protocol: 'responses',
      reasoning: '',
      rememberKey: false,
      autoApprove: false,
      systemPrompt: '',
      maxRounds: 20,
    },
  };
  page.once('dialog', (d) => d.accept());
  await page.locator('input[accept=".json"]').setInputFiles({
    name: 'workspace.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.getByRole('status')).toContainText('工作区已从备份恢复');
  await filesTab(page);
  await page.getByRole('button', { name: /restored.md.*B/ }).click();
  await expect(page.getByRole('textbox', { name: '文件内容' })).toHaveValue('# restored workspace');
  await page.reload();
  await filesTab(page);
  await expect(page.getByRole('button', { name: /restored.md.*B/ })).toBeVisible();
});
