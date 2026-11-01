import { describe, expect, test } from 'bun:test';
import { decodeVaultRecord, isValidLuhn, parseVaultRecord, serializeVaultRecord } from '../src/vault-record';
import type { CardRecord, LoginRecord } from '../src/autofill-contract';

describe('isValidLuhn', () => {
  test('accepts valid 16-digit card numbers', () => {
    expect(isValidLuhn('4532015000000007')).toBe(true);
  });

  test('accepts valid 15-digit card numbers (Amex)', () => {
    expect(isValidLuhn('378282246310005')).toBe(true);
  });

  test('accepts valid 12-digit card number', () => {
    expect(isValidLuhn('499273987168')).toBe(true);
  });

  test('accepts valid 19-digit card number', () => {
    // 19 digits valid Luhn
    expect(isValidLuhn('4000000000000000006')).toBe(true);
  });

  test('rejects numbers with invalid Luhn checksum', () => {
    expect(isValidLuhn('4532015000000008')).toBe(false);
    expect(isValidLuhn('378282246310006')).toBe(false);
  });

  test('rejects card numbers shorter than 12 digits', () => {
    expect(isValidLuhn('45320150000')).toBe(false);
    expect(isValidLuhn('')).toBe(false);
  });

  test('rejects card numbers longer than 19 digits', () => {
    expect(isValidLuhn('45320150000000000007')).toBe(false);
  });

  test('rejects non-digit characters', () => {
    expect(isValidLuhn('4532-0150-0000-0007')).toBe(false);
    expect(isValidLuhn('4532 0150 0000 0007')).toBe(false);
    expect(isValidLuhn('453201500000000a')).toBe(false);
  });
});

describe('parseVaultRecord - login records', () => {
  test('accepts a valid login record', () => {
    const raw = {
      version: 1,
      kind: 'login',
      username: 'alice@example.test',
      password: 'correct-horse-battery-staple',
    };
    const record = parseVaultRecord(raw);
    expect(record).toEqual({
      version: 1,
      kind: 'login',
      username: 'alice@example.test',
      password: 'correct-horse-battery-staple',
    });
  });

  test('rejects login record with extra properties', () => {
    const raw = {
      version: 1,
      kind: 'login',
      username: 'alice',
      password: 'pwd',
      extra: 'unexpected',
    };
    expect(() => parseVaultRecord(raw)).toThrow('INVALID_VAULT_RECORD');
  });

  test('rejects login record with empty or whitespace-only username', () => {
    expect(() => parseVaultRecord({ version: 1, kind: 'login', username: '', password: 'pwd' })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ version: 1, kind: 'login', username: '   ', password: 'pwd' })).toThrow('INVALID_VAULT_RECORD');
  });

  test('rejects login record with username exceeding 320 characters', () => {
    const longUsername = 'a'.repeat(321);
    expect(() => parseVaultRecord({ version: 1, kind: 'login', username: longUsername, password: 'pwd' })).toThrow('INVALID_VAULT_RECORD');
  });

  test('accepts login record with max-length 320 username', () => {
    const maxUsername = 'a'.repeat(320);
    const rec = parseVaultRecord({ version: 1, kind: 'login', username: maxUsername, password: 'pwd' }) as LoginRecord;
    expect(rec.username).toBe(maxUsername);
  });

  test('rejects login record with empty password', () => {
    expect(() => parseVaultRecord({ version: 1, kind: 'login', username: 'alice', password: '' })).toThrow('INVALID_VAULT_RECORD');
  });

  test('rejects login record with password exceeding 4096 characters', () => {
    const longPassword = 'p'.repeat(4097);
    expect(() => parseVaultRecord({ version: 1, kind: 'login', username: 'alice', password: longPassword })).toThrow('INVALID_VAULT_RECORD');
  });

  test('accepts login record with max-length 4096 password', () => {
    const maxPassword = 'p'.repeat(4096);
    const rec = parseVaultRecord({ version: 1, kind: 'login', username: 'alice', password: maxPassword }) as LoginRecord;
    expect(rec.password).toBe(maxPassword);
  });
});

