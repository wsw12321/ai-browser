import { useEffect, useRef } from 'react';
import {
  Check,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Terminal,
  UserRound,
  Copy,
  CheckCheck,
} from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '../types';
const labels: Record<string, string> = {
  list_files: '查看工作区',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '修改文件',
  delete_file: '删除文件',
  search_files: '搜索文件',
  apply_patch: '应用补丁',
  run_javascript: '本地沙盒计算',
};
function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-button copy-button"
      aria-label="复制回复"
      onClick={() => {
        navigator.clipboard
          .writeText(content)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => {});
      }}
    >
      {copied ? <CheckCheck size={15} /> : <Copy size={15} />}
    </button>
  );
}
export default function ChatMessages({ messages, busy }: { messages: Message[]; busy: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [messages]);
  return (
    <div
      className="messages-scroll"
      ref={scroll}
      onScroll={() => {
        const el = scroll.current;
        if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
    >
      <div className="messages-inner">
        {messages.map((m) =>
          m.role === 'tool' ? (
            <details key={m.id} className={`tool-card ${m.status ?? ''}`}>
              <summary>
                {m.status === 'running' ? (
                  <LoaderCircle size={15} className="spin" />
                ) : m.status === 'error' ? (
                  <CircleAlert size={15} />
                ) : (
                  <Check size={15} />
                )}
                <span>{labels[m.toolName ?? ''] ?? m.toolName}</span>
                <small>
                  {m.status === 'running'
                    ? '进行中'
                    : m.status === 'error'
                      ? '未执行 / 失败'
                      : '已完成'}
                </small>
                <ChevronRight size={14} className="tool-arrow" />
              </summary>
              <div className="tool-body">
                <small>工具参数</small>
                <pre>{m.toolArgs}</pre>
                <small>执行结果</small>
                <pre>{m.content}</pre>
              </div>
            </details>
          ) : (
            <article key={m.id} className={`message ${m.role}`}>
              <div className={`message-avatar ${m.role === 'assistant' ? 'brand-avatar' : ''}`}>
                {m.role === 'user' ? <UserRound size={17} /> : <Terminal size={17} />}
              </div>
              <div className="message-main">
                <div className="message-meta">
                  <strong>{m.role === 'user' ? '你' : 'Localdesk'}</strong>
                  {m.role === 'assistant' && <small>AI 助手</small>}
                </div>
                {m.attachments?.length ? (
                  <div className="message-attachments">
                    {m.attachments.map((a) => (
                      <span key={a.path}>
                        {a.kind === 'image' ? '▧' : '▤'} {a.name}
                      </span>
                    ))}
                  </div>
                ) : null}
                {m.content ? (
                  <div className="markdown">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ children, href }) => (
                          <a href={href} target="_blank" rel="noreferrer">
                            {children}
                          </a>
                        ),
                        img: ({ alt }) => (
                          <span className="blocked-image">
                            [图片：{alt ?? '外部图片'} · 外部图片不会自动加载]
                          </span>
                        ),
                      }}
                    >
                      {m.content}
                    </ReactMarkdown>
                  </div>
                ) : m.status === 'running' ? (
                  <div className="thinking">
                    <span />
                    <span />
                    <span />
                    正在思考与处理…
                  </div>
                ) : (
                  <p className="muted">
                    {m.status === 'stopped' ? '已停止。' : '未返回文字内容。'}
                  </p>
                )}
                {m.role === 'assistant' && m.status !== 'running' && m.content && (
                  <div className="message-actions">
                    <CopyButton content={m.content} />
                    {m.status === 'error' && <span className="danger">任务未完成</span>}
                    {m.status === 'stopped' && <span>已停止</span>}
                  </div>
                )}
              </div>
            </article>
          ),
        )}
        {busy && messages.at(-1)?.role === 'tool' && (
          <p className="continuing">
            <LoaderCircle size={14} className="spin" />
            AI 正在继续处理…
          </p>
        )}
        <div ref={end} />
      </div>
    </div>
  );
}
