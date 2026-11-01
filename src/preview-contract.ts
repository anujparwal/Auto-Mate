import type { ElementHandle, Page } from 'playwright';
import type { Layer } from './policy';

export interface FieldRequest {
  readonly id: string;
  readonly credential: string;
  readonly name: string;
  readonly category: Layer;
  readonly fieldSelector: string;
  readonly requestSelector: string;
}
export type Association = 'label-for' | 'label-wrap' | 'aria-labelledby';
/** Internal executor capability: must never be serialized to a model or the owner page. */
export interface VerifiedField {
  readonly request: FieldRequest;
  readonly field: ElementHandle<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
  readonly source: ElementHandle<HTMLElement>;
  readonly association: Association;
  readonly sourceText: string;
}
export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface Annotation {
  readonly id: string;
  readonly name: string;
  readonly category: Layer;
  readonly sourceText: string;
  readonly association: Association;
  readonly source: Rect;
  readonly field: Rect;
}
export interface OwnerFrame {
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly annotations: readonly Annotation[];
  readonly capturedAt: number;
}
export type PreviewPhase = 'requested' | 'verified' | 'filling' | 'filled' | 'submitting' | 'completed' | 'takeover' | 'stopped' | 'denied';
/** Owner-only internal observer. Never expose its page, frames, or DOM evidence as model tools. */
export interface WorkflowObserver {
  requested(page: Page, origin: string, requests: readonly FieldRequest[]): Promise<void>;
  verified(page: Page, origin: string, fields: readonly VerifiedField[]): Promise<void>;
  state(phase: PreviewPhase, fieldId?: string): Promise<void>;
}
