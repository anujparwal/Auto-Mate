import { randomUUID } from 'node:crypto';
import { informationKindsCompatible, type InformationField, type InformationMapping, type InformationPlanInput, type InformationVariable, type InformationVariableInput, type InformationVault } from './information-contract';

export interface InformationPlanningClient {
  readonly mode: 'reviewed' | 'local' | 'cloud';
  readonly model?: string;
  plan(input: InformationPlanInput, signal?: AbortSignal): Promise<readonly InformationMapping[]>;
}
export interface InformationOwnerState {
  readonly mode: InformationPlanningClient['mode'];
  readonly model?: string;
  readonly catalogLoaded: boolean;
  readonly catalogStale: boolean;
  readonly planned: boolean;
  readonly variables: readonly InformationVariable[];
  readonly mappings: readonly { fieldId: string; variableId: string | null; provided: boolean; skipped: boolean; choices: readonly string[] }[];
  readonly request?: { id: string; field: InformationField };
}

/** Owner/host-only state. Values are never included in snapshots or planning input. */
export class InformationFlow {
  #vault: InformationVault;
  #planner: InformationPlanningClient;
  #assertActive: () => void;
  #epoch = 0;
  #origin = '';
  #fields: readonly InformationField[] = [];
  #variables: readonly InformationVariable[] = [];
  #catalogLoaded = false;
  #catalogStale = false;
  #planned = false;
  #mappings = new Map<string, string | null>();
  #values = new Map<string, string>();
  #skipped = new Set<string>();
  #request?: { id: string; field: InformationField };
  #planning?: AbortController;
  #oneOffAuthenticated = false;

