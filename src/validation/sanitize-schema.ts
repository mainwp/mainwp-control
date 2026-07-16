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

function sanitizeSchemaNode(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...node };
  for (const key of SCHEMA_MAP_KEYS) {
    const value = out[key];
    if (Array.isArray(value) && value.length === 0) {
      out[key] = {};
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const map: Record<string, unknown> = {};
      for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
        map[prop] = sanitizeSubschema(sub);
      }
      out[key] = map;
    }
  }
  for (const key of SCHEMA_KEYS) {
    if (key in out) out[key] = sanitizeSubschema(out[key]);
  }
  for (const key of SCHEMA_LIST_KEYS) {
    const value = out[key];
    if (Array.isArray(value)) {
      out[key] = value.map((sub) => sanitizeSubschema(sub));
    }
  }
  // additionalProperties may be a boolean or a subschema
  const ap = out['additionalProperties'];
  if (ap !== undefined && typeof ap !== 'boolean') {
    out['additionalProperties'] = sanitizeSubschema(ap);
  }
  return out;
}

function sanitizeSubschema(sub: unknown): unknown {
  if (Array.isArray(sub)) {
    // A subschema serialized as [] is PHP's empty object; {} accepts anything.
    return sub.length === 0 ? {} : sub.map((s) => sanitizeSubschema(s));
  }
  if (sub !== null && typeof sub === 'object') {
    return sanitizeSchemaNode(sub as Record<string, unknown>);
  }
  return sub;
}
