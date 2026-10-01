# Localdesk · 本地 AI 工作台

一个可以部署到 Cloudflare 的纯静态「网页版 Codex」。用户使用自己的 API URL 和 API Key，在浏览器里让模型读取、修改文件、分析数据和生成结果。手机、平板、桌面都可使用，无需自建服务器。

## 开始使用

需要 Node.js 22.12+（建议 Node.js 24）。

```bash
npm ci
npm run dev
```

打开终端显示的网址，点击顶部模型名称，填写 API URL、API Key 和你的服务提供的模型 ID。可点击刷新按钮获取 `/models` 列表，也可自由输入模型名称。模型默认值只是可编辑的示例，不保证你的服务或账户支持该模型。

1. 导入附件、图片、文件夹或 ZIP。导入后的文件自动附加到下一条消息。
2. 用自然语言说明任务。模型可以列出、读取、搜索、创建、替换、删除文件，以及应用 Codex 风格的补丁。
3. 默认在改动预览中确认后才会应用。可在改动记录中撤销最近的文件操作。
4. 点击文件查看内容、手动编辑文本或预览 HTML，下载单个文件或全部文件 ZIP。
5. 从顶部菜单导出工作区备份，包含文件、对话、工具历史和设置，始终排除 API Key。

## 部署到 Cloudflare

### Pages：不用命令行的方式

在本机运行 `npm ci` 和 `npm run build`，在 Cloudflare 控制台创建 Pages 项目，选择直接上传，上传整个 `dist` 文件夹即可。也可以把项目放进 Git 仓库，在 Pages 中连接仓库，设置：

- 构建命令：`npm run build`
- 输出目录：`dist`
- Node.js：24

`dist` 含有安全响应头 `_headers`。Pages 的默认单页应用回退与 Workers 的 `single-page-application` 处理提供入口页面，无需额外重写规则、Functions、数据库、R2、KV 或 API Key 环境变量。不要把用户的密钥配置在 Cloudflare。

使用 CLI 部署 Pages：

```bash
npx wrangler login
npm run deploy:pages
```

首次部署可在提示中创建 Pages 项目。单独的 Pages 配置是 `wrangler.pages.jsonc`。

### Workers Static Assets

```bash
npx wrangler login
npm run deploy
```

`wrangler.jsonc` 只托管 `dist`，没有 Worker 业务代码。可以修改 `name` 为自己的项目名。Cloudflare 提供网页资源，模型调用由用户浏览器直接发出。

### 连接模型服务

默认使用与 Codex 相同的 **Responses API**，发送 `stream: true`、`store: false`，本地保存完整请求历史（包含工具调用结果与加密的 reasoning 内容），不使用 `previous_response_id` 或服务端文件上传。图片作为 `input_image` data URL 传入。支持 OpenAI 或实现相同协议的网关；另提供 Chat Completions 兼容模式。Chat Completions 的工具支持取决于所选模型和服务。思考力度默认不发送；仅在服务支持时选择。

API URL 可以是基础地址（如 `https://api.openai.com/v1`）或完整 `/responses`、`/chat/completions` 地址。模型由服务实际支持的 ID 决定；不内置账户认证或 ChatGPT 订阅登录。

服务必须允许来自网页域名的 **CORS** 请求：允许 `POST`、`GET`、`OPTIONS`，允许 `Authorization`、`Content-Type` 请求头，并返回匹配网页 Origin 的 `Access-Control-Allow-Origin`。网站无法绕过浏览器 CORS，也不会借 Cloudflare 转发用户文件或密钥。如果服务不允许跨域，需要服务提供商修改 CORS，或改用允许浏览器访问的 API 服务。HTTPS 网站连接普通 HTTP 远程地址会被浏览器拦截。

## 本地能力与边界

文件读取、修改、解压、文档解析、压缩、计算和持久化都发生在用户设备上。文件只存在浏览器工作区里，**不会自动修改用户磁盘上的原始文件**；用户需要下载结果。所有对话共用同一个本地工作区。

