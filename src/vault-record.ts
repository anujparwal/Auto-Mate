import type { VaultKind, VaultRecord } from './autofill-contract';
import { PolicyError } from './policy';

/**
 * Validates a credit card number using the standard Luhn checksum algorithm.
 * Accepts only canonical strings of 12-19 digits.
 */
export function isValidLuhn(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Parses and strictly validates a VaultRecord.
 * Enforces exact keys, version 1, and field constraints.
 * CVV or any arbitrary extra keys are strictly refused.
 */
export function parseVaultRecord(raw: unknown): VaultRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyError('INVALID_VAULT_RECORD');
  }

  if (!('version' in raw) || raw.version !== 1) {
    throw new PolicyError('INVALID_VAULT_RECORD');
  }

  if (!('kind' in raw)) {
    throw new PolicyError('INVALID_VAULT_RECORD');
  }

  const keys = Object.keys(raw);

  if (raw.kind === 'login') {
    if (keys.length !== 4) {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }
    for (const k of keys) {
      if (k !== 'version' && k !== 'kind' && k !== 'username' && k !== 'password') {
        throw new PolicyError('INVALID_VAULT_RECORD');
      }
    }
    if (!('username' in raw) || !('password' in raw)) {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }
    if (
      typeof raw.username !== 'string' ||
      raw.username.length === 0 ||
      raw.username.length > 320 ||
      raw.username.trim().length === 0
    ) {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }
    if (
      typeof raw.password !== 'string' ||
      raw.password.length === 0 ||
      raw.password.length > 4096
    ) {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }

    return Object.freeze({
      version: 1,
      kind: 'login',
      username: raw.username,
      password: raw.password,
    });
  }

  if (raw.kind === 'card') {
    if (keys.length !== 6) {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }
    for (const k of keys) {
      if (
        k !== 'version' &&
        k !== 'kind' &&
        k !== 'cardholder' &&
        k !== 'cardNumber' &&
        k !== 'expiryMonth' &&
        k !== 'expiryYear'
      ) {
        throw new PolicyError('INVALID_VAULT_RECORD');
      }
    }

    if (
      !('cardholder' in raw) ||
      !('cardNumber' in raw) ||
      !('expiryMonth' in raw) ||
      !('expiryYear' in raw)
    ) {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }

    if (
      typeof raw.cardholder !== 'string' ||
      raw.cardholder.length === 0 ||
      raw.cardholder.length > 200 ||
      raw.cardholder.trim().length === 0
    ) {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }

    if (typeof raw.cardNumber !== 'string') {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }
    const normalizedNumber = raw.cardNumber.replace(/[\s-]/g, '');
    if (!/^\d{12,19}$/.test(normalizedNumber) || !isValidLuhn(normalizedNumber)) {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }

    let monthStr: string;
    if (typeof raw.expiryMonth === 'string') {
      monthStr = raw.expiryMonth.trim();
    } else if (typeof raw.expiryMonth === 'number' && Number.isInteger(raw.expiryMonth)) {
      monthStr = String(raw.expiryMonth);
    } else {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }
    if (!/^\d{1,2}$/.test(monthStr)) {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }
    const monthNum = parseInt(monthStr, 10);
    if (monthNum < 1 || monthNum > 12) {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }
    const canonicalMonth = String(monthNum).padStart(2, '0');

    let yearStr: string;
    if (typeof raw.expiryYear === 'string') {
      yearStr = raw.expiryYear.trim();
    } else if (typeof raw.expiryYear === 'number' && Number.isInteger(raw.expiryYear)) {
      yearStr = String(raw.expiryYear);
    } else {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }
    if (!/^\d{4}$/.test(yearStr)) {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }
    const yearNum = parseInt(yearStr, 10);
    if (yearNum < 2000 || yearNum > 2099) {
      throw new PolicyError('INVALID_VAULT_RECORD');
    }

    return Object.freeze({
      version: 1,
      kind: 'card',
      cardholder: raw.cardholder.trim(),
      cardNumber: normalizedNumber,
      expiryMonth: canonicalMonth,
      expiryYear: yearStr,
    });
  }

  throw new PolicyError('INVALID_VAULT_RECORD');
}

/**
 * Serializes a validated VaultRecord to a JSON string.
 */
export function serializeVaultRecord(record: VaultRecord): string {
  const validated = parseVaultRecord(record);
  return JSON.stringify(validated);
}

/**
 * Decodes a vault record from a decrypted secret string.
 *
 * Legacy record compatibility:
 * Prior native password records stored raw password strings directly in the vault payload
 * without a structured JSON envelope. When a legacy record is retrieved for a 'login' kind,
 * it is adapted with `username = recordId` and `password = secret`.
 * No silent migration occurs: legacy records are not rewritten to JSON at rest on read.
 *
 * If the secret starts with '{' or '[', it is treated as structured JSON.
 * Any malformed JSON or kind mismatch fails closed and NEVER falls back to raw password.
 */
export function decodeVaultRecord(secret: string, kind: VaultKind, recordId: string): VaultRecord {
  if (typeof secret !== 'string' || !secret) {
    throw new PolicyError('INVALID_VAULT_RECORD');
  }
  if (kind !== 'login' && kind !== 'card') {
    throw new PolicyError('INVALID_VAULT_RECORD');
  }

  const trimmed = secret.replace(/^\uFEFF/, '').trim();
  const isJsonLooking = trimmed.startsWith('{') || trimmed.startsWith('[');

  if (isJsonLooking) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new PolicyError('VAULT_RECORD_CORRUPT');
    }
    const record = parseVaultRecord(parsed);
    if (record.kind !== kind) {
      throw new PolicyError('VAULT_RECORD_KIND_MISMATCH');
    }
    return record;
  }

  // Raw secret legacy path: ONLY supported for requested 'login'
  if (kind !== 'login') {
    throw new PolicyError('VAULT_RECORD_KIND_MISMATCH');
  }

  if (!recordId || typeof recordId !== 'string' || recordId.trim().length === 0 || recordId.length > 320) {
    throw new PolicyError('INVALID_RECORD_ID');
  }
  if (secret.length > 4096) {
    throw new PolicyError('INVALID_VAULT_RECORD');
  }

  return Object.freeze({
    version: 1,
    kind: 'login',
    username: recordId,
    password: secret,
  });
}
