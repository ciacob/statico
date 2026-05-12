'use strict';

/**
 * registry.js
 *
 * Scans a site's `_resolvers/` directory, requires each `.js` file,
 * and merges all exports into a flat registry keyed by namespace.
 *
 * Convention: a resolver file `utils.js` must export an object:
 *   module.exports = { utils: { getLanguage() { ... }, ... } }
 *
 * The top-level key(s) in the export become the namespace(s).
 * Filename is NOT used as the namespace — the export key is authoritative.
 * This allows one file to export multiple namespaces if needed.
 *
 * Collision policy: if two files export the same namespace key, an error
 * is thrown. Namespaces must be unique across the resolver directory.
 */

const fs = require('fs');
const path = require('path');

class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * Load all resolver modules from a directory into a registry object.
 *
 * @param {string} resolversDir  Absolute path to the `_resolvers/` folder
 * @returns {object}             Flat registry: { namespace: { fnName: fn, ... }, ... }
 */
function loadRegistry(resolversDir) {
  if (!fs.existsSync(resolversDir)) {
    return {}; // No resolvers is valid — site may use only constants/placeholders
  }

  const files = fs
    .readdirSync(resolversDir)
    .filter(f => f.endsWith('.js') && !f.startsWith('_'));

  const registry = {};

  for (const file of files) {
    const fullPath = path.join(resolversDir, file);
    let exported;

    try {
      // Clear require cache so re-runs (e.g. in tests) get fresh modules
      delete require.cache[require.resolve(fullPath)];
      exported = require(fullPath);
    } catch (e) {
      throw new RegistryError(`Failed to load resolver "${file}": ${e.message}`);
    }

    if (!exported || typeof exported !== 'object' || Array.isArray(exported)) {
      throw new RegistryError(
        `Resolver "${file}" must export a plain object of namespace objects.`
      );
    }

    for (const [namespace, impl] of Object.entries(exported)) {
      if (registry[namespace] !== undefined) {
        throw new RegistryError(
          `Namespace collision: "${namespace}" is exported by more than one resolver file.`
        );
      }
      if (typeof impl !== 'object' || impl === null || Array.isArray(impl)) {
        throw new RegistryError(
          `Resolver "${file}" exports namespace "${namespace}" but its value is not a plain object.`
        );
      }
      // Validate that all values in the namespace are functions
      for (const [fnName, fn] of Object.entries(impl)) {
        if (typeof fn !== 'function') {
          throw new RegistryError(
            `Resolver "${file}" exports "${namespace}.${fnName}" but it is not a function.`
          );
        }
      }
      registry[namespace] = impl;
    }
  }

  return registry;
}

/**
 * List all resolvable function references in the registry as "namespace.name" strings.
 * Useful for the validator utility.
 *
 * @param {object} registry
 * @returns {string[]}
 */
function listFunctions(registry) {
  const result = [];
  for (const [ns, impl] of Object.entries(registry)) {
    for (const name of Object.keys(impl)) {
      result.push(`${ns}.${name}`);
    }
  }
  return result;
}

module.exports = { loadRegistry, listFunctions, RegistryError };