- UTF-8 文本、代码、Markdown、JSON、CSV 等可读取和编辑。
- PNG、JPEG、WebP、GIF 可附加到模型消息。图片理解需要模型支持视觉输入。
- PDF 和 DOCX 正文在本地提取，原始文档保留，可生成新的文本结果。没有 OCR，扫描版 PDF 可把页面转为图片后附加；无法直接写回 PDF/DOCX 二进制格式。
- 其他二进制附件可以存储、下载；不伪装成可读取文件。旧版 Office、XLSX 可先导出 CSV、PDF 或 DOCX。
- ZIP 在本地解压和导出。单附件 50 MB，文本文件 5 MB，ZIP 解压总计 100 MB，最多 2500 文件；浏览器可用存储空间另有上限。
- HTML 在无脚本、无网络、无宿主权限的 iframe 中安全静态预览。支持工作区相对路径的图片和 CSS；复杂动态网站请下载后在适合的环境中运行。
- `run_javascript` 使用独立 Worker 内的 **QuickJS WebAssembly** 解释器运行同步 JavaScript。只暴露 `readFile(path)`、`writeFile(path, text)`、`listFiles()`、`console.log(...)`。`writeFile` 结果先回到主线程等待审批，计算不能绕过文件审批。
- 沙盒不暴露 `window`、DOM、`fetch`、浏览器存储、API Key、Node.js、操作系统和宿主 Worker。CPU 时间 5 秒、内存 32 MB；输入文本总计最多 50 MB，输出文件总计最多 20 MB。外层 Worker 最长运行 10 秒，可随时停止。模型发来的代码不会用宿主 `eval` 或 `Function` 执行。
- 不执行 bash、npm、pip、git、Python、软件安装、系统文件操作、后台服务或终端命令。工具层会明确拒绝未知执行工具，助手指令要求说明限制并使用本地沙盒或生成文件方案。

## 数据与密钥

文件、最近 100 次改动和对话存在当前网页来源下的 IndexedDB 中。不同域名、浏览器、设备互不共享。删除浏览器数据或使用隐私模式可能使工作区丢失，建议定期导出备份。

API Key 默认仅在当前页面的内存中使用，刷新后需要重新填写。用户明确勾选「在这台设备记住密钥」后才明文保存到此浏览器。备份始终剔除密钥。没有内置 API Key，也不记录到 Cloudflare。

**本地存储不表示模型推理离线。** 对话、附加的图片、模型通过工具读取的文件片段和计算结果会发送给你配置的 API 服务，由该服务的规则决定处理方式。`store:false` 禁止 Responses 的应用状态存储，不等同于服务商承诺零日志。API 费用由你的账户或服务商收取。网页没有遥测、外部字体或第三方图片自动加载。

## 验证

```bash
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npx wrangler deploy --dry-run --outdir /tmp/localdesk-worker-check
```

单元测试验证无服务端状态的 Responses 工具续传、流式 UTF-8 边界、图片输入、Chat Completions 兼容、路径限制、补丁原子性、密钥持久化和 QuickJS 隔离/超时。浏览器测试在桌面和手机尺寸中实际运行构建产物，使用受控 API 响应验证本地导入→读取→审批→修改→下载→刷新恢复、图片、DOCX、沙盒、拒绝命令、撤销与安全预览。

浏览器测试不使用真实付费密钥。实际模型可用性、CORS、费用、工具调用能力由用户选择的服务决定。验收时填入自己的连接并发起任务即可验证真实服务。

实现遵循 [OpenAI 官方工具调用文档](https://developers.openai.com/api/docs/guides/function-calling) 和 [流式 Responses 文档](https://developers.openai.com/api/docs/guides/streaming-responses)。静态托管遵循 [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)。本项目为独立实现，未复制 Codex 源码或冒充 OpenAI 官方产品。

## 代码结构

`src/lib/api.ts` 实现浏览器直连与工具调用循环；`tools.ts` 实现本地文件操作；`sandbox-engine.ts` / `sandbox.worker.ts` 实现 WebAssembly 计算；`files.ts` 处理附件、解压与下载；`state.ts` 管理 IndexedDB 与备份。React 界面位于 `src/App.tsx` 和 `src/components/`。所有运行依赖随静态资源部署，无需 CDN。
