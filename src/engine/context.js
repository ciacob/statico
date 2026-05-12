'use strict';

/**
 * context.js
 *
 * Manages the build context (ctx) — the shared in-memory object that accumulates
 * resolved values throughout a build run.
 *
 * Design principles:
 *   - ctx is a plain JS object; no magic, no proxies
 *   - Values are set by dotted path (creating intermediate objects as needed)
 *   - The initial ctx is seeded from commons.json if present
 *   - All functions here are pure except `createCtx` and `setByPath` which mutate
 *     a ctx object passed in (caller owns the object)
 */

const fs = require('fs');
const path = require('path');

class ContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContextError';
  }
}

/**
 * Set a value in an object by dotted path, creating intermediate objects as needed.
 * Mutates `obj` in place.
 *
 * @param {object} obj
 * @param {string} dotPath   e.g. "page.meta.title"
 * @param {*}      value
 */
function setByPath(obj, dotPath, value) {
  if (!dotPath || typeof dotPath !== 'string') {
    throw new ContextError(`setByPath: invalid path "${dotPath}"`);
  }
  const keys = dotPath.split('.');
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (cursor[key] === undefined || cursor[key] === null) {
      cursor[key] = {};
    } else if (typeof cursor[key] !== 'object') {
      throw new ContextError(
        `setByPath: cannot set "${dotPath}" — "${keys.slice(0, i + 1).join('.')}" is not an object`
      );
    }
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

/**
 * Create and seed a fresh ctx object.
 * Always loads `contents/commons.json` from the site root if present.
 *
 * @param {string} siteRoot   Absolute path to the site folder
 * @returns {object}          The initial ctx
 */
function createCtx(siteRoot) {
  const ctx = {};

  const commonsPath = path.join(siteRoot, 'contents', 'commons.json');
  if (fs.existsSync(commonsPath)) {
    let commons;
    try {
      commons = JSON.parse(fs.readFileSync(commonsPath, 'utf8'));
    } catch (e) {
      throw new ContextError(`Failed to parse commons.json: ${e.message}`);
    }
    setByPath(ctx, 'commons', commons);
  }

  return ctx;
}

/**
 * Load a JSON file from the site's `contents/` directory.
 *
 * @param {string} siteRoot
 * @param {string} relativePath   e.g. "pieces/nocturne.json" or "commons.json"
 * @returns {*}                   Parsed JSON value
 */
function loadContent(siteRoot, relativePath) {
  const fullPath = path.join(siteRoot, 'contents', relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new ContextError(`Content file not found: contents/${relativePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (e) {
    throw new ContextError(`Failed to parse content file "${relativePath}": ${e.message}`);
  }
}

/**
 * Load a template snippet from the site's `_templates/` directory.
 *
 * @param {string} siteRoot
 * @param {string} relativePath   e.g. "piece.html" or "partials/head.html"
 * @returns {string}
 */
function loadTemplate(siteRoot, relativePath) {
  const fullPath = path.join(siteRoot, '_templates', relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new ContextError(`Template not found: _templates/${relativePath}`);
  }
  return fs.readFileSync(fullPath, 'utf8');
}

module.exports = { createCtx, setByPath, loadContent, loadTemplate, ContextError };
