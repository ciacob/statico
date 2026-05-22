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
const CONFIG_FILE       = 'config.json';

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

  // Load config.json and re-order registry accordingly
  const config = loadConfig(siteRoot);
  return applyConfig(registry, config);
}

// ---------------------------------------------------------------------------
// Config (execution order)
// ---------------------------------------------------------------------------

/**
 * Load and parse `_interceptors/config.json` if present.
 * Returns null if the file does not exist.
 *
 * @param {string} siteRoot
 * @returns {object|null}
 */
function loadConfig(siteRoot) {
  const configPath = path.join(siteRoot, INTERCEPTORS_DIR, CONFIG_FILE);
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new InterceptorError(`Failed to parse config.json: ${e.message}`, e);
  }
}

/**
 * Validate the contents of config.json against the registry.
 * Returns an array of error strings (empty if valid).
 *
 * @param {object} config     Parsed config.json object
 * @param {Map}    registry   Loaded interceptor registry
 * @returns {string[]}
 */
function validateConfig(config, registry) {
  const errors = [];

  if (!config.stepInterceptors || typeof config.stepInterceptors !== 'object') {
    errors.push('config.json must have a "stepInterceptors" root object');
    return errors;
  }

  const { order } = config.stepInterceptors;

  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    errors.push('config.json "stepInterceptors" must have an "order" object');
    return errors;
  }

  const orderKeys = Object.keys(order);

  if (orderKeys.length === 0) {
    errors.push('config.json "stepInterceptors.order" must have at least one child node');
    return errors;
  }

  if (orderKeys.length > 3) {
    errors.push('config.json "stepInterceptors.order" must have at most three child nodes');
  }

  for (const stepType of orderKeys) {
    if (!VALID_STEP_TYPES.includes(stepType)) {
      errors.push(
        `config.json "order" has invalid step type "${stepType}" ` +
        `(expected: ${VALID_STEP_TYPES.join(', ')})`
      );
      continue;
    }

    const list = order[stepType];

    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`config.json "order.${stepType}" must be a non-empty array`);
      continue;
    }

    const seen = new Set();
    for (const name of list) {
      // Must be unique within the list
      if (seen.has(name)) {
        errors.push(`config.json "order.${stepType}" has duplicate entry "${name}"`);
        continue;
      }
      seen.add(name);

      // Must reference an existing interceptor
      const entry = registry.get(name);
      if (!entry) {
        errors.push(
          `config.json "order.${stepType}" references unknown interceptor "${name}"`
        );
        continue;
      }

      // Must reference a step interceptor of the matching stepType
      if (entry.definition.stepType !== stepType) {
        errors.push(
          `config.json "order.${stepType}" references "${name}" whose stepType is ` +
          `"${entry.definition.stepType}", not "${stepType}"`
        );
      }
    }
  }

  return errors;
}

/**
 * Re-order the registry entries according to config.json.
 * Listed interceptors run first in specified order; unlisted ones follow in
 * filesystem scan order.
 *
 * @param {Map}      registry
 * @param {object}   config    Parsed config.json (may be null)
 * @returns {Map}    A new Map with entries in the correct execution order
 */
function applyConfig(registry, config) {
  if (!config) return registry;

  const order = config.stepInterceptors && config.stepInterceptors.order;
  if (!order) return registry;

  // Build a map of name → desired position per stepType
  const positions = new Map();  // name → index (lower = earlier)
  for (const [stepType, list] of Object.entries(order)) {
    list.forEach((name, idx) => positions.set(name, idx));
  }

  // Separate entries into ordered and unordered, then merge
  const ordered   = [];
  const unordered = [];

  for (const [name, entry] of registry) {
    if (positions.has(name)) {
      ordered.push([name, entry, positions.get(name)]);
    } else {
      unordered.push([name, entry]);
    }
  }

  ordered.sort((a, b) => a[2] - b[2]);

  const sorted = new Map();
  for (const [name, entry] of ordered)   sorted.set(name, entry);
  for (const [name, entry] of unordered) sorted.set(name, entry);

  return sorted;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate all loaded interceptors.
 *
 * @param {Map}    registry   Result of loadInterceptors()
 * @param {string} siteRoot
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateInterceptors(registry, siteRoot) {
  const errors   = [];
  const warnings = [];
  const names    = new Set();

  for (const [name, { definition }] of registry) {

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

    // stepType present and valid
    if (!definition.stepType) {
      errors.push(`Interceptor "${name}" is missing "stepType"`);
    } else if (!VALID_STEP_TYPES.includes(definition.stepType)) {
      errors.push(
        `Interceptor "${name}" has invalid stepType "${definition.stepType}" ` +
        `(expected: ${VALID_STEP_TYPES.join(', ')})`
      );
    }
  }

  // Validate config.json if present
  try {
    const config = loadConfig(siteRoot);
    if (config) {
      const configErrors = validateConfig(config, registry);
      errors.push(...configErrors);
    }
  } catch (e) {
    errors.push(`config.json: ${e.message}`);
  }

  return { errors, warnings };
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
    if (definition.stepType !== stepType) continue;

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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadInterceptors,
  loadConfig,
  validateConfig,
  applyConfig,
  validateInterceptors,
  runStepInterceptors,
  runTransform,
  InterceptorError,
  INTERCEPTORS_DIR,
};
