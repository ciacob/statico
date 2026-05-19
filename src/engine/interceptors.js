'use strict';

/**
 * interceptors.js
 *
 * Loader, validator, and runner for the Statico interceptor system.
 *
 * Interceptors live under `_interceptors/<any-name>/` and consist of:
 *   - interceptor.json  — definition (name, trigger)
 *   - transformation.js — pure transform function
 *
 * Two trigger types:
 *   - "step"     : engine injects named args; hooked into copy/resolve/output steps
 *   - "explicit" : user triggers via `interceptBy` in any JSON node
 *
 * Engine-injected argument keys per step type:
 *   copy    : { "source-path", "target-path" }
 *   resolve : { "template", "value" }
 *   output  : { "content", "file-path" }
 */

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class InterceptorError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'InterceptorError';
    if (cause) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTERCEPTORS_DIR  = '_interceptors';
const DEFINITION_FILE   = 'interceptor.json';
const TRANSFORM_FILE    = 'transformation.js';
const RESERVED_PREFIX   = 'statico';
const VALID_STEP_TYPES  = ['copy', 'resolve', 'output'];
const VALID_TRIGGER_TYPES = ['step', 'explicit'];
const ARG_PREFIX        = '@';

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Scan the `_interceptors` directory and load all interceptor definitions.
 * Returns an empty registry if the folder does not exist.
 *
 * @param {string} siteRoot
 * @returns {Map<string, object>}  name → { definition, transformFn, dir }
 */
function loadInterceptors(siteRoot) {
  const registry = new Map();
  const interceptorsDir = path.join(siteRoot, INTERCEPTORS_DIR);

  if (!fs.existsSync(interceptorsDir)) return registry;

  const entries = fs.readdirSync(interceptorsDir, { withFileTypes: true })
    .filter(e => e.isDirectory());

  for (const entry of entries) {
    const dir     = path.join(interceptorsDir, entry.name);
    const defPath = path.join(dir, DEFINITION_FILE);
    const trsPath = path.join(dir, TRANSFORM_FILE);

    if (!fs.existsSync(defPath) || !fs.existsSync(trsPath)) continue;

    let definition;
    try {
      definition = JSON.parse(fs.readFileSync(defPath, 'utf8'));
    } catch (e) {
      throw new InterceptorError(
        `Failed to parse ${DEFINITION_FILE} in "${entry.name}": ${e.message}`, e
      );
    }

    let transformModule;
    try {
      delete require.cache[require.resolve(trsPath)];
      transformModule = require(trsPath);
    } catch (e) {
      throw new InterceptorError(
        `Failed to load ${TRANSFORM_FILE} in "${entry.name}": ${e.message}`, e
      );
    }

    const transformFn = transformModule.transform;
    if (typeof transformFn !== 'function') {
      throw new InterceptorError(
        `${TRANSFORM_FILE} in "${entry.name}" must export a "transform" function`
      );
    }

    registry.set(definition.name, { definition, transformFn, dir });
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate all loaded interceptors and optionally scan JSON files for
 * `interceptBy` references.
 *
 * @param {Map}    registry   Result of loadInterceptors()
 * @param {string} siteRoot
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateInterceptors(registry, siteRoot) {
  const errors   = [];
  const warnings = [];
  const names    = new Set();

  for (const [name, { definition, transformFn }] of registry) {

    // name present and valid
    if (!name || typeof name !== 'string') {
      errors.push(`Interceptor has missing or invalid "name"`);
      continue;
    }

    // name does not begin with reserved prefix
    if (name.toLowerCase().startsWith(RESERVED_PREFIX)) {
      errors.push(`Interceptor name "${name}" must not begin with "${RESERVED_PREFIX}"`);
    }

    // name is unique
    if (names.has(name)) {
      errors.push(`Duplicate interceptor name: "${name}"`);
    }
    names.add(name);

    // trigger present
    const { trigger } = definition;
    if (!trigger || typeof trigger !== 'object') {
      errors.push(`Interceptor "${name}" is missing a "trigger" object`);
      continue;
    }

    // trigger.type valid
    if (!VALID_TRIGGER_TYPES.includes(trigger.type)) {
      errors.push(
        `Interceptor "${name}" has invalid trigger type "${trigger.type}" ` +
        `(expected: ${VALID_TRIGGER_TYPES.join(', ')})`
      );
    }

    // stepType required and valid when type=step
    if (trigger.type === 'step') {
      if (!trigger.stepType) {
        errors.push(`Interceptor "${name}" trigger type "step" requires "stepType"`);
      } else if (!VALID_STEP_TYPES.includes(trigger.stepType)) {
        errors.push(
          `Interceptor "${name}" has invalid stepType "${trigger.stepType}" ` +
          `(expected: ${VALID_STEP_TYPES.join(', ')})`
        );
      }
    }
  }

  // Scan JSON files outside _interceptors for interceptBy references
  const knownNames = new Set(registry.keys());
  scanJsonFiles(siteRoot, knownNames, errors, warnings);

  return { errors, warnings };
}

/**
 * Recursively scan all JSON files in siteRoot (excluding _interceptors,
 * node_modules, and known Node.js-specific files) for `interceptBy` usage.
 *
 * @param {string}   siteRoot
 * @param {Set}      knownNames
 * @param {string[]} errors
 * @param {string[]} warnings
 */
function scanJsonFiles(siteRoot, knownNames, errors, warnings) {
  const SKIP_FILES = new Set(['package.json', 'package-lock.json']);
  const SKIP_DIRS  = new Set(['_interceptors', 'node_modules', '_out', '_logs']);

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        if (SKIP_FILES.has(entry.name)) continue;
        let data;
        try { data = JSON.parse(fs.readFileSync(full, 'utf8')); }
        catch { continue; }

        findInterceptByRefs(data, full, knownNames, errors, warnings);
      }
    }
  }

  walk(siteRoot);
}

