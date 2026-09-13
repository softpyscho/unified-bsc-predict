/** Declarative strategy parameters: drives both validation and the dashboard's config forms. */

export type ParamType = 'number' | 'integer' | 'boolean' | 'enum';
export type ParamValue = number | boolean | string;
export type ParamValues = Record<string, ParamValue>;

export interface ParamSpec {
  key: string;
  label: string;
  type: ParamType;
  description: string;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function validateParams<P extends ParamValues>(
  specs: readonly ParamSpec[],
  defaults: P,
  input: unknown,
): ValidationResult<P> {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, errors: ['params must be an object'] };
  const errors: string[] = [];
  const out: ParamValues = { ...defaults };
  const known = new Set(specs.map((s) => s.key));
  for (const key of Object.keys(raw)) if (!known.has(key)) errors.push(`unknown param "${key}"`);

  for (const spec of specs) {
    const value = raw[spec.key];
    if (value === undefined) continue;
    const err = checkValue(spec, value);
    if (err) errors.push(`${spec.key}: ${err}`);
    else out[spec.key] = value as ParamValue;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out as P };
}

function checkValue(spec: ParamSpec, value: unknown): string | null {
  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'enum':
      return typeof value === 'string' && (spec.options ?? []).includes(value)
        ? null
        : `must be one of ${(spec.options ?? []).join(', ')}`;
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a finite number';
      if (spec.type === 'integer' && !Number.isInteger(value)) return 'must be an integer';
      if (spec.min !== undefined && value < spec.min) return `must be >= ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `must be <= ${spec.max}`;
      return null;
    }
  }
}
