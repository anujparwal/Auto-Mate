export type InformationFieldKind = 'text' | 'email' | 'tel' | 'url' | 'username' | 'password' | 'select' | 'date' | 'number';
export type InformationVariableKind = Exclude<InformationFieldKind, 'select'> | 'cardholder' | 'cardNumber' | 'expiryMonth' | 'expiryYear';
export type InformationScope = 'profile' | 'site';

/** Only this allowlisted metadata projection may be given to a model. Names/descriptions can themselves be personal. */
export interface InformationVariable {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: InformationVariableKind;
  readonly scope: InformationScope;
  readonly available: boolean;
}
export interface InformationField {
  readonly id: string;
  readonly label: string;
  readonly kind: InformationFieldKind;
  readonly required: boolean;
  readonly options?: readonly string[];
}
export interface InformationVariableInput {
  readonly name: string;
  readonly description: string;
  readonly value: string;
  readonly kind: Exclude<InformationFieldKind, 'select'>;
  readonly scope: InformationScope;
  readonly origin: string;
}
/** Native authenticated operations, not model tools. read returns only to the trusted executor. */
export interface InformationVault {
  catalog(origin: string): Promise<readonly InformationVariable[]>;
  save(input: InformationVariableInput): Promise<void>;
  read(id: string, origin: string): Promise<string>;
  authenticate(origin: string): Promise<void>;
  clear(): void;
}
export interface InformationMapping {
  readonly fieldId: string;
  /** null means ask the owner; a model may never supply the value itself. */
  readonly variableId: string | null;
}
export interface InformationPlanInput {
  readonly fields: readonly InformationField[];
  readonly variables: readonly InformationVariable[];
}
export function informationKindsCompatible(field: InformationFieldKind, variable: InformationVariableKind): boolean {
  if (field === 'password') return variable === 'password';
  if (field === 'username') return variable === 'username' || variable === 'email';
  if (field === 'text' || field === 'select') return variable === 'text';
  return field === variable;
}