describe('parseVaultRecord - card records', () => {
  const validCard = () => ({
    version: 1,
    kind: 'card',
    cardholder: 'Jane Doe',
    cardNumber: '4532 0150 0000 0007',
    expiryMonth: '12',
    expiryYear: '2028',
  });

  test('accepts valid card record and normalizes card number spaces and formatting', () => {
    const record = parseVaultRecord(validCard()) as CardRecord;
    expect(record).toEqual({
      version: 1,
      kind: 'card',
      cardholder: 'Jane Doe',
      cardNumber: '4532015000000007',
      expiryMonth: '12',
      expiryYear: '2028',
    });
  });

  test('accepts hyphens in card number and normalizes to digits', () => {
    const raw = { ...validCard(), cardNumber: '4532-0150-0000-0007' };
    const record = parseVaultRecord(raw) as CardRecord;
    expect(record.cardNumber).toBe('4532015000000007');
  });

  test('normalizes single digit month 1..9 to two digits 01..09', () => {
    const rawString = { ...validCard(), expiryMonth: '5' };
    expect((parseVaultRecord(rawString) as CardRecord).expiryMonth).toBe('05');

    const rawNumber = { ...validCard(), expiryMonth: 5 };
    expect((parseVaultRecord(rawNumber) as CardRecord).expiryMonth).toBe('05');
  });

  test('accepts four-digit expiry year as number or string', () => {
    const rawString = { ...validCard(), expiryYear: '2026' };
    expect((parseVaultRecord(rawString) as CardRecord).expiryYear).toBe('2026');

    const rawNumber = { ...validCard(), expiryYear: 2026 };
    expect((parseVaultRecord(rawNumber) as CardRecord).expiryYear).toBe('2026');
  });

  test('strictly refuses CVV / CVC / securityCode in card records', () => {
    expect(() => parseVaultRecord({ ...validCard(), cvv: '123' })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ ...validCard(), cvc: '123' })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ ...validCard(), securityCode: '123' })).toThrow('INVALID_VAULT_RECORD');
  });

  test('strictly refuses arbitrary extra properties in card records', () => {
    expect(() => parseVaultRecord({ ...validCard(), note: 'personal card' })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ ...validCard(), bank: 'TestBank' })).toThrow('INVALID_VAULT_RECORD');
  });

  test('rejects empty or whitespace-only cardholder', () => {
    expect(() => parseVaultRecord({ ...validCard(), cardholder: '' })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ ...validCard(), cardholder: '   ' })).toThrow('INVALID_VAULT_RECORD');
  });

  test('rejects cardholder exceeding 200 characters', () => {
    const longCardholder = 'c'.repeat(201);
    expect(() => parseVaultRecord({ ...validCard(), cardholder: longCardholder })).toThrow('INVALID_VAULT_RECORD');
  });

  test('rejects card number failing Luhn check', () => {
    expect(() => parseVaultRecord({ ...validCard(), cardNumber: '4532 0150 0000 0008' })).toThrow('INVALID_VAULT_RECORD');
  });

  test('rejects card number with invalid length', () => {
    expect(() => parseVaultRecord({ ...validCard(), cardNumber: '45320150000' })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ ...validCard(), cardNumber: '45320150000000000007' })).toThrow('INVALID_VAULT_RECORD');
  });

  test('rejects invalid expiryMonth values', () => {
    expect(() => parseVaultRecord({ ...validCard(), expiryMonth: '00' })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ ...validCard(), expiryMonth: '13' })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ ...validCard(), expiryMonth: 'abc' })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ ...validCard(), expiryMonth: 0 })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ ...validCard(), expiryMonth: 13 })).toThrow('INVALID_VAULT_RECORD');
  });

  test('rejects expiryYear outside 2000..2099', () => {
    expect(() => parseVaultRecord({ ...validCard(), expiryYear: '1999' })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ ...validCard(), expiryYear: '2100' })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ ...validCard(), expiryYear: 1999 })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ ...validCard(), expiryYear: 2100 })).toThrow('INVALID_VAULT_RECORD');
  });

  test('rejects two-digit expiry year (requires four-digit 2000..2099)', () => {
    expect(() => parseVaultRecord({ ...validCard(), expiryYear: '28' })).toThrow('INVALID_VAULT_RECORD');
  });

  test('rejects non-object raw inputs', () => {
    expect(() => parseVaultRecord(null)).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord(undefined)).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord('string')).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord(123)).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord([])).toThrow('INVALID_VAULT_RECORD');
  });

  test('rejects version other than 1', () => {
    expect(() => parseVaultRecord({ ...validCard(), version: 2 })).toThrow('INVALID_VAULT_RECORD');
    expect(() => parseVaultRecord({ ...validCard(), version: 0 })).toThrow('INVALID_VAULT_RECORD');
  });

  test('rejects unsupported kind', () => {
    expect(() => parseVaultRecord({ ...validCard(), kind: 'passkey' })).toThrow('INVALID_VAULT_RECORD');
  });
});

