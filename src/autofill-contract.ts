import type { FieldRequest, VerifiedField } from './preview-contract';
import type { Layer } from './policy';

export type VaultKind = 'login' | 'card';
export type AutofillField = 'username' | 'password' | 'cardholder' | 'cardNumber' | 'expiryMonth' | 'expiryYear' | 'expiry';
export type LoginRecord = Readonly<{ version: 1; kind: 'login'; username: string; password: string }>;
export type CardRecord = Readonly<{ version: 1; kind: 'card'; cardholder: string; cardNumber: string; expiryMonth: string; expiryYear: string }>;
export type VaultRecord = LoginRecord | CardRecord;
export type VaultEntry = Readonly<{ origin: string; recordId: string; createdAt: string; updatedAt: string }>;

/** Trusted owner/executor only. Neither these calls nor record values are model tools. */
export interface AutofillVault {
  list(origin: string): Promise<readonly VaultEntry[]>;
  save(origin: string, recordId: string, record: VaultRecord): Promise<void>;
  read(origin: string, recordId: string, kind: VaultKind): Promise<VaultRecord>;
}
export type AutofillCandidate = Readonly<{ field: AutofillField; verified: VerifiedField }>;
export type AutofillFieldDefinition = Readonly<{ name: string; category: Layer; kind: VaultKind }>;
export const AUTOFILL_FIELDS: Readonly<Record<AutofillField, AutofillFieldDefinition>> = Object.freeze({
  username: { name: 'Username / email', category: 'yellow', kind: 'login' },
  password: { name: 'Password', category: 'red', kind: 'login' },
  cardholder: { name: 'Name on card', category: 'red', kind: 'card' },
  cardNumber: { name: 'Card number', category: 'red', kind: 'card' },
  expiryMonth: { name: 'Expiry month', category: 'red', kind: 'card' },
  expiryYear: { name: 'Expiry year', category: 'red', kind: 'card' },
  expiry: { name: 'Expiry date (MM/YY)', category: 'red', kind: 'card' },
});
export function fieldRequest(field: AutofillField, fieldSelector: string, requestSelector: string): FieldRequest {
  const definition = AUTOFILL_FIELDS[field];
  return Object.freeze({ id: field, credential: 'autofill:' + field, name: definition.name,
    category: definition.category, fieldSelector, requestSelector });
}