  constructor(vault: InformationVault, planner: InformationPlanningClient, assertActive: () => void) {
    this.#vault = vault; this.#planner = planner; this.#assertActive = assertActive;
  }
  get state(): InformationOwnerState {
    return {
      mode: this.#planner.mode, model: this.#planner.model,
      catalogLoaded: this.#catalogLoaded, catalogStale: this.#catalogStale, planned: this.#planned,
      variables: this.#variables,
      mappings: this.#fields.map(field => ({
        fieldId: field.id,
        variableId: this.#mappings.get(field.id) ?? null,
        provided: this.#values.has(field.id),
        skipped: this.#skipped.has(field.id),
        choices: this.#variables
          .filter(variable => variable.available && informationKindsCompatible(field.kind, variable.kind))
          .map(variable => variable.id),
      })),
      request: this.#request,
    };
  }
  clear(): void {
    this.#epoch++;
    this.#planning?.abort(); this.#planning = undefined;
    this.#vault.clear();
    this.#origin = ''; this.#fields = []; this.#variables = [];
    this.#catalogLoaded = false; this.#catalogStale = false; this.#planned = false;
    this.#mappings.clear(); this.#values.clear(); this.#skipped.clear(); this.#request = undefined;
    this.#oneOffAuthenticated = false;
  }
  attach(origin: string, fields: readonly InformationField[]): void {
    this.clear(); this.#origin = origin; this.#fields = fields;
  }
  #check(epoch: number): void {
    if (epoch !== this.#epoch || !this.#origin) throw new Error('TASK_STOPPED');
    this.#assertActive();
  }
  #field(id: string): InformationField {
    const field = this.#fields.find(candidate => candidate.id === id);
    if (!field) throw new Error('INVALID_OWNER_COMMAND');
    return field;
  }
  async loadCatalog(): Promise<void> {
    const epoch = this.#epoch; this.#check(epoch);
    const variables = await this.#vault.catalog(this.#origin);
    if (epoch !== this.#epoch) { this.#vault.clear(); throw new Error('TASK_STOPPED'); }
    this.#check(epoch);
    this.#variables = variables.map(variable => Object.freeze({ id: variable.id, name: variable.name,
      description: variable.description, kind: variable.kind, scope: variable.scope, available: variable.available }));
    this.#catalogLoaded = true; this.#catalogStale = false;
    this.#planned = false; this.#mappings.clear(); this.#values.clear(); this.#skipped.clear(); this.#request = undefined;
    this.#oneOffAuthenticated = false;
  }
  async plan(shareMetadata: boolean): Promise<void> {
    const epoch = this.#epoch; this.#check(epoch);
    if (!this.#catalogLoaded || this.#catalogStale || this.#request) throw new Error('INFORMATION_CATALOG_REQUIRED');
    if (this.#planner.mode !== 'reviewed' && !shareMetadata) throw new Error('INFORMATION_CONSENT_REQUIRED');
    const controller = new AbortController(); this.#planning = controller;
    try {
      const mappings = await this.#planner.plan({ fields: this.#fields, variables: this.#variables }, controller.signal);
      this.#check(epoch);
      if (controller.signal.aborted || mappings.length !== this.#fields.length || new Set(mappings.map(mapping => mapping.fieldId)).size !== this.#fields.length) throw new Error('PLANNER_INVALID_RESPONSE');
      for (const mapping of mappings) {
        const field = this.#fields.find(candidate => candidate.id === mapping.fieldId);
        const variable = this.#variables.find(candidate => candidate.id === mapping.variableId);
        if (!field || mapping.variableId !== null && (!variable?.available || !informationKindsCompatible(field.kind, variable.kind))) throw new Error('PLANNER_INVALID_RESPONSE');
      }
      this.#mappings = new Map(mappings.map(mapping => [mapping.fieldId, mapping.variableId]));
      this.#values.clear(); this.#skipped.clear(); this.#oneOffAuthenticated = false;
      this.#planned = true; this.#nextRequest();
    } finally { if (this.#planning === controller) this.#planning = undefined; }
  }
  #nextRequest(): void {
    const field = this.#fields.find(candidate => this.#mappings.get(candidate.id) === null && !this.#values.has(candidate.id) && !this.#skipped.has(candidate.id));
    this.#request = field ? { id: randomUUID(), field } : undefined;
  }
  request(id: string): void {
    this.#assertActive();
    if (!this.#planned || this.#request) throw new Error('INVALID_OWNER_COMMAND');
    const field = this.#field(id);
    this.#mappings.set(id, null); this.#values.delete(id); this.#skipped.delete(id);
    this.#request = { id: randomUUID(), field };
  }
  choose(fieldId: string, variableId: string): void {
    this.#assertActive();
    if (!this.#planned || this.#request) throw new Error('INVALID_OWNER_COMMAND');
    const field = this.#field(fieldId);
    const variable = this.#variables.find(candidate => candidate.id === variableId);
    if (!variable?.available || !informationKindsCompatible(field.kind, variable.kind)) throw new Error('INVALID_OWNER_COMMAND');
    this.#mappings.set(fieldId, variableId); this.#values.delete(fieldId); this.#skipped.delete(fieldId);
  }
  async provide(id: string, value: string, save: { name: string; description: string; scope: 'profile' | 'site' } | null): Promise<void> {
    const epoch = this.#epoch; this.#check(epoch);
    const request = this.#request;
    if (!request || request.id !== id || typeof value !== 'string' || !value.length || value.length > 4096) throw new Error('INVALID_OWNER_COMMAND');
    if (save) {
      await this.#vault.save({ ...save, value, kind: request.field.kind === 'select' ? 'text' : request.field.kind, origin: this.#origin });
      this.#check(epoch);
      this.#catalogStale = true;
    }
    this.#check(epoch);
    this.#values.set(request.field.id, value);
    this.#skipped.delete(request.field.id);
    this.#nextRequest();
  }
  skip(id: string): void {
    this.#assertActive();
    if (!this.#request || this.#request.id !== id) throw new Error('INVALID_OWNER_COMMAND');
    this.#skipped.add(this.#request.field.id); this.#nextRequest();
  }
  ready(id: string): boolean {
    return this.#planned && !this.#request && (this.#values.has(id) || typeof this.#mappings.get(id) === 'string');
  }
  async value(id: string): Promise<string> {
    const epoch = this.#epoch; this.#check(epoch);
    if (!this.ready(id)) throw new Error('INVALID_OWNER_COMMAND');
    if (this.#values.has(id)) {
      if (!this.#oneOffAuthenticated) {
        await this.#vault.authenticate(this.#origin); this.#check(epoch);
        this.#oneOffAuthenticated = true;
      }
      const value = this.#values.get(id);
      if (value === undefined) throw new Error('TASK_STOPPED');
      return value;
    }
    const variableId = this.#mappings.get(id);
    if (!variableId) throw new Error('INVALID_OWNER_COMMAND');
    const value = await this.#vault.read(variableId, this.#origin);
    this.#check(epoch); return value;
  }
  forgetEnteredValues(): void { this.#values.clear(); this.#oneOffAuthenticated = false; }
  async save(input: InformationVariableInput): Promise<void> {
    this.#assertActive();
    const epoch = this.#epoch;
    await this.#vault.save(input);
    if (epoch !== this.#epoch) throw new Error('TASK_STOPPED');
    this.#assertActive();
    // A new catalog must be reviewed before another model request; do not send it automatically.
    this.#catalogStale = true;
  }
}