/**
 * Recursively find all `interceptBy` values in a parsed JSON value.
 */
function findInterceptByRefs(value, filePath, knownNames, errors, warnings) {
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach(v => findInterceptByRefs(v, filePath, knownNames, errors, warnings));
    return;
  }

  if ('interceptBy' in value) {
    const ref = value.interceptBy;
    if (knownNames.size === 0) {
      errors.push(
        `"interceptBy: ${ref}" found in ${filePath} but no _interceptors folder exists`
      );
    } else if (!knownNames.has(ref)) {
      errors.push(
        `"interceptBy: ${ref}" in ${filePath} does not match any known interceptor`
      );
    }
  }

  for (const v of Object.values(value)) {
    findInterceptByRefs(v, filePath, knownNames, errors, warnings);
  }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Execute a single interceptor's transform function defensively.
 * Returns the value of output.response.
 *
 * @param {Function} transformFn
 * @param {object}   args          Named arguments object
 * @param {object}   [tools]       Optional tools (logger etc.)
 * @param {string}   interceptorName  For error messages
 * @returns {*}  true | false | alternate value
 */
function runTransform(transformFn, args, tools, interceptorName) {
  const output = { response: true };
  const safeTools = tools || { log: () => {} };

  try {
    transformFn(args, output, safeTools);
  } catch (e) {
    throw new InterceptorError(
      `Interceptor "${interceptorName}" threw during transform: ${e.message}`, e
    );
  }

  return output.response;
}

/**
 * Run all step interceptors of a given stepType against provided args.
 * Returns the final resolved value after all interceptors have run,
 * or null if any interceptor returns false (operation should be skipped).
 *
 * @param {Map}    registry
 * @param {string} stepType   "copy" | "resolve" | "output"
 * @param {object} args       Named args for this step type
 * @param {object} [tools]
 * @returns {{ skip: boolean, value: * }}
 */
function runStepInterceptors(registry, stepType, args, tools) {
  let currentValue = args;

  for (const [name, { definition, transformFn }] of registry) {
    if (definition.trigger.type !== 'step') continue;
    if (definition.trigger.stepType !== stepType) continue;

    // Merge current value into args if it has been altered by a previous interceptor
    const effectiveArgs = typeof currentValue === 'object' && currentValue !== null
      ? currentValue
      : args;

    const response = runTransform(transformFn, effectiveArgs, tools, name);

    if (response === false) return { skip: true, value: null };
    if (response === true)  continue;

    // Interceptor returned an alternate value — carry it forward
    currentValue = response;
  }

  return { skip: false, value: currentValue === args ? null : currentValue };
}

/**
 * Resolve an explicitly triggered interceptor node.
 * The node must have an `interceptBy` key and optional `@`-prefixed arg keys.
 *
 * @param {object} node       The JSON node containing `interceptBy`
 * @param {Map}    registry
 * @param {object} [tools]
 * @returns {*}  The value returned by output.response
 */
function runExplicitInterceptor(node, registry, tools) {
  const name = node.interceptBy;
  const entry = registry.get(name);

  if (!entry) {
    throw new InterceptorError(`Explicit interceptor not found: "${name}"`);
  }
  if (entry.definition.trigger.type !== 'explicit') {
    throw new InterceptorError(
      `Interceptor "${name}" is a step interceptor and cannot be triggered explicitly`
    );
  }

  // Build args object from @-prefixed keys, stripping the prefix
  const args = {};
  for (const [key, val] of Object.entries(node)) {
    if (key === 'interceptBy') continue;
    if (key.startsWith(ARG_PREFIX)) {
      args[key.slice(ARG_PREFIX.length)] = val;
    }
  }

  return runTransform(entry.transformFn, args, tools, name);
}

/**
 * Walk a value (object/array/primitive) and resolve any explicit interceptor
 * nodes found within it. Returns a new value with all interceptor nodes
 * replaced by their responses.
 *
 * @param {*}      value
 * @param {Map}    registry
 * @param {object} [tools]
 * @returns {*}
 */
function resolveExplicitInterceptors(value, registry, tools) {
  if (!value || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(v => resolveExplicitInterceptors(v, registry, tools));
  }

  // If this node is an explicit interceptor trigger, resolve it
  if ('interceptBy' in value) {
    return runExplicitInterceptor(value, registry, tools);
  }

  // Otherwise recurse into object values
  const result = {};
  for (const [k, v] of Object.entries(value)) {
    result[k] = resolveExplicitInterceptors(v, registry, tools);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadInterceptors,
  validateInterceptors,
  runStepInterceptors,
  runExplicitInterceptor,
  resolveExplicitInterceptors,
  InterceptorError,
  INTERCEPTORS_DIR,
  ARG_PREFIX,
};
