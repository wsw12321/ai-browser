export interface WorkspaceFile {
  path: string;
  content: string;
  kind: 'text' | 'image' | 'binary';
  mime: string;
  size: number;
  updatedAt: number;
  /** Original binary attachment, as a data URL. Text extraction stays in content. */
  dataUrl?: string;
}
export interface FileChange {
  id: string;
  path: string;
  before: WorkspaceFile | null;
  after: WorkspaceFile | null;
  timestamp: number;
  source: 'ai' | 'user';
}
export interface Attachment {
  path: string;
  name: string;
  kind: WorkspaceFile['kind'];
}
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: number;
  attachments?: Attachment[];
  toolName?: string;
  toolArgs?: string;
  status?: 'running' | 'done' | 'error' | 'stopped';
}
export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  /** Exact API history including reasoning and tool results; never persisted on the API. */
  apiHistory: Record<string, unknown>[];
  createdAt: number;
  updatedAt: number;
  protocol?: Settings['protocol'];
}
export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: 'responses' | 'chat';
  reasoning: '' | 'low' | 'medium' | 'high';
  rememberKey: boolean;
  autoApprove: boolean;
  systemPrompt: string;
  maxRounds: number;
}
export interface AppState {
  version: 1;
  files: WorkspaceFile[];
  changes: FileChange[];
  conversations: Conversation[];
  activeConversationId: string;
  settings: Settings;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}
export interface ApprovalRequest {
  call: ToolCall;
  description: string;
  before?: string;
  after?: string;
}
export interface AgentOptions {
  settings: Settings;
  history: Record<string, unknown>[];
  text: string;
  attachments: WorkspaceFile[];
  files: WorkspaceFile[];
  tools: ToolDefinition[];
  signal: AbortSignal;
  executeTool: (call: ToolCall) => Promise<string>;
  onText: (delta: string) => void;
  onToolStart: (call: ToolCall) => void;
  onToolEnd: (call: ToolCall, result: string, error?: boolean) => void;
  onRound?: (round: number) => void;
  onHistory?: (history: Record<string, unknown>[]) => void;
}
export interface AgentResult {
  history: Record<string, unknown>[];
  text: string;
}
