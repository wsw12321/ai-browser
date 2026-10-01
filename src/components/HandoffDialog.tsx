import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import type { Settings } from '../types';
import {
  checkHandoffModels,
  isDifferentConnection,
  type BrowserHandoff,
  type HandoffConnection,
  type HandoffModel,
} from '../lib/handoff';
import Modal from './Modal';

type Stage = 'exchanging' | 'confirm' | 'checking' | 'exchange-error' | 'model-error';

export default function HandoffDialog({
  handoff,
  settings,
  onConnected,
  onClose,
}: {
  handoff: BrowserHandoff;
  settings: Settings;
  onConnected: (connection: HandoffConnection, model: HandoffModel) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>('exchanging');
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<HandoffConnection | null>(null);
  const checking = useRef<AbortController | null>(null);
  const check = useCallback(
    async (next: HandoffConnection) => {
      checking.current?.abort();
      const controller = new AbortController();
      checking.current = controller;
      setStage('checking');
      setError('');
      try {
        const model = await checkHandoffModels(next, controller.signal);
        if (!controller.signal.aborted) onConnected(next, model);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : '模型检查失败，请稍后重试。');
        setStage('model-error');
      }
    },
    [onConnected],
  );
  useEffect(() => {
    let live = true;
    void handoff.exchange().then(
      (next) => {
        if (!live) return;
        setConnection(next);
        if (isDifferentConnection(settings, next)) setStage('confirm');
        else void check(next);
      },
      () => {
        if (!live) return;
        setError('连接码已失效、已使用，或网关暂时无法连接。请返回网关重新接入。');
        setStage('exchange-error');
      },
    );
    return () => {
      live = false;
      checking.current?.abort();
    };
  }, [handoff, settings, check]);
  const cancel = useCallback(() => {
    checking.current?.abort();
    onClose();
  }, [onClose]);

  return (
    <Modal title={stage === 'confirm' ? '切换工作台连接' : '连接网页工作台'} onClose={cancel}>
      {stage === 'confirm' ? (
        <>
          <p className="modal-description">
            此工作台已有其他连接。确认后将使用网关提供的 API Key，并进入新的对话。
            现有文件和历史对话都会保留。
          </p>
          <div className="handoff-details">
            <p>当前连接：{settings.baseUrl}</p>
            <p>新的连接：{connection?.baseUrl}</p>
          </div>
        </>
      ) : stage === 'exchanging' || stage === 'checking' ? (
        <p className="handoff-progress" role="status">
          <RefreshCw size={18} className="spin" />
          {stage === 'exchanging' ? '正在安全接入网关…' : '正在检查可用模型…'}
        </p>
      ) : (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {connection && (
        <div className="privacy-note">
          <ShieldCheck size={18} />
          <span>
            {connection.rememberKey
              ? '密钥将保存在这台设备的浏览器中，刷新后仍可使用。工作区备份不包含密钥。'
              : '密钥仅在当前页面内存中使用，刷新后需要从网关重新接入。工作区备份不包含密钥。'}
          </span>
        </div>
      )}
      {stage === 'model-error' && (
        <p className="field-note">原连接设置已保留。可以重试检查，无需重新获取连接码。</p>
      )}
      <div className="modal-actions">
        <button className="button secondary" onClick={cancel}>
          取消
        </button>
        {stage === 'confirm' && connection && (
          <button className="button primary" onClick={() => void check(connection)}>
            确认切换
          </button>
        )}
        {stage === 'model-error' && connection && (
          <button className="button primary" onClick={() => void check(connection)}>
            重试检查
          </button>
        )}
        {(stage === 'exchange-error' || stage === 'model-error') && (
          <a href={handoff.gatewayUrl} className="button secondary" referrerPolicy="no-referrer">
            返回网关重新接入
          </a>
        )}
      </div>
    </Modal>
  );
}
