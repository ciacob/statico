'use strict';

/**
 * resolver.js
 *
 * Responsible for parsing and evaluating the three value types:
 *   - Constants:     any plain value (string, number, boolean, array, object)
 *   - Placeholders:  {{some.dotted.path}}  — resolved against ctx
 *   - Function calls: {{fn:namespace.name(arg1, arg2)}} — resolved against registry
 *
 * All functions here are pure with respect to their inputs.
 * Side effects (ctx mutation) are the caller's responsibility.
 */

// Matches {{ ... }} where the inner content may itself contain {{ }}
// We do a balanced-brace match manually in isExpression/extractInner for nested cases,
// but this regex handles the common (non-nested) case for quick checks.
const PLACEHOLDER_RE = /^\{\{([^}]+)\}\}$/;
const FN_PREFIX = 'fn:';

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve a value from an object by a dotted key path.
 * Returns `undefined` if any segment is missing.
 *
 * @param {object} obj
 * @param {string} path  e.g. "page.title"
 * @returns {*}
 */
function getByPath(obj, path) {
  if (!path || typeof path !== 'string') return undefined;
  return path.split('.').reduce(
    (acc, key) => (acc !== null && acc !== undefined ? acc[key] : undefined),
    obj
  );
}

/**
 * Determine whether a string is entirely a single {{ }} expression.
 * Supports nested {{ }} inside (e.g. for nested fn calls in arguments).
 *
 * @param {string} str
 * @returns {boolean}
 */
