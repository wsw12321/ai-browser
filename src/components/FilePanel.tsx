import { useEffect, useState } from 'react';
import {
  FileText,
  FileImage,
  File,
  FolderOpen,
  Upload,
  Plus,
  Download,
  Save,
  Trash2,
  ArrowLeft,
  Code2,
  Eye,
  History,
  RotateCcw,
  X,
} from 'lucide-react';
import type { FileChange, WorkspaceFile } from '../types';
import { downloadFile } from '../lib/files';
export function fileIcon(file: WorkspaceFile, size = 18) {
  return file.kind === 'image' ? (
    <FileImage size={size} />
  ) : file.kind === 'text' ? (
    <FileText size={size} />
  ) : (
    <File size={size} />
  );
}
export default function FilePanel({
  files,
  changes,
  onUpload,
  onFolder,
  onCreate,
  onSave,
  onDelete,
  onUndo,
  onAttach,
  busy,
  selected,
  setSelected,
}: {
  files: WorkspaceFile[];
  changes: FileChange[];
  onUpload: () => void;
  onFolder: () => void;
  onCreate: () => void;
  onSave: (path: string, content: string) => void;
  onDelete: (path: string) => void;
  onUndo: (id: string) => void;
  onAttach: (path: string) => void;
  busy: boolean;
  selected: string | null;
  setSelected: (path: string | null) => void;
}) {
  const [tab, setTab] = useState<'files' | 'changes'>('files');
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState(false);
  const [viewChange, setViewChange] = useState<FileChange | null>(null);
  const file = files.find((f) => f.path === selected);
  useEffect(() => {
    setDraft(file?.content ?? '');
    setPreview(false);
  }, [file?.path, file?.content]);
  const html = !!file && /\.html?$/i.test(file.path);
  const srcdoc = html
    ? `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">` +
      draft
        .replace(/(?:src|href)=["']([^"']+)["']/g, (match, path: string) => {
          const directory = file.path.includes('/')
            ? file.path.slice(0, file.path.lastIndexOf('/') + 1)
            : '';
          const asset = files.find((f) => f.path === directory + path);
          return asset?.dataUrl ? match.replace(path, asset.dataUrl) : match;
        })
        .replace(/<link[^>]*href=["']([^"']+)["'][^>]*>/gi, (match, path: string) => {
          const dir = file.path.includes('/')
            ? file.path.slice(0, file.path.lastIndexOf('/') + 1)
            : '';
          const css = files.find((f) => f.path === dir + path && f.kind === 'text');
          return css ? `<style>${css.content.replace(/<\/style/gi, '<\\/style')}</style>` : match;
        })
    : '';
  return (
    <aside className="file-panel" aria-label="本地文件工作区">
      <div className="panel-heading">
        <div>
          <FolderOpen size={18} />
          <h2>工作区</h2>
          <span className="count">{files.length}</span>
        </div>
        <button
          className="icon-button"
          onClick={onCreate}
          disabled={busy}
          title="新建文件"
          aria-label="新建文件"
        >
          <Plus size={18} />
        </button>
      </div>
      <div className="panel-tabs">
        <button
          className={tab === 'files' ? 'active' : ''}
          onClick={() => {
            setTab('files');
            setViewChange(null);
          }}
        >
          文件
        </button>
        <button
          className={tab === 'changes' ? 'active' : ''}
          onClick={() => {
            setTab('changes');
            setSelected(null);
          }}
        >
          改动记录{changes.length > 0 && <span>{changes.length}</span>}
        </button>
      </div>
      {tab === 'files' && file ? (
        <>
          <div className="file-detail-heading">
            <button
              className="icon-button"
              aria-label="返回文件列表"
              onClick={() => setSelected(null)}
            >
              <ArrowLeft size={17} />
            </button>
            <span title={file.path}>{file.path}</span>
            <button
              className="icon-button"
              onClick={() => downloadFile(file)}
              aria-label="下载文件"
            >
              <Download size={17} />
            </button>
          </div>
          {file.kind === 'text' && (
            <div className="editor-toolbar">
              <div>
                <button className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>
                  <Code2 size={14} />
                  文本
                </button>
                {html && (
                  <button className={preview ? 'active' : ''} onClick={() => setPreview(true)}>
                    <Eye size={14} />
                    预览
                  </button>
                )}
              </div>
              <button
                disabled={busy || draft === file.content}
                onClick={() => onSave(file.path, draft)}
              >
                <Save size={14} />
                保存
              </button>
            </div>
          )}
          <div className="file-view">
            {file.kind === 'image' ? (
              <img className="image-preview" src={file.dataUrl} alt={file.path} />
            ) : preview ? (
              <>
                <p className="preview-note">安全预览 · 脚本与网络已禁用</p>
                <iframe title="安全网页预览" sandbox="" srcDoc={srcdoc} />
              </>
            ) : file.kind === 'text' ? (
              <textarea
                className="code-editor"
                aria-label="文件内容"
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
              />
            ) : (
              <div className="document-preview">
                <p className="preview-note">
                  原始附件保留在本地。
                  {file.content
                    ? '以下为本地提取的文字。'
                    : '该格式暂不支持内容解析，可下载或转为文本、PDF、DOCX。'}
                </p>
                <pre>{file.content}</pre>
              </div>
            )}
          </div>
          <div className="file-footer">
            <button className="text-button" onClick={() => onAttach(file.path)} disabled={busy}>
              附加到消息
            </button>
            <button
              className="icon-button danger"
              onClick={() => onDelete(file.path)}
              disabled={busy}
              aria-label="删除文件"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </>
      ) : tab === 'files' ? (
        <>
          <div className="file-list">
            {!files.length ? (
              <div className="empty-files">
                <div className="empty-icon">
                  <FolderOpen size={26} />
                </div>
                <h3>文件在这里，工作在本机</h3>
                <p>
                  导入文档、数据或图片，
                  <br />让 AI 帮你整理、分析和修改。
                </p>
                <button className="button secondary" onClick={onUpload} disabled={busy}>
                  <Upload size={15} />
                  导入文件
                </button>
              </div>
            ) : (
              files.map((f) => (
                <button key={f.path} className="file-row" onClick={() => setSelected(f.path)}>
                  {fileIcon(f)}
                  <span>
                    <strong>{f.path}</strong>
                    <small>
                      {formatSize(f.size)}
                      {f.kind === 'binary' && f.content ? ' · 已提取正文' : ''}
                    </small>
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="file-import-actions">
            <button onClick={onUpload} disabled={busy}>
              <Upload size={15} />
              导入文件
            </button>
            <button onClick={onFolder} disabled={busy}>
              <FolderOpen size={15} />
              导入文件夹
            </button>
          </div>
        </>
      ) : (
        <div className="changes-list">
          {!changes.length ? (
            <div className="empty-files">
              <History size={28} />
              <h3>每次改动都有记录</h3>
              <p>
                AI 和你修改的文件会出现在这里，
                <br />
                需要时可以撤销最近的改动。
              </p>
            </div>
          ) : viewChange ? (
            <>
              <div className="change-detail-title">
                <strong>{viewChange.path}</strong>
                <button
                  className="icon-button"
                  onClick={() => setViewChange(null)}
                  aria-label="关闭改动详情"
                >
                  <X size={16} />
                </button>
              </div>
              <small>修改前</small>
              <pre className="diff-before">{viewChange.before?.content ?? '（文件不存在）'}</pre>
              <small>修改后</small>
              <pre className="diff-after">{viewChange.after?.content ?? '（删除文件）'}</pre>
            </>
          ) : (
            changes
              .slice()
              .reverse()
              .map((c) => (
                <div key={c.id} className="change-row">
                  <button onClick={() => setViewChange(c)}>
                    <span className={`change-tag ${c.after ? '' : 'deleted'}`}>
                      {!c.after ? '删除' : c.before ? '修改' : '新建'}
                    </span>
                    <strong>{c.path}</strong>
                    <small>
                      {c.source === 'ai' ? 'AI' : '你'} ·{' '}
                      {new Date(c.timestamp).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </small>
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => onUndo(c.id)}
                    disabled={
                      busy || changes.some((x) => x.path === c.path && x.timestamp > c.timestamp)
                    }
                    aria-label={`撤销 ${c.path}`}
                    title="撤销最近一次改动"
                  >
                    <RotateCcw size={15} />
                  </button>
                </div>
              ))
          )}
        </div>
      )}
      <div className="panel-storage">
        <span className="status-dot" />
        本地保存 · 不上传到网站服务器
      </div>
    </aside>
  );
}
export function formatSize(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;
}
