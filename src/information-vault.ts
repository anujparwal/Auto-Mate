import { randomUUID } from 'node:crypto';
import { PolicyError } from './policy';
import type {
  InformationScope,
  InformationVault,
  InformationVariable,
  InformationVariableInput,
  InformationVariableKind,
} from './information-contract';
import {
  invokeNativeBroker,
  validateOriginAndMode,
  type WindowsPasswordStoreOptions,
} from './windows-vault';

export const PROFILE_ORIGIN_NORMAL = 'https://profile.auto-mate.invalid';
export const PROFILE_ORIGIN_SYNTHETIC = 'https://profile.auto-mate.test';
const VALID_INPUT_KINDS: Record<string, true> = {
  text: true,
  email: true,
  tel: true,
  url: true,
  username: true,
  password: true,
  date: true,
  number: true,
};

const VALID_VARIABLE_KINDS: Record<string, true> = {
  text: true,
  email: true,
  tel: true,
  url: true,
  username: true,
  password: true,
  date: true,
  number: true,
  cardholder: true,
  cardNumber: true,
  expiryMonth: true,
  expiryYear: true,
};

interface VariableBinding {
  readonly id: string;
  readonly nativeRecordId: string;
  readonly sourceOrigin: string;
  readonly fieldKey?: string;
  readonly name: string;
  readonly description: string;
  readonly kind: InformationVariableKind;
  readonly scope: InformationScope;
  readonly targetOrigin: string;
  readonly available: boolean;
}

/**
 * Windows Information Vault implementing InformationVault.
 * Provides model visibility of allowlisted metadata (names/descriptions) across all origins,
 * while values remain DPAPI-encrypted at rest and are returned strictly to the trusted host
 * executor via authenticated per-origin reads.
 *
 * Shared profiles are stored in the canonical profile namespace (.invalid in normal mode,
 * .test in synthetic mode) and are restricted to non-credential kinds. Site variables and
 * credentials (username/password/card records) remain strictly site-bound.
 */
export class WindowsInformationVault implements InformationVault {
  readonly #vaultPath?: string;
  readonly #mode: 'windows-hello' | 'synthetic';
  readonly #bindings = new Map<string, VariableBinding>();

  constructor(options: WindowsPasswordStoreOptions = {}) {
    this.#vaultPath = options.vaultPath;
    this.#mode = options.mode ?? 'windows-hello';
    if (this.#mode !== 'windows-hello' && this.#mode !== 'synthetic') {
      throw new PolicyError('INVALID_VAULT_MODE');
    }
  }

  /**
   * Returns allowlisted variable metadata visible to the model.
   * Generates opaque random IDs bound to internal private records.
   * Secrets, values, and ciphertexts are never included in catalog projections.
   */
  async catalog(origin: string): Promise<readonly InformationVariable[]> {
    const canonicalTargetOrigin = validateOriginAndMode(origin, this.#mode, this.#vaultPath);

    const result = await invokeNativeBroker(
      { mode: this.#mode, vaultPath: this.#vaultPath },
      { action: 'catalog' },
    );

    if (result.action !== 'catalog' || !Array.isArray(result.variables)) {
      throw new PolicyError('VAULT_PROTOCOL_FAILED');
    }

    const allowlisted: InformationVariable[] = [];

    for (const raw of result.variables) {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        typeof (raw as Record<string, unknown>).recordId !== 'string' ||
        typeof (raw as Record<string, unknown>).origin !== 'string' ||
        typeof (raw as Record<string, unknown>).name !== 'string' ||
        typeof (raw as Record<string, unknown>).description !== 'string' ||
        typeof (raw as Record<string, unknown>).kind !== 'string' ||
        typeof (raw as Record<string, unknown>).scope !== 'string'
      ) {
        throw new PolicyError('VAULT_PROTOCOL_FAILED');
      }

      const item = raw as {
        recordId: string;
        origin: string;
        name: string;
        description: string;
        kind: string;
        scope: string;
        fieldKey?: string;
      };

      if (!VALID_VARIABLE_KINDS[item.kind]) {
        throw new PolicyError('VAULT_PROTOCOL_FAILED');
      }

      if (item.scope !== 'profile' && item.scope !== 'site') {
        throw new PolicyError('VAULT_PROTOCOL_FAILED');
      }

      const kind = item.kind as InformationVariableKind;
      const scope = item.scope as InformationScope;

      const isProfile = scope === 'profile';
      const available = isProfile || item.origin === canonicalTargetOrigin;

      const opaqueId = randomUUID();

      this.#bindings.set(opaqueId, {
        id: opaqueId,
        nativeRecordId: item.recordId,
        sourceOrigin: item.origin,
        fieldKey: typeof item.fieldKey === 'string' && item.fieldKey ? item.fieldKey : undefined,
        name: item.name,
        description: item.description,
        kind,
        scope,
        targetOrigin: canonicalTargetOrigin,
        available,
      });

      allowlisted.push(
        Object.freeze({
          id: opaqueId,
          name: item.name,
          description: item.description,
          kind,
          scope,
          available,
        }),
      );
    }

