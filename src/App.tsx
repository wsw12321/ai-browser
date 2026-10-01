import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  Download,
  FileText,
  FolderOpen,
  HardDrive,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import type {
  AppState,
  Conversation,
  FileChange,
  Message,
  Settings,
  ToolCall,
  WorkspaceFile,
} from './types';
import {
  backupState,
  applyHandoff,
  DEFAULT_SETTINGS,
  initialState,
  loadState,
  newConversation,
  parseBackup,
  saveState,
} from './lib/state';
import { downloadBlob, exportFiles, importFile, importZip, textFile } from './lib/files';
import { readableError, runAgent } from './lib/api';
import { applyChanges, parseArgs, planChanges, readTool, toolDefinitions } from './lib/tools';
import { runSandbox } from './lib/sandbox';
import SettingsDialog from './components/SettingsDialog';
import FilePanel, { fileIcon } from './components/FilePanel';
import ChatMessages from './components/ChatMessages';
import Modal from './components/Modal';
import HandoffDialog from './components/HandoffDialog';
import type { BrowserHandoff, HandoffConnection, HandoffModel } from './lib/handoff';
interface PendingApproval {
  call: ToolCall;
  changes: FileChange[];
  resolve: (approved: boolean) => void;
}
const suggestions = [
  {
    icon: FileText,
    title: '整理一份文档',
    description: '提炼重点，写成清楚的总结',
    prompt: '请阅读我上传的文档，提取重要信息，整理成结构清晰的总结，并保存为 总结.md。',
  },
  {
    icon: HardDrive,
    title: '分析表格数据',
    description: '在本地计算，找到有用的结论',
    prompt:
      '请分析我上传的 CSV 数据，使用本地 JavaScript 沙盒进行计算，说明关键结论，并将分析报告保存为 分析报告.md。',
  },
  {
    icon: Sparkles,
    title: '把想法做成网页',
    description: '生成可下载、可预览的文件',
    prompt:
      '帮我做一个漂亮且适配手机的单页网站，主题是个人作品集。请生成 index.html 文件，使用内嵌 CSS，不依赖外部资源。',
  },
  {
    icon: FolderOpen,
    title: '一起修改文件',
    description: '先看改动，再决定是否保存',
    prompt: '请先列出工作区文件，阅读相关内容，再帮助我修改。修改前简洁说明你的建议。',
  },
];
export default function App({ startupHandoff = null }: { startupHandoff?: BrowserHandoff | null }) {
  const [state, setState] = useState<AppState>(initialState);
  const stateRef = useRef(state);
  const [ready, setReady] = useState(false);
  const [handoffActive, setHandoffActive] = useState(Boolean(startupHandoff));
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<'chat' | 'files'>('chat');
  const [selected, setSelected] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [attached, setAttached] = useState<string[]>([]);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const approvalRef = useRef<PendingApproval | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [toast, setToast] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [round, setRound] = useState(0);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const backupRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const persistenceError = useRef(false);
  const focusAfterHandoff = useRef(false);
  const update = useCallback((fn: (s: AppState) => AppState) => {
    const next = fn(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);
  const notify = useCallback((message: string) => setToast(message), []);
  const closeHandoff = useCallback(() => setHandoffActive(false), []);
  const connectHandoff = useCallback(
    (connection: HandoffConnection, model: HandoffModel) => {
      update((current) => applyHandoff(current, connection, model.model));
      setHandoffActive(false);
      setAttached([]);
      setInput('');
      setMobileTab('chat');
      setSidebarOpen(false);
      focusAfterHandoff.current = true;
      notify(
        `已连接，可以开始对话${model.fallback ? `。当前模型：${model.model}` : ''}${model.isGemini ? '（Gemini 当前仅支持文本）' : ''}`,
      );
    },
    [notify, update],
  );
  useEffect(() => {
    if (handoffActive || !focusAfterHandoff.current) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      focusAfterHandoff.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [handoffActive]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 6500);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    let live = true;
    loadState()
      .then((saved) => {
        if (live && saved) {
          try {
            const validated = parseBackup(backupState(saved));
            validated.settings = {
              ...DEFAULT_SETTINGS,
              ...saved.settings,
              apiKey: saved.settings.rememberKey ? saved.settings.apiKey : '',
            };
            stateRef.current = validated;
            setState(validated);
          } catch (e) {
            notify('本地数据无法读取，请恢复备份。' + readableError(e));
          }
        }
      })
      .catch(() => notify('浏览器未允许本地存储。当前仍可使用，请在关闭前导出工作区备份。'))
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, [notify]);
  useEffect(() => {
    if (ready)
      saveState(state).catch(() => {
        if (!persistenceError.current) {
          persistenceError.current = true;
          notify('本地保存失败，可能存储空间不足。请及时导出工作区备份。');
        }
      });
  }, [state, ready, notify]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (abortRef.current || importing) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [importing]);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      approvalRef.current?.resolve(false);
    },
    [],
  );
  const conversation =
    state.conversations.find((c) => c.id === state.activeConversationId) ?? state.conversations[0];
  const locked = busy || importing || !ready || handoffActive;
  function mutateConversation(id: string, fn: (c: Conversation) => Conversation) {
    update((s) => ({ ...s, conversations: s.conversations.map((c) => (c.id === id ? fn(c) : c)) }));
  }
  function addConversation() {
    if (locked) return;
    const c = newConversation();
    update((s) => ({ ...s, conversations: [c, ...s.conversations], activeConversationId: c.id }));
    setAttached([]);
    setInput('');
    setSidebarOpen(false);
    setMobileTab('chat');
  }
  function changeConversation(id: string) {
    if (locked) return;
    update((s) => ({ ...s, activeConversationId: id }));
    setAttached([]);
    setInput('');
    setSidebarOpen(false);
    setMobileTab('chat');
  }
  function recordChanges(changes: FileChange[]) {
    update((s) => ({
      ...s,
      files: applyChanges(s.files, changes),
      changes: [...s.changes, ...changes].slice(-100),
    }));
  }
  function answerApproval(yes: boolean) {
    approvalRef.current?.resolve(yes);
    approvalRef.current = null;
    setApproval(null);
  }
  async function approve(
    call: ToolCall,
    changes: FileChange[],
    signal: AbortSignal,
  ): Promise<boolean> {
    if (stateRef.current.settings.autoApprove) return true;
    signal.throwIfAborted();
    return new Promise((resolve) => {
      const onAbort = () => {
        answerApproval(false);
      };
      const pending = {
        call,
        changes,
        resolve: (yes: boolean) => {
          signal.removeEventListener('abort', onAbort);
          resolve(yes);
        },
      };
      approvalRef.current = pending;
      setApproval(pending);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  async function executeTool(call: ToolCall, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const files = stateRef.current.files;
    const read = readTool(call, files);
    if (read !== undefined) return read;
    let changes: FileChange[];
    let computation: Record<string, unknown> | undefined;
    if (call.name === 'run_javascript') {
      const args = parseArgs(call);
      if (typeof args.code !== 'string') throw new Error('计算代码必须是文字。');
      const result = await runSandbox(
        {
          code: args.code,
          files: files
            .filter((f) => f.kind === 'text' || !!f.content)
            .map((f) => ({ path: f.path, content: f.content })),
        },
        signal,
      );
      changes = result.writes.flatMap((w) =>
        planChanges(
          { id: call.id, name: 'write_file', arguments: JSON.stringify(w) },
          stateRef.current.files,
        ),
      );
      computation = { result: result.result, logs: result.logs };
    } else changes = planChanges(call, files);
    if (changes.length) {
      // Check all operations before approval so a rejected operation cannot partially apply.
      applyChanges(stateRef.current.files, changes);
      if (!(await approve(call, changes, signal)))
        return JSON.stringify({
          error: '用户拒绝了文件改动。所有拟议文件均未修改。',
          ...computation,
          writes_applied: false,
        });
      signal.throwIfAborted();
      recordChanges(changes);
    }
    return JSON.stringify({
      ok: true,
      ...computation,
      files_changed: changes.map((c) => ({ path: c.path, action: c.after ? 'saved' : 'deleted' })),
    });
  }
  async function send() {
    if (locked || (!input.trim() && !attached.length)) return;
    if (!stateRef.current.settings.apiKey) {
      setSettingsOpen(true);
      return;
    }
    const current = stateRef.current.conversations.find(
      (c) => c.id === stateRef.current.activeConversationId,
    )!;
    const settings = { ...stateRef.current.settings };
    let history = current.apiHistory;
    if (current.protocol && current.protocol !== settings.protocol) {
      history = current.messages
        .filter((m) => m.role !== 'tool' && m.content)
        .map((m) => ({ role: m.role, content: m.content }));
    }
    const files = attached
      .map((path) => stateRef.current.files.find((f) => f.path === path))
      .filter((f): f is WorkspaceFile => !!f);
    const text = input.trim() || '请阅读并分析这些附件。';
    const user: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: Date.now(),
      attachments: files.map((f) => ({
        path: f.path,
        name: f.path.split('/').pop()!,
        kind: f.kind,
      })),
    };
    let assistantId: string | null = crypto.randomUUID();
    let lastAssistantId = assistantId;
    const assistant: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'running',
    };
    mutateConversation(current.id, (c) => ({
      ...c,
      title: c.messages.length ? c.title : text.slice(0, 24),
      updatedAt: Date.now(),
      protocol: settings.protocol,
      messages: [...c.messages, user, assistant],
    }));
    setInput('');
    setAttached([]);
    setBusy(true);
    setRound(1);
    setMobileTab('chat');
    const controller = new AbortController();
    abortRef.current = controller;
    const toolIds = new Map<string, string>();
    try {
      await runAgent({
        settings,
        history,
        text,
        attachments: files,
        files: stateRef.current.files,
        tools: toolDefinitions,
        signal: controller.signal,
        executeTool: (call) => executeTool(call, controller.signal),
        onRound: setRound,
        onHistory: (apiHistory) => mutateConversation(current.id, (c) => ({ ...c, apiHistory })),
        onText: (delta) => {
          if (!delta) return;
          if (!assistantId) {
            assistantId = crypto.randomUUID();
            lastAssistantId = assistantId;
            const id = assistantId;
            mutateConversation(current.id, (c) => ({
              ...c,
              messages: [
                ...c.messages,
                { id, role: 'assistant', content: delta, createdAt: Date.now(), status: 'running' },
              ],
            }));
          } else {
            const id = assistantId;
            mutateConversation(current.id, (c) => ({
              ...c,
              messages: c.messages.map((m) =>
                m.id === id ? { ...m, content: m.content + delta } : m,
              ),
            }));
          }
        },
        onToolStart: (call) => {
          const id = crypto.randomUUID();
          toolIds.set(call.id, id);
          const previous = assistantId;
          assistantId = null;
          mutateConversation(current.id, (c) => ({
            ...c,
            messages: [
              ...c.messages
                .filter((m) => m.id !== previous || m.content)
                .map((m) => (m.id === previous ? { ...m, status: 'done' as const } : m)),
              {
                id,
                role: 'tool',
                content: '',
                createdAt: Date.now(),
                toolName: call.name,
                toolArgs: call.arguments,
                status: 'running',
              },
            ],
          }));
        },
        onToolEnd: (call, result, error) =>
          mutateConversation(current.id, (c) => ({
            ...c,
            messages: c.messages.map((m) =>
              m.id === toolIds.get(call.id)
                ? {
                    ...m,
                    content: result,
                    status: error || result.includes('"error"') ? 'error' : 'done',
                  }
                : m,
            ),
          })),
      });
      mutateConversation(current.id, (c) => ({
        ...c,
        messages: c.messages.map((m) => (m.status === 'running' ? { ...m, status: 'done' } : m)),
        updatedAt: Date.now(),
      }));
    } catch (e) {
      const stopped = controller.signal.aborted;
      const error = stopped
        ? '已停止本次任务。已经确认的文件改动仍保留在工作区。'
        : readableError(e, settings.apiKey);
      mutateConversation(current.id, (c) => {
        const last = c.messages.find((m) => m.id === lastAssistantId);
        const messages = c.messages.map((m) =>
          m.status === 'running'
            ? { ...m, status: stopped ? ('stopped' as const) : ('error' as const) }
            : m,
        );
        if (last) {
          return {
            ...c,
            messages: messages.map((m) =>
              m.id === lastAssistantId
                ? {
                    ...m,
                    content: m.content + (m.content ? '\n\n' : '') + error,
                    status: stopped ? 'stopped' : 'error',
                  }
                : m,
            ),
          };
        }
        return {
          ...c,
          messages: [
            ...messages,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: error,
              createdAt: Date.now(),
              status: stopped ? 'stopped' : 'error',
            },
          ],
        };
      });
    } finally {
      abortRef.current = null;
      setBusy(false);
      answerApproval(false);
    }
  }
  async function importFiles(list: FileList | File[] | null) {
    if (!list?.length || locked) return;
    setImporting(true);
    try {
      const imported: WorkspaceFile[] = [];
      const errors: string[] = [];
      for (const file of Array.from(list)) {
        try {
          if (/\.zip$/i.test(file.name)) imported.push(...(await importZip(file)));
          else imported.push(await importFile(file));
        } catch (e) {
          errors.push(`${file.name}：${readableError(e)}`);
        }
      }
      const merged = new Map(imported.map((f) => [f.path, f]));
      const duplicates = [...merged.keys()].filter((p) =>
        stateRef.current.files.some((f) => f.path === p),
      );
      if (
        duplicates.length &&
        !window.confirm(
          `导入的 ${duplicates.length} 个文件与现有文件重名。是否替换？\n${duplicates.slice(0, 5).join('\n')}\n选择取消将仅导入其他文件。`,
        )
      )
        for (const path of duplicates) merged.delete(path);
      const changes = [...merged.values()].map((f) => ({
        id: crypto.randomUUID(),
        path: f.path,
        before: stateRef.current.files.find((old) => old.path === f.path) ?? null,
        after: f,
        timestamp: Date.now(),
        source: 'user' as const,
      }));
      if (changes.length) {
        recordChanges(changes);
        setAttached((a) => [...new Set([...a, ...changes.map((c) => c.path)])]);
        notify(
          `已在本地导入 ${changes.length} 个文件，并附加到下一条消息。${errors.length ? ' 部分文件未导入：' + errors.join('；') : ''}`,
        );
      } else if (errors.length) notify(errors.join('；'));
    } catch (e) {
      notify(readableError(e));
    } finally {
      setImporting(false);
      if (uploadRef.current) uploadRef.current.value = '';
      if (folderRef.current) folderRef.current.value = '';
    }
  }
  function saveFile(path: string, content: string) {
    try {
      const after = textFile(path, content);
      recordChanges([
        {
          id: crypto.randomUUID(),
          path,
          before: stateRef.current.files.find((f) => f.path === path) ?? null,
          after,
          timestamp: Date.now(),
          source: 'user',
        },
      ]);
      notify('文件已保存在本地。');
    } catch (e) {
      notify(readableError(e));
    }
  }
  function createFile() {
    try {
      const file = textFile(newPath, '');
      if (stateRef.current.files.some((f) => f.path === file.path))
        throw new Error('该文件已存在，请使用不同的名称。');
      saveFile(file.path, '');
      setSelected(file.path);
      setMobileTab('files');
      setNewPath('');
      setCreateOpen(false);
    } catch (e) {
      notify(readableError(e));
    }
  }
  function deleteFile(path: string) {
    if (!window.confirm(`删除 ${path}？可以从改动记录撤销。`)) return;
    recordChanges([
      {
        id: crypto.randomUUID(),
        path,
        before: stateRef.current.files.find((f) => f.path === path)!,
        after: null,
        timestamp: Date.now(),
        source: 'user',
      },
    ]);
    setAttached((a) => a.filter((p) => p !== path));
    setSelected(null);
  }
  function undo(id: string) {
    const c = stateRef.current.changes.find((c) => c.id === id);
    if (!c) return;
    const changes = stateRef.current.changes;
    if (changes.slice(changes.indexOf(c) + 1).some((x) => x.path === c.path)) {
      notify('请先撤销这个文件后续的改动。');
      return;
    }
    update((s) => ({
      ...s,
      files: applyChanges(s.files, [{ ...c, after: c.before }]),
      changes: s.changes.filter((x) => x.id !== id),
    }));
    notify(`已撤销 ${c.path} 的改动。`);
  }
  function saveSettings(settings: Settings) {
    update((s) => ({
      ...s,
      settings: {
        ...settings,
        connectionSource:
          settings.baseUrl !== s.settings.baseUrl ||
          settings.apiKey !== s.settings.apiKey ||
          settings.protocol !== s.settings.protocol
            ? undefined
            : settings.connectionSource,
      },
    }));
    setSettingsOpen(false);
    notify('模型连接设置已保存。');
  }
  function exportBackup() {
    downloadBlob(
      new Blob([backupState(stateRef.current)], { type: 'application/json' }),
      'localdesk-workspace.json',
    );
    setMenuOpen(false);
  }
  async function restoreBackup(file: File | undefined) {
    if (!file || locked) return;
    try {
      if (file.size > 150 * 1024 * 1024) throw new Error('备份最大为 150 MB。');
      const restored = parseBackup(await file.text());
      if (!window.confirm('恢复备份将替换当前文件与对话。建议先导出当前工作区。是否继续？')) return;
      // A backup can name a different endpoint or Key ID. Never attach the
      // current secret to that imported connection.
      update(() => restored);
      setAttached([]);
      setSelected(null);
      notify('工作区已从备份恢复，请重新连接模型。');
    } catch (e) {
      notify(readableError(e));
    } finally {
      if (backupRef.current) backupRef.current.value = '';
    }
  }
  function deleteConversation(id: string) {
    if (locked || !window.confirm('删除这段对话？工作区文件会保留。')) return;
    update((s) => {
      let list = s.conversations.filter((c) => c.id !== id);
      if (!list.length) list = [newConversation()];
      return {
        ...s,
        conversations: list,
        activeConversationId: s.activeConversationId === id ? list[0].id : s.activeConversationId,
      };
    });
  }
  const filePanel = (
    <FilePanel
      files={state.files}
      changes={state.changes}
      busy={locked}
      selected={selected}
      setSelected={setSelected}
      onUpload={() => uploadRef.current?.click()}
      onFolder={() => folderRef.current?.click()}
      onCreate={() => setCreateOpen(true)}
      onSave={saveFile}
      onDelete={deleteFile}
      onUndo={undo}
      onAttach={(path) => {
        setAttached((a) => [...new Set([...a, path])]);
        setMobileTab('chat');
        notify('已附加到下一条消息。');
      }}
    />
  );
  return (
    <div
      className={`app ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void importFiles(e.dataTransfer.files);
      }}
    >
      <input
        type="file"
        multiple
        hidden
        ref={uploadRef}
        onChange={(e) => void importFiles(e.target.files)}
        aria-label="上传附件"
      />
      <input
        type="file"
        multiple
        hidden
        ref={folderRef}
        {...{ webkitdirectory: '' }}
        onChange={(e) => void importFiles(e.target.files)}
      />
      <input
        type="file"
        accept=".json"
        hidden
        ref={backupRef}
        onChange={(e) => void restoreBackup(e.target.files?.[0])}
      />
      {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <a className="brand" href="#" onClick={(e) => e.preventDefault()}>
          <span className="brand-symbol">
            <Terminal size={22} />
          </span>
          <span>
            Localdesk<span className="brand-caption">你的本地 AI 工作台</span>
          </span>
        </a>
        <button className="new-chat" onClick={addConversation} disabled={locked}>
          <Plus size={18} />
          新的对话
        </button>
        <div className="sidebar-label">
          最近的对话 <span>{state.conversations.length}</span>
        </div>
        <nav className="conversation-list" aria-label="对话列表">
          {state.conversations.map((c) => (
            <div
              className={`conversation-row ${c.id === conversation.id ? 'active' : ''}`}
              key={c.id}
            >
              <button onClick={() => changeConversation(c.id)} disabled={locked}>
                <MessageSquare size={16} />
                <span>{c.title}</span>
              </button>
              <button
                className="delete-conversation"
                onClick={() => deleteConversation(c.id)}
                disabled={locked}
                aria-label={`删除对话 ${c.title}`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <div className="local-card-icon">
              <ShieldCheck size={21} />
            </div>
            <strong>你的文件，留在本机</strong>
            <p>
              本地处理、本地保存。
              <br />
              只将所需内容发送给模型。
            </p>
            <small>所有对话共用这个工作区</small>
          </div>
          <button
            className="sidebar-setting"
            onClick={() => {
              setSettingsOpen(true);
              setSidebarOpen(false);
            }}
            disabled={locked}
          >
            <Settings2 size={18} />
            <span>模型与连接</span>
            <span className={`connection-dot ${state.settings.apiKey ? 'connected' : ''}`} />
          </button>
          <div className="sidebar-footnote">
            为想法腾出空间 <span>v1.0</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button menu-toggle"
              onClick={() => setSidebarOpen(true)}
              aria-label="打开对话列表"
            >
              <Menu size={20} />
            </button>
            <h1>{conversation.messages.length ? conversation.title : '开始你的下一件事'}</h1>
            <span className="local-badge">
              <span className="status-dot" />
              本地工作区
            </span>
          </div>
          <div className="topbar-right">
            <button className="model-pill" onClick={() => setSettingsOpen(true)} disabled={locked}>
              <Zap size={14} />
              <span>{state.settings.model}</span>
              <ChevronDown size={13} />
            </button>
            <div className="workspace-menu">
              <button
                className="icon-button"
                aria-label="工作区菜单"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <MoreHorizontal size={21} />
              </button>
              {menuOpen && (
                <>
                  <div className="menu-dismiss" onClick={() => setMenuOpen(false)} />
                  <div className="dropdown-menu">
                    <button
                      disabled={!state.files.length}
                      onClick={() => {
                        exportFiles(state.files);
                        setMenuOpen(false);
                      }}
                    >
                      <Download size={16} />
                      下载全部文件 ZIP
                    </button>
                    <button onClick={exportBackup}>
                      <Download size={16} />
                      导出工作区备份
                    </button>
                    <button
                      disabled={locked}
                      onClick={() => {
                        backupRef.current?.click();
                        setMenuOpen(false);
                      }}
                    >
                      <Upload size={16} />
                      恢复工作区备份
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>
        <div className="work-layout">
          <main
            className={`chat-panel ${mobileTab === 'chat' ? 'mobile-active' : ''}`}
            aria-label="AI 对话"
          >
            {!conversation.messages.length ? (
              <div className="welcome-scroll">
                <div className="welcome">
                  <div className="welcome-eyebrow">
                    <span />让 AI 和你一起动手
                  </div>
                  <h2>
                    把想法，
                    <br />
                    变成<span>文件。</span>
                  </h2>
                  <p className="welcome-description">
                    从一份文档、一个问题，或者一个灵感开始。
                    <br />
                    读文件、做分析、写内容，就在你的浏览器里。
                  </p>
                  <div className="suggestion-grid">
                    {suggestions.map(({ icon: Icon, title, description, prompt }) => (
                      <button
                        key={title}
                        onClick={() => {
                          setInput(prompt);
                          inputRef.current?.focus();
                        }}
                        disabled={locked}
                      >
                        <Icon size={20} />
                        <strong>{title}</strong>
                        <span>{description}</span>
                        <ArrowUp size={14} className="suggestion-arrow" />
                      </button>
                    ))}
                  </div>
                  <div className="welcome-hint">
                    <ShieldCheck size={15} />
                    无需服务器 · 本地文件 · 使用你选择的模型
                  </div>
                </div>
              </div>
            ) : (
              <ChatMessages messages={conversation.messages} busy={busy} />
            )}
            <div className="composer-area">
              {busy && (
                <div className="task-status">
                  <span className="pulse-dot" />
                  {approval ? '等待你确认文件改动' : `正在处理 · 第 ${round} 轮`}
                  <button onClick={() => abortRef.current?.abort()}>停止任务</button>
                </div>
              )}
              <div className={`composer ${busy ? 'busy' : ''}`}>
                {!!attached.length && (
                  <div className="attachment-chips">
                    {attached.map((path) => {
                      const f = state.files.find((f) => f.path === path);
                      return f ? (
                        <span key={path}>
                          {fileIcon(f, 14)}
                          <span title={path}>{path.split('/').pop()}</span>
                          <button
                            aria-label={`移除附件 ${path}`}
                            onClick={() => setAttached((a) => a.filter((p) => p !== path))}
                          >
                            <X size={13} />
                          </button>
                        </span>
                      ) : null;
                    })}
                  </div>
                )}
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={
                    state.settings.apiKey
                      ? '告诉 AI 你想完成什么，或先添加文件…'
                      : '写下你想做的事，连接模型后就能开始…'
                  }
                  aria-label="消息"
                  rows={2}
                  disabled={locked}
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing &&
                      (e.ctrlKey || e.metaKey || window.matchMedia('(pointer: fine)').matches)
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="composer-toolbar">
                  <div>
                    <button
                      className="icon-button"
                      onClick={() => uploadRef.current?.click()}
                      disabled={locked}
                      aria-label="添加附件"
                      title="添加图片、文档或 ZIP"
                    >
                      <Paperclip size={19} />
                    </button>
                    <span className="composer-label">
                      {importing ? '正在本地导入…' : '附件 / 图片'}
                    </span>
                  </div>
                  <div>
                    <span className="send-hint">Enter 发送</span>
                    {busy ? (
                      <button
                        className="send-button stop"
                        onClick={() => abortRef.current?.abort()}
                        aria-label="停止生成"
                      >
                        <Square size={17} fill="currentColor" />
                      </button>
                    ) : (
                      <button
                        className="send-button"
                        onClick={() => void send()}
                        disabled={locked || (!input.trim() && !attached.length)}
                        aria-label="发送消息"
                      >
                        <ArrowUp size={21} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <p className="composer-footnote">
                {state.settings.model.startsWith('gemini-')
                  ? 'Gemini 当前仅支持文本。文件操作与计算在本机执行；必要内容发送至所选模型。'
                  : 'AI 可能出错，请检查重要结果。文件操作与计算在本机执行；必要内容发送至所选模型。'}
              </p>
            </div>
          </main>
          <div className={`files-shell ${mobileTab === 'files' ? 'mobile-active' : ''}`}>
            {filePanel}
          </div>
        </div>
        <nav className="mobile-nav" aria-label="主导航">
          <button
            className={mobileTab === 'chat' ? 'active' : ''}
            onClick={() => setMobileTab('chat')}
          >
            <MessageSquare size={19} />
            对话
          </button>
          <button
            className={mobileTab === 'files' ? 'active' : ''}
            onClick={() => setMobileTab('files')}
          >
            <FolderOpen size={19} />
            文件{state.files.length > 0 && <span>{state.files.length}</span>}
          </button>
          <button onClick={() => setSettingsOpen(true)} disabled={locked}>
            <Settings2 size={19} />
            模型
          </button>
        </nav>
      </div>
      {ready && handoffActive && startupHandoff && (
        <HandoffDialog
          handoff={startupHandoff}
          settings={state.settings}
          onConnected={connectHandoff}
          onClose={closeHandoff}
        />
      )}
      {settingsOpen && !handoffActive && (
        <SettingsDialog
          settings={state.settings}
          onSave={saveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {createOpen && (
        <Modal title="新建本地文件" onClose={() => setCreateOpen(false)}>
          <p className="modal-description">文件会保存在浏览器工作区内。可使用文件夹路径。</p>
          <label className="create-label">
            文件名
            <input
              autoFocus
              value={newPath}
              placeholder="例如：笔记.md 或 项目/index.html"
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createFile();
              }}
            />
          </label>
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button className="button primary" onClick={createFile}>
              创建文件
            </button>
          </div>
        </Modal>
      )}
      {approval && (
        <Modal
          title={`确认 ${approval.changes.length} 个文件改动`}
          wide
          onClose={() => answerApproval(false)}
        >
          <p className="modal-description">
            AI 请求修改下面的本地文件。检查后决定是否允许，本次操作可从改动记录撤销。
          </p>
          <div className="approval-files">
            {approval.changes.map((c) => (
              <details key={c.id} open={approval.changes.length === 1}>
                <summary>
                  <span className={`change-tag ${c.after ? '' : 'deleted'}`}>
                    {!c.after ? '删除' : c.before ? '修改' : '新建'}
                  </span>
                  {c.path}
                </summary>
                <div className="approval-diff">
                  <div>
                    <small>修改前</small>
                    <pre className="diff-before">
                      {c.before?.kind === 'image'
                        ? '（原始图片）'
                        : (c.before?.content ?? '（文件不存在）')}
                    </pre>
                  </div>
                  <div>
                    <small>修改后</small>
                    <pre className="diff-after">{c.after?.content ?? '（删除文件）'}</pre>
                  </div>
                </div>
              </details>
            ))}
          </div>
          <div className="modal-actions">
            <button className="text-button danger" onClick={() => abortRef.current?.abort()}>
              <Square size={13} /> 停止任务
            </button>
            <button className="button secondary" onClick={() => answerApproval(false)}>
              拒绝改动
            </button>
            <button className="button primary" onClick={() => answerApproval(true)}>
              <Check size={17} />
              允许并保存到本地
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button className="icon-button" onClick={() => setToast('')} aria-label="关闭通知">
            <X size={16} />
          </button>
        </div>
      )}
      {dragging && (
        <div className="drop-overlay">
          <Upload size={38} />
          <h2>放下文件，开始一起工作</h2>
          <p>文件只导入到你的本地浏览器</p>
        </div>
      )}
    </div>
  );
}
