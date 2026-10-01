import { useState } from 'react';
import { Eye, EyeOff, RefreshCw, ShieldCheck, ExternalLink } from 'lucide-react';
import type { Settings } from '../types';
import { endpoint, fetchModels, readableError } from '../lib/api';
import Modal from './Modal';
export default function SettingsDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: Settings;
  onSave: (settings: Settings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState({ ...settings });
  const [reveal, setReveal] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const patch = (values: Partial<Settings>) => setDraft((s) => ({ ...s, ...values }));
  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      setModels(await fetchModels(draft));
    } catch (e) {
      setError(readableError(e, draft.apiKey));
    } finally {
      setLoading(false);
    }
  };
  const save = () => {
    try {
      endpoint(draft.baseUrl, 'responses');
      if (!draft.model.trim()) throw new Error('请填写模型名称。');
      onSave({
        ...draft,
        model: draft.model.trim(),
        apiKey: draft.apiKey.trim(),
        baseUrl: draft.baseUrl.trim(),
      });
    } catch (e) {
      setError(readableError(e));
    }
  };
  return (
    <Modal title="连接你的 AI" onClose={onClose}>
      <p className="modal-description">
        用你自己的 API 服务和密钥开始工作。请求从此浏览器直接发送。
      </p>
      <div className="form-fields">
        <label>
          API URL
          <input
            value={draft.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
            autoCapitalize="none"
            spellCheck={false}
          />
          <small>可填写基础地址或完整的 /responses 地址。服务需支持浏览器跨域请求（CORS）。</small>
        </label>
        <label>
          API Key
          <div className="input-with-button">
            <input
              type={reveal ? 'text' : 'password'}
              value={draft.apiKey}
              onChange={(e) => patch({ apiKey: e.target.value })}
              placeholder="粘贴你的 API Key"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              className="icon-button"
              onClick={() => setReveal(!reveal)}
              aria-label={reveal ? '隐藏密钥' : '显示密钥'}
            >
              {reveal ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={draft.rememberKey}
            onChange={(e) => patch({ rememberKey: e.target.checked })}
          />
          在这台设备记住密钥
        </label>
        <small className="field-note">
          默认只在当前页面内存中使用。勾选后密钥会明文保存到此浏览器；工作区备份始终排除密钥。
        </small>
        <label>
          模型
          <div className="input-with-button">
            <input
              list="model-options"
              value={draft.model}
              onChange={(e) => patch({ model: e.target.value })}
              placeholder="输入服务提供的模型 ID"
              autoCapitalize="none"
              spellCheck={false}
            />
            <button
              className="icon-button"
              onClick={refresh}
              disabled={loading || !draft.apiKey}
              aria-label="获取模型列表"
              title="从你的服务获取模型列表"
            >
              <RefreshCw size={18} className={loading ? 'spin' : ''} />
            </button>
          </div>
          <datalist id="model-options">
            {[...new Set([draft.model, ...models])].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <small>
            {models.length
              ? `已获取 ${models.length} 个模型。`
              : '可自由填写模型名称，也可点击右侧按钮获取列表。'}
          </small>
        </label>
        <div className="form-grid">
          <label>
            请求协议
            <select
              value={draft.protocol}
              onChange={(e) => patch({ protocol: e.target.value as Settings['protocol'] })}
            >
              <option value="responses">Responses（Codex 同协议）</option>
              <option value="chat">Chat Completions（兼容服务）</option>
            </select>
          </label>
          <label>
            思考力度
            <select
              value={draft.reasoning}
              onChange={(e) => patch({ reasoning: e.target.value as Settings['reasoning'] })}
            >
              <option value="">模型默认</option>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </label>
        </div>
        <details className="advanced">
          <summary>高级设置</summary>
          <label>
            自定义助手指令
            <textarea
              rows={3}
              value={draft.systemPrompt}
              onChange={(e) => patch({ systemPrompt: e.target.value })}
              placeholder="例如：请用通俗的中文解释操作结果。"
            />
          </label>
          <label>
            每次任务最多工具轮数
            <input
              type="number"
              min={1}
              max={50}
              value={draft.maxRounds}
              onChange={(e) =>
                patch({ maxRounds: Math.max(1, Math.min(50, Number(e.target.value) || 20)) })
              }
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.autoApprove}
              onChange={(e) => patch({ autoApprove: e.target.checked })}
            />
            自动允许 AI 修改工作区文件
          </label>
          <small>默认逐次确认。自动允许后仍可在改动记录中撤销。</small>
        </details>
      </div>
      {error && (
        <div role="alert" className="error-box">
          {error}
        </div>
      )}
      <div className="privacy-note">
        <ShieldCheck size={18} />
        <span>
          文件处理和存储在本机完成。发出的对话、图片和模型读取的文件内容会传给你选择的 API 服务。
        </span>
      </div>
      <div className="modal-actions">
        <a
          href="https://developers.openai.com/api/docs/guides/function-calling"
          target="_blank"
          rel="noreferrer"
        >
          了解 API <ExternalLink size={13} />
        </a>
        <button className="button primary" onClick={save}>
          保存设置
        </button>
      </div>
    </Modal>
  );
}
