'use strict';

/**
 * pipeline.js
 *
 * Reads and executes a build.json file.
 *
 * Responsibilities:
 *   - Parse build.json (structural validation only)
 *   - Execute before hooks
 *   - Execute buildSteps (lazy value resolution per step)
 *   - Execute after hooks
 *   - Dispatch each step to the correct executor in steps.js
 */

const fs = require('fs');
const path = require('path');
const { resolveValue } = require('./resolver');
const { executeResolve, executeOutput, executeCopy, executeLoop, StepError } = require('./steps');

class PipelineError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PipelineError';
    if (cause) this.cause = cause;
  }
}

/**
 * Load and structurally validate build.json.
 *
 * @param {string} siteRoot
 * @returns {object}  Parsed build definition
 */
function loadBuildDef(siteRoot) {
  const buildPath = path.join(siteRoot, 'build.json');
  if (!fs.existsSync(buildPath)) {
    throw new PipelineError(`build.json not found in: ${siteRoot}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
  } catch (e) {
    throw new PipelineError(`Failed to parse build.json: ${e.message}`, e);
  }
  if (!Array.isArray(raw.buildSteps)) {
    throw new PipelineError('build.json must have a "buildSteps" array');
  }
  return raw;
}

/**
 * Execute a single step, dispatching to the correct executor.
 *
 * @param {object} step
 * @param {object} ctx
 * @param {object} registry
 * @param {string} siteRoot
 * @param {object} options
 */
async function executeStep(step, ctx, registry, siteRoot, options) {
  // Step type may itself be an expression (unusual but consistent)
  const type = resolveValue(step.type, ctx, registry);

  switch (type) {
    case 'resolve':
      await executeResolve(step, ctx, registry, siteRoot, options);
      break;
    case 'output':
      await executeOutput(step, ctx, registry, siteRoot, options);
      break;
    case 'copy':
      await executeCopy(step, ctx, registry, siteRoot, options);
      break;
    case 'loop':
      await executeLoop(step, ctx, registry, siteRoot, options, executeSteps);
      break;
    default:
      throw new StepError(type || 'unknown', `Unknown step type: "${type}"`);
  }
}

/**
 * Execute an array of steps sequentially.
 * This function is passed into executeLoop so loops can recurse.
 *
 * @param {object[]} steps
 * @param {object}   ctx
 * @param {object}   registry
 * @param {string}   siteRoot
 * @param {object}   options
 */
async function executeSteps(steps, ctx, registry, siteRoot, options) {
  for (const step of steps) {
    await executeStep(step, ctx, registry, siteRoot, options);
  }
}

/**
 * Run the full build pipeline.
 *
 * @param {object} buildDef   Parsed build.json object
 * @param {object} ctx        Initial build context (seeded from commons.json)
 * @param {object} registry   Loaded resolver registry
 * @param {string} siteRoot   Absolute path to site folder
 * @param {object} options    { logger?: fn, dryRun?: boolean }
 */
async function runPipeline(buildDef, ctx, registry, siteRoot, options = {}) {
  const log = options.logger || (() => {});

  try {
    if (Array.isArray(buildDef.before) && buildDef.before.length > 0) {
      log('Running before hooks...');
      await executeSteps(buildDef.before, ctx, registry, siteRoot, options);
    }

    log('Running buildSteps...');
    await executeSteps(buildDef.buildSteps, ctx, registry, siteRoot, options);

    if (Array.isArray(buildDef.after) && buildDef.after.length > 0) {
      log('Running after hooks...');
      await executeSteps(buildDef.after, ctx, registry, siteRoot, options);
    }
  } catch (e) {
    throw new PipelineError(`Pipeline failed: ${e.message}`, e);
  }
}

module.exports = { loadBuildDef, executeStep, executeSteps, runPipeline, PipelineError };