    return Object.freeze(allowlisted);
  }

  /**
   * Saves a named variable.
   * Validates nonempty bounded name (max 80), description (max 500), value (max 4096),
   * known kinds and scope. Shared profile variables are stored in the canonical profile
   * namespace and cannot be credentials (username/password).
   * Returns no values.
   */
  async save(input: InformationVariableInput): Promise<void> {
    if (!input || typeof input !== 'object') {
      throw new PolicyError('INVALID_VARIABLE_INPUT');
    }

    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) {
      throw new PolicyError('INVALID_VARIABLE_NAME');
    }

    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description || description.length > 500) {
      throw new PolicyError('INVALID_VARIABLE_DESCRIPTION');
    }

    const value = typeof input.value === 'string' ? input.value : '';
    if (!value || value.length > 4096) {
      throw new PolicyError('INVALID_VARIABLE_VALUE');
    }

    if (!VALID_INPUT_KINDS[input.kind]) {
      throw new PolicyError('INVALID_VARIABLE_KIND');
    }

    if (input.scope !== 'profile' && input.scope !== 'site') {
      throw new PolicyError('INVALID_VARIABLE_SCOPE');
    }

    if (input.scope === 'profile') {
      if (input.kind === 'username' || input.kind === 'password') {
        throw new PolicyError('CREDENTIAL_CANNOT_BE_PROFILE');
      }
    }

    if (typeof input.origin !== 'string' || !input.origin) {
      throw new PolicyError('INVALID_ORIGIN');
    }

    const targetOrigin = validateOriginAndMode(input.origin, this.#mode, this.#vaultPath);
    const profileOrigin = this.#mode === 'synthetic' ? PROFILE_ORIGIN_SYNTHETIC : PROFILE_ORIGIN_NORMAL;

    let storageOrigin: string;
    if (input.scope === 'profile') {
      storageOrigin = profileOrigin;
    } else {
      if (targetOrigin === profileOrigin) {
        throw new PolicyError('INVALID_ORIGIN');
      }
      storageOrigin = targetOrigin;
    }

    const result = await invokeNativeBroker(
      { mode: this.#mode, vaultPath: this.#vaultPath },
      {
        action: 'save-variable',
        origin: storageOrigin,
        targetOrigin,
        recordId: 'var:' + name,
        name,
        description,
        value,
        kind: input.kind,
        scope: input.scope,
      },
    );

    if (result.action !== 'save-variable') {
      throw new PolicyError('VAULT_PROTOCOL_FAILED');
    }
  }

  /**
   * Resolves the secret value of an opaque variable ID.
   * Resolves only known current bindings, verifying availability, compatible kind,
   * and scope before calling the authenticated native broker.
   * Returns value strictly to the trusted host executor.
   */
  async read(id: string, origin: string): Promise<string> {
    const canonicalTargetOrigin = validateOriginAndMode(origin, this.#mode, this.#vaultPath);

    if (!id || typeof id !== 'string') {
      throw new PolicyError('INVALID_VARIABLE_ID');
    }

    const binding = this.#bindings.get(id);
    if (!binding) {
      throw new PolicyError('UNKNOWN_VARIABLE');
    }

    if (!binding.available) {
      throw new PolicyError('VARIABLE_NOT_AVAILABLE');
    }

    if (binding.targetOrigin !== canonicalTargetOrigin) {
      throw new PolicyError('CROSS_ORIGIN_DENIED');
    }

    if (binding.scope === 'site' && binding.sourceOrigin !== canonicalTargetOrigin) {
      throw new PolicyError('CROSS_ORIGIN_DENIED');
    }

    const result = await invokeNativeBroker(
      { mode: this.#mode, vaultPath: this.#vaultPath },
      {
        action: 'resolve-variable',
        origin: canonicalTargetOrigin,
        sourceOrigin: binding.sourceOrigin,
        recordId: binding.nativeRecordId,
        fieldKey: binding.fieldKey,
        expectedKind: binding.kind,
        expectedScope: binding.scope,
        expectedName: binding.name,
        expectedDescription: binding.description,
      },
    );

    if (result.action !== 'resolve-variable' || typeof result.value !== 'string') {
      throw new PolicyError('VAULT_PROTOCOL_FAILED');
    }
    if (this.#bindings.get(id) !== binding) throw new PolicyError('UNKNOWN_VARIABLE');

    return result.value;
  }

  /**
   * Authenticates owner consent via Windows Hello (or synthetic checks)
   * for one-off entered form data on the target origin.
   * Returns no values.
   */
  async authenticate(origin: string): Promise<void> {
    const canonicalTargetOrigin = validateOriginAndMode(origin, this.#mode, this.#vaultPath);

    const result = await invokeNativeBroker(
      { mode: this.#mode, vaultPath: this.#vaultPath },
      {
        action: 'authenticate',
        origin: canonicalTargetOrigin,
      },
    );

    if (result.action !== 'authenticate' || result.origin !== canonicalTargetOrigin) {
      throw new PolicyError('VAULT_PROTOCOL_FAILED');
    }
  }

  /**
   * Invalidates all current opaque variable ID bindings.
   * Any subsequent read calls using previously issued IDs will be refused.
   */
  clear(): void {
    this.#bindings.clear();
  }
}