function isExpression(str) {
  if (typeof str !== 'string') return false;
  const s = str.trim();
  if (!s.startsWith('{{')) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{' && s[i + 1] === '{') { depth++; i++; continue; }
    if (s[i] === '}' && s[i + 1] === '}') {
      depth--;
      i++;
      if (depth === 0) return i === s.length - 1;
    }
  }
  return false;
}

/**
 * Extract the inner content of a {{ }} expression.
 * Assumes isExpression(str) === true.
 * Strips the outer {{ and }} only.
 *
 * @param {string} str
 * @returns {string}
 */
function extractInner(str) {
  const s = str.trim();
  return s.slice(2, s.length - 2).trim();
}

/**
 * Determine whether an inner expression string is a function call.
 *
 * @param {string} inner
 * @returns {boolean}
 */
function isFnCall(inner) {
  return inner.startsWith(FN_PREFIX);
}

// ---------------------------------------------------------------------------
// Function call parser
// ---------------------------------------------------------------------------

/**
 * Parse a function call expression (without the "fn:" prefix already stripped).
 * Handles nested {{fn:...}} inside argument positions.
 *
 * Input:  "utils.getLanguage()"
 * Output: { namespace: "utils", name: "getLanguage", rawArgs: [] }
 *
 * Input:  "utils.translate({{fn:utils.getLanguage()}}, hello)"
 * Output: { namespace: "utils", name: "translate", rawArgs: ["{{fn:utils.getLanguage()}}", "hello"] }
 *
 * @param {string} inner  The expression *after* stripping "fn:"
 * @returns {{ namespace: string, name: string, rawArgs: string[] }}
 */
function parseFnCall(inner) {
  const withoutPrefix = inner.slice(FN_PREFIX.length);
  const parenOpen = withoutPrefix.indexOf('(');

  if (parenOpen === -1) {
    // No parentheses — treat as zero-arg call
    const [namespace, ...rest] = withoutPrefix.split('.');
    const name = rest.join('.');
    return { namespace, name, rawArgs: [] };
  }

  const qualifiedName = withoutPrefix.slice(0, parenOpen).trim();
  const argsStr = withoutPrefix.slice(parenOpen + 1, withoutPrefix.lastIndexOf(')')).trim();

  const [namespace, ...rest] = qualifiedName.split('.');
  const name = rest.join('.');

  const rawArgs = argsStr.length > 0 ? splitArgs(argsStr) : [];

  return { namespace, name, rawArgs };
}

/**
 * Split a comma-separated argument string, respecting nested {{ }} blocks.
 *
 * @param {string} argsStr
 * @returns {string[]}
 */
function splitArgs(argsStr) {
  const args = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (ch === '{' && argsStr[i + 1] === '{') { depth++; current += ch; continue; }
    if (ch === '}' && argsStr[i + 1] === '}') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

// ---------------------------------------------------------------------------
// Core resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single value against ctx and registry.
 * Recursively resolves nested expressions inside function arguments.
 *
 * @param {*}      value     The raw value from build.json or a template token
 * @param {object} ctx       The current build context
 * @param {object} registry  The resolver function registry
 * @returns {*}              The resolved value
 */
function resolveValue(value, ctx, registry) {
  // Non-string values (numbers, booleans, arrays, objects) are returned as-is
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();

  if (!isExpression(trimmed)) return value; // plain string constant

  const inner = extractInner(trimmed);

  if (isFnCall(inner)) {
    return resolveFnCall(inner, ctx, registry);
  }

  // Dotted path into ctx
  const resolved = getByPath(ctx, inner);
  if (resolved === undefined) {
    throw new ResolverError(`Placeholder path not found in ctx: "${inner}"`);
  }
  return resolved;
}

/**
 * Resolve a function call expression.
 *
 * @param {string} inner     The inner expression string (still has "fn:" prefix)
 * @param {object} ctx
 * @param {object} registry
 * @returns {*}
 */
function resolveFnCall(inner, ctx, registry) {
  const { namespace, name, rawArgs } = parseFnCall(inner);

  const ns = registry[namespace];
  if (!ns) {
    throw new ResolverError(`Resolver namespace not found: "${namespace}"`);
  }
  const fn = ns[name];
  if (typeof fn !== 'function') {
    throw new ResolverError(`Resolver function not found: "${namespace}.${name}"`);
  }

  // Recursively resolve arguments before calling
  const resolvedArgs = rawArgs.map(arg => resolveValue(arg, ctx, registry));

  return fn(...resolvedArgs);
}

/**
 * Interpolate all {{ }} expressions within a template string.
 * Unlike resolveValue, this handles expressions *embedded* inside larger strings.
 *
 * e.g. "<title>{{page.title}}</title>" → "<title>My Piece</title>"
 *
 * @param {string} template
 * @param {object} ctx
 * @param {object} registry
 * @returns {string}
 */
function interpolate(template, ctx, registry) {
  if (typeof template !== 'string') return template;

  // If the entire string is a single expression, use resolveValue (preserves type)
  if (isExpression(template.trim())) {
    const result = resolveValue(template.trim(), ctx, registry);
    return result === undefined ? template : result;
  }

  // Otherwise replace all {{ }} occurrences inline
  return template.replace(/\{\{([^}]+)\}\}/g, (match, inner) => {
    inner = inner.trim();
    try {
      if (isFnCall(inner)) {
        const result = resolveFnCall(inner, ctx, registry);
        return result === undefined ? '' : String(result);
      }
      const result = getByPath(ctx, inner);
      if (result === undefined) {
        throw new ResolverError(`Placeholder path not found in ctx: "${inner}"`);
      }
      return String(result);
    } catch (e) {
      throw new ResolverError(`Failed to interpolate "{{${inner}}}": ${e.message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Validation helpers (no execution)
// ---------------------------------------------------------------------------

/**
 * Extract all {{ }} expression strings from a value (recursively for objects/arrays).
 *
 * @param {*} value
 * @returns {string[]}  Flat list of inner expression strings
 */
function extractExpressions(value) {
  if (typeof value === 'string') {
    const found = [];
    for (const [, inner] of value.matchAll(/\{\{([^}]+)\}\}/g)) {
      found.push(inner.trim());
    }
    return found;
  }
  if (Array.isArray(value)) return value.flatMap(extractExpressions);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(extractExpressions);
  }
  return [];
}

/**
 * Validate that all fn: references in an expression exist in the registry.
 * Does not execute functions. Does not validate ctx paths.
 *
 * @param {string} inner
 * @param {object} registry
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFnRef(inner, registry) {
  if (!isFnCall(inner)) return { valid: true };
  const { namespace, name } = parseFnCall(inner);
  const ns = registry[namespace];
  if (!ns) return { valid: false, error: `Resolver namespace not found: "${namespace}"` };
  if (typeof ns[name] !== 'function') {
    return { valid: false, error: `Resolver function not found: "${namespace}.${name}"` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

class ResolverError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResolverError';
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getByPath,
  isExpression,
  extractInner,
  isFnCall,
  parseFnCall,
  splitArgs,
  resolveValue,
  resolveFnCall,
  interpolate,
  extractExpressions,
  validateFnRef,
  ResolverError,
};
