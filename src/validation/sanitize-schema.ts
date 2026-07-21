/**
 * Normalize a Dashboard-served input schema into valid JSON Schema.
 *
 * The Dashboard is PHP, and json_encode turns empty associative arrays into
 * [], so schemas arrive with inputSchema: [] or properties: []. Providers
 * also require the top-level type to be exactly 'object', while the
 * Dashboard emits type: ['object', 'null'] for optional input. Returns a
 * new object; the input is never mutated.
 */
export function sanitizeInputSchema(
  inputSchema: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (
    inputSchema === undefined ||
    Array.isArray(inputSchema) ||
    typeof inputSchema !== 'object'
  ) {
    return { type: 'object', properties: {} };
  }
  const schema = sanitizeSchemaNode(inputSchema);
  if (Array.isArray(schema['type']) && schema['type'].includes('object')) {
    schema['type'] = 'object';
  }
  return schema;
}

/** Keys whose values are maps of subschemas ({ name: schema }). */
const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', 'definitions', '$defs'];
/** Keys whose values are a single subschema. */
const SCHEMA_KEYS = ['items', 'additionalItems', 'not', 'if', 'then', 'else'];
/** Keys whose values are lists of subschemas. */
const SCHEMA_LIST_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

// User input is independently depth-capped at 10 (input-sanitizer.ts), so a schema
// nested past this cap cannot meaningfully validate accepted input. Bounding recursion
// here protects against a hostile schema exhausting the stack.
const MAX_SCHEMA_DEPTH = 32;
// An adversarial regex passed through unbounded can ReDoS ajv when input is validated.
const MAX_PATTERN_LENGTH = 1000;

function sanitizeSchemaNode(node: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > MAX_SCHEMA_DEPTH) return {};
  const out: Record<string, unknown> = { ...node };
  for (const key of SCHEMA_MAP_KEYS) {
    const value = out[key];
    if (Array.isArray(value) && value.length === 0) {
      out[key] = {};
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const map: Record<string, unknown> = {};
      for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'patternProperties' && prop.length > MAX_PATTERN_LENGTH) continue;
        map[prop] = sanitizeSubschema(sub, depth + 1);
      }
      out[key] = map;
    }
  }
  for (const key of SCHEMA_KEYS) {
    if (key in out) out[key] = sanitizeSubschema(out[key], depth + 1);
  }
  for (const key of SCHEMA_LIST_KEYS) {
    const value = out[key];
    if (Array.isArray(value)) {
      out[key] = value.map((sub) => sanitizeSubschema(sub, depth + 1));
    }
  }
  // additionalProperties may be a boolean or a subschema
  const ap = out['additionalProperties'];
  if (ap !== undefined && typeof ap !== 'boolean') {
    out['additionalProperties'] = sanitizeSubschema(ap, depth + 1);
  }
  const pattern = out['pattern'];
  if ('pattern' in out && (typeof pattern !== 'string' || pattern.length > MAX_PATTERN_LENGTH)) {
    delete out['pattern'];
  }
  return out;
}

function sanitizeSubschema(sub: unknown, depth: number): unknown {
  if (Array.isArray(sub)) {
    // A subschema serialized as [] is PHP's empty object; {} accepts anything.
    return sub.length === 0 ? {} : sub.map((s) => sanitizeSubschema(s, depth));
  }
  if (sub !== null && typeof sub === 'object') {
    return sanitizeSchemaNode(sub as Record<string, unknown>, depth);
  }
  return sub;
}
