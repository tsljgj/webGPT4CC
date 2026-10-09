// JSON-Schema helpers: compact human-readable rendering for prompts, and
// schema-guided coercion of raw text parameter values parsed from model output.
import type { JSONSchema } from '../anthropic/types.ts';

function typesOf(schema: JSONSchema | undefined): string[] {
  if (!schema) return [];
  if (Array.isArray(schema.type)) return schema.type;
  if (typeof schema.type === 'string') return [schema.type];
  const alts = schema.anyOf ?? schema.oneOf;
  if (alts) return [...new Set(alts.flatMap(typesOf))];
  if (schema.enum) return [...new Set(schema.enum.map((v) => (v === null ? 'null' : typeof v)))];
  if (schema.const !== undefined) return [schema.const === null ? 'null' : typeof schema.const];
  if (schema.properties) return ['object'];
  if (schema.items) return ['array'];
  return [];
}

/** True when the value should be passed through as a raw (unescaped) string. */
export function isStringSchema(schema: JSONSchema | undefined): boolean {
  const t = typesOf(schema).filter((x) => x !== 'null');
  return t.length === 0 || (t.length === 1 && t[0] === 'string');
}

/** Render a schema as a compact TypeScript-like type, e.g. `array<{path: string, line?: number}>`. */
export function schemaToType(schema: JSONSchema | undefined, depth = 0): string {
  if (!schema || typeof schema !== 'object') return 'any';
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const alts = schema.anyOf ?? schema.oneOf;
  if (alts && alts.length) return [...new Set(alts.map((a) => schemaToType(a, depth)))].join(' | ');
  const t = typesOf(schema);
  if (t.length > 1) return t.join(' | ');
  switch (t[0]) {
    case 'array': {
      const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
      return `array<${schemaToType(items, depth + 1)}>`;
    }
    case 'object': {
      const props = schema.properties ?? {};
      const keys = Object.keys(props);
      if (!keys.length) return 'object';
      if (depth >= 3) return 'object';
      const req = new Set(schema.required ?? []);
      return `{${keys.map((k) => `${k}${req.has(k) ? '' : '?'}: ${schemaToType(props[k], depth + 1)}`).join(', ')}}`;
    }
    case 'integer':
      return 'integer';
    case undefined:
      return 'any';
    default:
      return t[0]!;
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export interface ParamDoc {
  name: string;
  type: string;
  required: boolean;
  raw: boolean;
  description: string;
}

export function describeParams(schema: JSONSchema | undefined, maxDescChars = 600): ParamDoc[] {
  const props = schema?.properties ?? {};
  const req = new Set(schema?.required ?? []);
  return Object.entries(props).map(([name, s]) => {
    let description = oneLine(s?.description ?? '');
    if (s?.default !== undefined) description += `${description ? ' ' : ''}(default: ${JSON.stringify(s.default)})`;
    if (description.length > maxDescChars) description = description.slice(0, maxDescChars - 1) + '…';
    return { name, type: schemaToType(s), required: req.has(name), raw: isStringSchema(s), description };
  });
}

// ---------------------------------------------------------------------------
// Coercion of parsed values

/** Lenient JSON parse: accepts surrounding code fences and trailing commas. */
export function lenientJsonParse(text: string): { ok: true; value: unknown } | { ok: false } {
  let t = text.trim();
  const fence = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    /* fall through */
  }
  const noTrailingCommas = t.replace(/,(\s*[}\]])/g, '$1');
  if (noTrailingCommas !== t) {
    try {
      return { ok: true, value: JSON.parse(noTrailingCommas) };
    } catch {
      /* fall through */
    }
  }
  return { ok: false };
}

/**
 * Convert a raw parameter string into the JSON value the schema expects.
 * Never throws: when coercion is impossible the raw string is returned and
 * Claude Code's own input validation reports the problem back to the model.
 */
export function coerceValue(raw: string, schema: JSONSchema | undefined): unknown {
  if (isStringSchema(schema)) return raw;
  const types = typesOf(schema);
  const trimmed = raw.trim();
  const parsed = lenientJsonParse(trimmed);
  if (parsed.ok) {
    const v = parsed.value;
    const vt = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    const accepts = (t: string) => types.includes(t) || (t === 'number' && types.includes('integer'));
    if (types.length === 0 || accepts(vt)) return v;
    // A JSON string literal where a string is acceptable.
    if (vt === 'string' && types.includes('string')) return v;
  }
  if (types.includes('boolean')) {
    if (/^(true|yes)$/i.test(trimmed)) return true;
    if (/^(false|no)$/i.test(trimmed)) return false;
  }
  if ((types.includes('number') || types.includes('integer')) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (types.includes('array') && !trimmed.startsWith('[')) {
    // A bare single item for an array param.
    const items = Array.isArray(schema?.items) ? schema?.items[0] : schema?.items;
    if (isStringSchema(items as JSONSchema | undefined)) return trimmed ? [trimmed] : [];
  }
  if (types.includes('null') && (trimmed === '' || trimmed === 'null')) return null;
  if (types.includes('string')) return raw;
  return parsed.ok ? parsed.value : raw;
}