describe('decodeVaultRecord', () => {
  test('decodes valid typed JSON login record', () => {
    const json = JSON.stringify({
      version: 1,
      kind: 'login',
      username: 'alice',
      password: 'password123',
    });
    const record = decodeVaultRecord(json, 'login', 'record-1');
    expect(record).toEqual({
      version: 1,
      kind: 'login',
      username: 'alice',
      password: 'password123',
    });
  });

  test('decodes valid typed JSON card record', () => {
    const json = JSON.stringify({
      version: 1,
      kind: 'card',
      cardholder: 'Bob Smith',
      cardNumber: '4532015000000007',
      expiryMonth: '05',
      expiryYear: '2027',
    });
    const record = decodeVaultRecord(json, 'card', 'record-card');
    expect(record).toEqual({
      version: 1,
      kind: 'card',
      cardholder: 'Bob Smith',
      cardNumber: '4532015000000007',
      expiryMonth: '05',
      expiryYear: '2027',
    });
  });

  test('supports legacy raw native password records for requested login (username=recordId)', () => {
    const rawSecret = 'SuperSecretPassword!';
    const record = decodeVaultRecord(rawSecret, 'login', 'tomsmith');
    expect(record).toEqual({
      version: 1,
      kind: 'login',
      username: 'tomsmith',
      password: 'SuperSecretPassword!',
    });
  });

  test('refuses legacy raw native password when requested kind is card', () => {
    const rawSecret = 'SuperSecretPassword!';
    expect(() => decodeVaultRecord(rawSecret, 'card', 'tomsmith')).toThrow('VAULT_RECORD_KIND_MISMATCH');
  });

  test('refuses JSON-looking malformed string and does NOT fall back to raw password', () => {
    const malformedJson = '{invalid json syntax';
    expect(() => decodeVaultRecord(malformedJson, 'login', 'tomsmith')).toThrow('VAULT_RECORD_CORRUPT');
  });

  test('refuses JSON-looking array and does NOT fall back to raw password', () => {
    const jsonArray = '[1, 2, 3]';
    expect(() => decodeVaultRecord(jsonArray, 'login', 'tomsmith')).toThrow('INVALID_VAULT_RECORD');
  });

  test('refuses JSON record with wrong kind without falling back to raw password', () => {
    const cardJson = JSON.stringify({
      version: 1,
      kind: 'card',
      cardholder: 'Bob',
      cardNumber: '4532015000000007',
      expiryMonth: '05',
      expiryYear: '2027',
    });
    // Requesting login for a stored card record must fail
    expect(() => decodeVaultRecord(cardJson, 'login', 'record-card')).toThrow('VAULT_RECORD_KIND_MISMATCH');

    const loginJson = JSON.stringify({
      version: 1,
      kind: 'login',
      username: 'alice',
      password: 'pwd',
    });
    // Requesting card for a stored login record must fail
    expect(() => decodeVaultRecord(loginJson, 'card', 'record-login')).toThrow('VAULT_RECORD_KIND_MISMATCH');
  });

  test('refuses JSON record with schema violations without falling back to raw password', () => {
    const badLogin = JSON.stringify({
      version: 1,
      kind: 'login',
      username: '',
      password: 'pwd',
    });
    expect(() => decodeVaultRecord(badLogin, 'login', 'record-1')).toThrow('INVALID_VAULT_RECORD');

    const cardWithCvv = JSON.stringify({
      version: 1,
      kind: 'card',
      cardholder: 'Bob',
      cardNumber: '4532015000000007',
      expiryMonth: '05',
      expiryYear: '2027',
      cvv: '123',
    });
    expect(() => decodeVaultRecord(cardWithCvv, 'card', 'record-1')).toThrow('INVALID_VAULT_RECORD');
  });

  test('refuses empty secret', () => {
    expect(() => decodeVaultRecord('', 'login', 'record-1')).toThrow('INVALID_VAULT_RECORD');
  });

  test('refuses invalid recordId for legacy login fallback', () => {
    expect(() => decodeVaultRecord('rawSecret', 'login', '')).toThrow('INVALID_RECORD_ID');
    expect(() => decodeVaultRecord('rawSecret', 'login', '   ')).toThrow('INVALID_RECORD_ID');
    expect(() => decodeVaultRecord('rawSecret', 'login', 'x'.repeat(321))).toThrow('INVALID_RECORD_ID');
  });
});

describe('serializeVaultRecord', () => {
  test('serializes valid login record and parses back identically', () => {
    const login: LoginRecord = {
      version: 1,
      kind: 'login',
      username: 'alice',
      password: 'pwd',
    };
    const serialized = serializeVaultRecord(login);
    expect(parseVaultRecord(JSON.parse(serialized))).toEqual(login);
  });

  test('serializes valid card record with canonicalization', () => {
    const card: CardRecord = {
      version: 1,
      kind: 'card',
      cardholder: 'Alice',
      cardNumber: '4532 0150 0000 0007',
      expiryMonth: '5',
      expiryYear: '2028',
    };
    const serialized = serializeVaultRecord(card);
    const parsed = parseVaultRecord(JSON.parse(serialized)) as CardRecord;
    expect(parsed.cardNumber).toBe('4532015000000007');
    expect(parsed.expiryMonth).toBe('05');
  });

  test('refuses serialization of invalid record (e.g. CVV present)', () => {
    const badCard = {
      version: 1,
      kind: 'card',
      cardholder: 'Alice',
      cardNumber: '4532015000000007',
      expiryMonth: '05',
      expiryYear: '2028',
      cvv: '123',
    };
    expect(() => serializeVaultRecord(badCard as unknown as CardRecord)).toThrow('INVALID_VAULT_RECORD');
  });
});
