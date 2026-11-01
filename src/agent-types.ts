import type { InformationFieldKind, InformationVariable, InformationVariableKind, InformationVariableInput, InformationVault } from './information-contract';
export type ModelProviderPreset = 'openai' | 'groq' | 'openrouter' | 'ollama' | 'lmstudio' | 'custom';
export interface ModelSettings { mode: 'local' | 'cloud'; preset: ModelProviderPreset; endpoint: string; apiKey?: string; model: string }
export interface AgentWorkspaceSettings {
  model: ModelSettings;
  navigation: { mode: 'whitelist' | 'blacklist'; domains: string[] };
  memory: { enabled: boolean; content: string };
  groups: { id: string; name: string; variables: string[] }[];
}
export interface WorkspaceStoredData { settings: AgentWorkspaceSettings; notes: AgentNote[] }
/** Trusted host storage. Neither API keys nor private memory may be written as plaintext. */
export interface WorkspaceStore { load(): Promise<WorkspaceStoredData | null>; save(data: WorkspaceStoredData): Promise<void> }
export interface AgentMessage { id: string; role: 'user' | 'assistant' | 'tool' | 'subagent'; content: string; timestamp: number; agent?: string }
export interface AgentNote { id: string; topic: string; content: string; timestamp: number; sourceUrl: string; agent?: string }
export interface BrowserField { id: string; label: string; kind: InformationFieldKind; required: boolean; options?: string[] }
export interface BrowserAction { id: string; label: string; kind: 'link' | 'button'; href?: string }
/** Metadata/text ONLY. No values, cookies, hidden DOM, screenshots, or arbitrary model selectors. */
export interface BrowserObservation { url: string; title: string; text: string; fields: BrowserField[]; actions: BrowserAction[]; publicOnly: boolean; truncated: boolean }
export interface BrowserFrame { image: string; width: number; height: number }
export interface AgentBrowser {
  navigate(url: string, signal: AbortSignal): Promise<BrowserObservation>;
  observe(signal: AbortSignal): Promise<BrowserObservation>;
  click(actionId: string, signal: AbortSignal): Promise<BrowserObservation>;
  type(fieldId: string, text: string, signal: AbortSignal): Promise<BrowserObservation>;
  fill(fieldId: string, value: string, signal: AbortSignal): Promise<void>;
  scroll(direction: 'up' | 'down', signal: AbortSignal): Promise<BrowserObservation>;
  research(url: string, signal: AbortSignal): Promise<BrowserObservation>;
  capture(): Promise<BrowserFrame | null>;
  setNavigation(policy: AgentWorkspaceSettings['navigation']): Promise<void>;
  currentOrigin(): string | undefined;
  redact(text: string): string;
  close(): Promise<void>;
}
export interface WorkspacePermission {
  id: string; type: 'variable' | 'action'; origin: string; label: string; description: string;
  fieldId?: string; variableName?: string; variableDescription?: string; kind?: InformationVariableKind; actionId?: string;
}
export interface WorkspaceInformationRequest {
  id: string; origin: string; fieldId: string; name: string; description: string; kind: InformationFieldKind;
}
export interface VariablePermissionGrant { id: string; origin: string; names: string[]; group?: string; task: string }
export interface WorkspaceState {
  phase: 'idle' | 'running' | 'waiting' | 'stopped' | 'failed'; messages: readonly AgentMessage[]; notes: readonly AgentNote[];
  settings: Omit<AgentWorkspaceSettings, 'model'> & { model: Omit<ModelSettings, 'apiKey'> & { keyConfigured: boolean } };
  variables: readonly InformationVariable[]; permission?: WorkspacePermission; request?: WorkspaceInformationRequest;
  grants: readonly VariablePermissionGrant[]; origin?: string; error: string;
}
export interface AgentEngineOptions {
  browser: AgentBrowser; vault: InformationVault; store: WorkspaceStore; hosted: boolean;
  assertActive(): void; onState(state: WorkspaceState): void;
  onFrame(frame: BrowserFrame | null): void;
  modelProxy?: string;
  audit?(event: 'approved' | 'approval_denied' | 'fill_authorized' | 'submit_authorized' | 'completed' | 'revoked', task: string): void;
}
export interface NewVariableCommand { input: InformationVariableInput }
