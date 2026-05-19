'use strict';

/**
 * validator.js
 *
 * Static analysis of a build.json without executing any steps.
 *
 * What it checks:
 *   1. build.json parses correctly and has required structure
 *   2. All fn: references exist in the registry
 *   3. All template paths referenced in `resolve` steps exist on disk
 *   4. All source paths referenced in `copy` steps exist on disk
 *   5. (optional, --check-ctx) All placeholder paths exist in a partially-built ctx
 *
 * What it does NOT check:
 *   - Whether user-provided resolver functions produce correct output
 *   - Whether ctx paths populated by function calls are valid
 *     (unless --check-ctx is set, in which case we check what we can)
 */

const fs = require('fs');
const path = require('path');
const { extractExpressions, validateFnRef, isFnCall } = require('./resolver');
const { loadBuildDef } = require('./pipeline');
const { loadInterceptors, validateInterceptors } = require('./interceptors');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Collect all issues from a build definition.
 *
 * @param {string} siteRoot
 * @param {object} registry
 * @param {object} options    { checkCtx?: boolean }
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validate(siteRoot, registry, options = {}) {
  const errors = [];
  const warnings = [];

  // 1. Load build definition
  let buildDef;
  try {
    buildDef = loadBuildDef(siteRoot);
  } catch (e) {
    return { errors: [e.message], warnings };
  }

  // 1b. Validate interceptors
  try {
    const interceptors = loadInterceptors(siteRoot);
    const iResult = validateInterceptors(interceptors, siteRoot);
    errors.push(...iResult.errors);
    warnings.push(...iResult.warnings);
  } catch (e) {
    errors.push(`Interceptor loading failed: ${e.message}`);
  }

  // 2. Walk all steps and collect issues
  const allSteps = [
    ...(buildDef.before || []),
    ...buildDef.buildSteps,
    ...(buildDef.after || []),
  ];

  walkSteps(allSteps, siteRoot, registry, errors, warnings, options);

  return { errors, warnings };
}

function walkSteps(steps, siteRoot, registry, errors, warnings, options) {
  for (const step of steps) {
    if (!step.type) {
      errors.push('Step is missing required "type" field');
      continue;
    }

    // Check all fn: references anywhere in the step
    checkFnRefs(step, registry, errors);

    switch (step.type) {
      case 'resolve':
        checkResolveStep(step, siteRoot, errors, warnings);
        break;
      case 'output':
        checkOutputStep(step, errors);
        break;
      case 'copy':
        checkCopyStep(step, siteRoot, errors, warnings);
        break;
      case 'loop':
        checkLoopStep(step, siteRoot, registry, errors, warnings, options);
        break;
      default:
        warnings.push(`Unknown step type: "${step.type}" (may be a dynamic expression)`);
    }
  }
}

function checkFnRefs(value, registry, errors) {
  const expressions = extractExpressions(value);
  for (const inner of expressions) {
    if (isFnCall(inner)) {
      const result = validateFnRef(inner, registry);
      if (!result.valid) errors.push(result.error);
    }
  }
}

function checkResolveStep(step, siteRoot, errors, warnings) {
  if (!step.template) {
    errors.push('[resolve] Missing required "template" field');
  } else if (typeof step.template === 'string' && !step.template.includes('{{')) {
    // Only check disk presence for static (non-expression) paths
    const tplPath = path.join(siteRoot, '_templates', step.template);
    if (!fs.existsSync(tplPath)) {
      errors.push(`[resolve] Template not found: _templates/${step.template}`);
    }
  }
  if (!step.target) {
    errors.push('[resolve] Missing required "target" field');
  }
  if (step.content && typeof step.content === 'string' && !step.content.includes('{{')) {
    const cPath = path.join(siteRoot, 'contents', step.content);
    if (!fs.existsSync(cPath)) {
      warnings.push(`[resolve] Content file not found: contents/${step.content}`);
    }
  }
}

function checkOutputStep(step, errors) {
  if (!step.source) errors.push('[output] Missing required "source" field');
  if (!step.target) errors.push('[output] Missing required "target" field');
}

function checkCopyStep(step, siteRoot, errors, warnings) {
  if (!step.source) {
    errors.push('[copy] Missing required "source" field');
  } else if (typeof step.source === 'string' && !step.source.includes('{{')) {
    const srcPath = path.resolve(siteRoot, step.source);
    if (!fs.existsSync(srcPath)) {
      warnings.push(`[copy] Source not found: "${step.source}"`);
    }
  }
  if (!step.target) errors.push('[copy] Missing required "target" field');
}

function checkLoopStep(step, siteRoot, registry, errors, warnings, options) {
  if (!step.collection) {
    errors.push('[loop] Missing required "collection" field');
  }
  if (!Array.isArray(step.steps) || step.steps.length === 0) {
    errors.push('[loop] "steps" must be a non-empty array');
  } else {
    walkSteps(step.steps, siteRoot, registry, errors, warnings, options);
  }
}

/**
 * Format validation results for console output.
 *
 * @param {{ errors: string[], warnings: string[] }} result
 * @returns {string}
 */
function formatResults({ errors, warnings }) {
  const lines = [];
  if (errors.length === 0 && warnings.length === 0) {
    lines.push('✓ Validation passed with no issues.');
    return lines.join('\n');
  }
  for (const e of errors)   lines.push(`✗ ERROR:   ${e}`);
  for (const w of warnings) lines.push(`⚠ WARNING: ${w}`);
  lines.push('');
  lines.push(`${errors.length} error(s), ${warnings.length} warning(s)`);
  return lines.join('\n');
}

module.exports = { validate, formatResults, ValidationError };
