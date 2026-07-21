/**
 * Normalize a Dashboard-served input schema into valid JSON Schema.
 *
 * The Dashboard is PHP, and json_encode turns empty associative arrays into
 * [], so schemas arrive with inputSchema: [] or properties: []. Providers
 * also require the top-level type to be exactly 'object', while the
 * Dashboard emits type: ['object', 'null'] for optional input. Returns a
 * new object; the input is never mutated.
 *
 * Remote schemas are hostile input, so two guarantees hold for the WHOLE
 * tree, not just known keywords:
 * - No remote regex is ever compiled client-side: `pattern` and
 *   `patternProperties` are deleted from every schema node. No heuristic
 *   reliably separates safe regexes from catastrophic ones, and a hostile
 *   pattern can stall the CLI in ajv before any request is sent. Dropping
 *   them only loosens client-side validation; the Dashboard re-validates.
 * - Recursion is bounded: nesting past MAX_SCHEMA_DEPTH collapses to {},
 *   with arrays counting against the budget, and data-bearing keys dropped
 *   wholesale when their literal value nests past the budget.
 *
 * Both are enforced by walking EVERY object/array value (known schema
 * keywords and unknown/future ones like draft-07 `dependencies` alike), so
 * the guarantees do not depend on maintaining a complete keyword list. The
 * keyword lists below only control which positions get the PHP []→{}
 * normalization; the scrub and the depth cap apply everywhere. Only
 * data-carrying keys (const, enum, default, examples) are copied verbatim —
 * their contents are literal values, not schema, and a key named "pattern"
 * inside them must survive.
 */
export function sanitizeInputSchema(
  inputSchema: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (
    inputSchema === undefined ||
    inputSchema === null ||
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

/**
 * Keys whose values are maps of subschemas ({ name: schema }). Their KEYS
 * are property names, not schema keywords — a property literally named
 * "pattern" must survive. patternProperties is absent because it is dropped
 * wholesale. draft-07 `dependencies` entries may also be arrays of property
 * names; those pass through the subschema walk unchanged.
 */
const SCHEMA_MAP_KEYS = ['properties', 'definitions', '$defs', 'dependentSchemas', 'dependencies'];
/** Keys whose values are a single subschema (PHP [] means empty object). */
const SCHEMA_KEYS = [
  'items', 'additionalItems', 'additionalProperties', 'not', 'if', 'then', 'else',
  'contains', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties',
];
/** Keys whose values are literal data, never schema — copied verbatim. */
const DATA_KEYS = new Set(['const', 'enum', 'default', 'examples']);

// User input is independently depth-capped at 10 (input-sanitizer.ts), so a schema
// nested past this cap cannot meaningfully validate accepted input. Bounding recursion
// here protects against a hostile schema exhausting the stack.
const MAX_SCHEMA_DEPTH = 32;

function sanitizeSchemaNode(node: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > MAX_SCHEMA_DEPTH) return {};
  const out: Record<string, unknown> = { ...node };
  delete out['pattern'];
  delete out['patternProperties'];

  for (const [key, value] of Object.entries(out)) {
    if (DATA_KEYS.has(key)) {
      // Literal data is preserved verbatim (no schema-key deletion inside
      // it), but it still consumes the depth budget: an over-deep value
      // drops the whole keyword instead of being partially rewritten.
      if (exceedsDepth(value, depth + 1)) {
        delete out[key];
      }
      continue;
    }

    if (SCHEMA_MAP_KEYS.includes(key)) {
      if (Array.isArray(value) && value.length === 0) {
        out[key] = {};
        continue;
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const map: Record<string, unknown> = {};
        for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
          map[prop] = sanitizeSubschema(sub, depth + 1);
        }
        out[key] = map;
        continue;
      }
    }

    if (
      (SCHEMA_KEYS.includes(key) && typeof value !== 'boolean') ||
      Array.isArray(value) && (key === 'allOf' || key === 'anyOf' || key === 'oneOf' || key === 'prefixItems')
    ) {
      out[key] = sanitizeSubschema(value, depth + 1);
      continue;
    }

    // Generic walk for every other object/array value: unknown keywords
    // cannot smuggle a regex or unbounded nesting past the sanitizer. No
    // []→{} conversion here — outside known subschema positions an empty
    // array (e.g. required: []) is legitimate data.
    if (value !== null && typeof value === 'object') {
      out[key] = sanitizeGenericValue(value, depth + 1);
    }
  }

  return out;
}

function sanitizeSubschema(sub: unknown, depth: number): unknown {
  if (depth > MAX_SCHEMA_DEPTH) return {};
  if (Array.isArray(sub)) {
    // A subschema serialized as [] is PHP's empty object; {} accepts anything.
    // Arrays count against the depth budget: nested hostile arrays would
    // otherwise recurse this walker without ever hitting the cap.
    return sub.length === 0 ? {} : sub.map((s) => sanitizeSubschema(s, depth + 1));
  }
  if (sub !== null && typeof sub === 'object') {
    return sanitizeSchemaNode(sub as Record<string, unknown>, depth);
  }
  return sub;
}

function sanitizeGenericValue(value: unknown, depth: number): unknown {
  if (depth > MAX_SCHEMA_DEPTH) return {};
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeGenericValue(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    return sanitizeSchemaNode(value as Record<string, unknown>, depth);
  }
  return value;
}

/**
 * True when `value` nests past MAX_SCHEMA_DEPTH counting from `startDepth`.
 * Iterative on an explicit heap stack, so measuring an arbitrarily deep
 * hostile structure cannot itself exhaust the call stack. Total node count
 * is already bounded by the transport's byte cap.
 */
function exceedsDepth(value: unknown, startDepth: number): boolean {
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: startDepth }];
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (d > MAX_SCHEMA_DEPTH) return true;
    const children = Array.isArray(v) ? v : Object.values(v);
    for (const child of children) {
      stack.push({ v: child, d: d + 1 });
    }
  }
  return false;
}
