'use strict';

/**
 * steps.js
 *
 * One executor function per step type: resolve, output, copy, loop.
 *
 * Each executor receives:
 *   - step:      the step definition (already structurally parsed)
 *   - ctx:       the live build context (may be mutated by resolve/loop steps)
 *   - registry:  the resolver function registry
 *   - siteRoot:  absolute path to the site folder
 *   - options:   runtime options (e.g. { dryRun: false, logger, interceptors })
 *
 * Executors are async. They return nothing; side effects are:
 *   - Mutating ctx (resolve, loop)
 *   - Writing files (output)
 *   - Copying files (copy)
 *   - Logging (all)
 * 
 * Interceptor hooks:
 *   resolve : fires before ctx is mutated; can alter or suppress the value
 *   output  : fires before file is written; can alter content or suppress write
 *   copy    : fires before each file is copied; can redirect source or suppress copy
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { interpolate, resolveValue, getByPath } = require('./resolver');
const { setByPath, loadContent, loadTemplate } = require('./context');
const { runStepInterceptors } = require('./interceptors');

class StepError extends Error {
  constructor(stepType, message, cause) {
    super(`[${stepType}] ${message}`);
    this.name = 'StepError';
    this.stepType = stepType;
    if (cause) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Interceptor helpers
// ---------------------------------------------------------------------------

/**
 * Run step interceptors and return { skip, value }.
 * Gracefully handles the case where no interceptors are loaded.
 *
 * @param {string} stepType
 * @param {object} args
 * @param {object} options
 * @returns {{ skip: boolean, value: * }}
 */
function applyInterceptors(stepType, args, options) {
  const interceptors = options.interceptors;
  if (!interceptors || interceptors.size === 0) return { skip: false, value: null };
  const tools = { log: options.logger || (() => {}) };
  return runStepInterceptors(interceptors, stepType, args, tools);
}

/**
 * Recursively copy a directory to a destination, running copy interceptors
 * against each individual file encountered. Directories are created as needed;
 * interceptors never fire on directory nodes, only on files.
 *
 * @param {string} srcDir   Absolute path to the source directory
 * @param {string} dstDir   Absolute path to the destination directory
 * @param {object} options  Runtime options, including interceptors and logger
 * @param {Function} log    Logging function
 * @returns {Promise<void>}
 */
async function copyDirWithInterceptors(srcDir, dstDir, options, log) {
  await fsp.mkdir(dstDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirWithInterceptors(src, dst, options, log);
    } else {
      await copySingleFileWithInterceptors(src, dst, options, log);
    }
  }
}

/**
 * Copy a single file to a destination, running copy interceptors before
 * the operation. Interceptors may suppress the copy (returning false),
 * allow it unchanged (returning true), or redirect it to an alternate
 * source file (returning a path string).
 *
 * @param {string}   srcPath  Absolute path to the source file
 * @param {string}   dstPath  Absolute path to the destination file
 * @param {object}   options  Runtime options, including interceptors and logger
 * @param {Function} log      Logging function
 * @returns {Promise<void>}
 */
async function copySingleFileWithInterceptors(srcPath, dstPath, options, log) {
  // Interceptor hook: fires before each file copy
  const { skip, value } = applyInterceptors('copy', {
    'source-path': srcPath,
    'target-path': dstPath,
  }, options);

  if (skip) {
    log(`  copy (intercepted/skipped): ${srcPath}`);
    return;
  }

  const effectiveSrc = (value !== null && value !== true) ? value : srcPath;

  await fsp.mkdir(path.dirname(dstPath), { recursive: true });
  await fsp.copyFile(effectiveSrc, dstPath);
  log(`  copy: ${srcPath} → ${dstPath}`);
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

/**
 * Resolve a template snippet against optional content data and store result in ctx.
 *
 * Step shape:
 * {
 *   type: "resolve",
 *   template: "partials/head.html",      // path under _templates/
 *   content:  "pieces/nocturne.json",    // optional: path under contents/
 *   target:   "pages.nocturne.head"      // dotted path into ctx where result is stored
 * }
 *
 * Before interpolating the template, the step merges:
 *   1. ctx.commons (always available)
 *   2. the loaded content data (if provided), stored at ctx.current
 * into a local resolution context. This avoids polluting the global ctx
 * with per-step ephemeral data.
 */
async function executeResolve(step, ctx, registry, siteRoot, options) {
  const log = options.logger || (() => {});

  // Resolve all step field values (they may themselves be expressions)
  const templatePath = resolveValue(step.template, ctx, registry);
  const contentPath  = step.content ? resolveValue(step.content, ctx, registry) : null;
  const target       = resolveValue(step.target, ctx, registry);

  if (!templatePath) throw new StepError('resolve', '"template" is required');
  if (!target)       throw new StepError('resolve', '"target" is required');

  // Load template
  let templateStr;
  try {
    templateStr = loadTemplate(siteRoot, templatePath);
  } catch (e) {
    throw new StepError('resolve', e.message, e);
  }

  // Optionally load content and make it available at ctx.current during interpolation
  let localCtx = ctx;
  if (contentPath) {
    let contentData;
    try {
      contentData = loadContent(siteRoot, contentPath);
    } catch (e) {
      throw new StepError('resolve', e.message, e);
    }
    // Shallow-merge: create a temporary ctx view with `current` set
    localCtx = Object.assign(Object.create(null), ctx, { current: contentData });
  }

  let result;
  try {
    result = interpolate(templateStr, localCtx, registry);
  } catch (e) {
    throw new StepError('resolve', `Interpolation failed in "${templatePath}": ${e.message}`, e);
  }

  // Interceptor hook: fires before ctx mutation
  const { skip, value } = applyInterceptors('resolve', {
    'template': templatePath,
    'value':    result,
  }, options);

  if (skip) {
    log(`  resolve (intercepted/skipped): "${templatePath}"`);
    return;
  }

  const finalValue = value !== null ? value : result;
  setByPath(ctx, target, finalValue);
  log(`  resolve: "${templatePath}" → ctx.${target}`);
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

/**
 * Write a value from ctx to a file on disk.
 *
 * Step shape:
 * {
 *   type:     "output",
 *   source:   "pages.nocturne.html",   // dotted path into ctx
 *   target:   "pieces/nocturne.html",  // relative path under _out/
 *   override: true                     // default true; false = log only
 * }
 */
async function executeOutput(step, ctx, registry, siteRoot, options) {
  const log = options.logger || (() => {});

  const source   = resolveValue(step.source, ctx, registry);
  const target   = resolveValue(step.target, ctx, registry);
  const override = step.override !== undefined
    ? resolveValue(step.override, ctx, registry)
    : true;

  if (!source) throw new StepError('output', '"source" (ctx path) is required');
  if (!target) throw new StepError('output', '"target" (output path) is required');

  const content = getByPath(ctx, source);
  if (content === undefined) {
    throw new StepError('output', `ctx path not found: "${source}"`);
  }

  const outDir  = path.join(siteRoot, '_out');
  const outPath = path.join(outDir, target);

  // Safety check: never write outside _out
  if (!outPath.startsWith(outDir + path.sep) && outPath !== outDir) {
    throw new StepError('output', `Target path escapes _out/: "${target}"`);
  }

  if (!override) {
    log(`  output (dry): ctx.${source} → _out/${target}`);
    return;
  }

  // Interceptor hook: fires before file write
  const { skip, value } = applyInterceptors('output', {
    'content':   String(content),
    'file-path': outPath,
  }, options);

  if (skip) {
    log(`  output (intercepted/skipped): _out/${target}`);
    return;
  }

  const finalContent = (value !== null && value !== true) ? value : String(content);

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, finalContent, 'utf8');
  log(`  output: ctx.${source} → _out/${target}`);
}

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

/**
 * Copy a file or directory from within the site folder to _out/.
 *
 * Step shape:
 * {
 *   type:     "copy",
 *   source:   "assets/images/cover.jpg",  // relative to site root
 *   target:   "assets/images/cover.jpg",  // relative to _out/
 *   override: true
 * }
 */
async function executeCopy(step, ctx, registry, siteRoot, options) {
  const log = options.logger || (() => {});

  const source   = resolveValue(step.source, ctx, registry);
  const target   = resolveValue(step.target, ctx, registry);
  const override = step.override !== undefined
    ? resolveValue(step.override, ctx, registry)
    : true;

  if (!source) throw new StepError('copy', '"source" is required');
  if (!target) throw new StepError('copy', '"target" is required');

  const srcPath = path.resolve(siteRoot, source);
  const outDir  = path.join(siteRoot, '_out');
  const dstPath = path.resolve(outDir, target);

  // Safety: source must stay inside site root
  if (!srcPath.startsWith(siteRoot + path.sep) && srcPath !== siteRoot) {
    throw new StepError('copy', `Source path escapes site root: "${source}"`);
  }
  // Safety: destination must stay inside _out
  if (!dstPath.startsWith(outDir + path.sep) && dstPath !== outDir) {
    throw new StepError('copy', `Target path escapes _out/: "${target}"`);
  }

  if (!override) {
    log(`  copy (dry): ${source} → _out/${target}`);
    return;
  }

  if (!fs.existsSync(srcPath)) {
    throw new StepError('copy', `Source not found: "${source}"`);
  }

  // For directory copies, iterate files individually so interceptors can act per-file
  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    await copyDirWithInterceptors(srcPath, dstPath, options, log);
  } else {
    await copySingleFileWithInterceptors(srcPath, dstPath, options, log);
  }
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------

/**
 * Iterate over a collection, executing a sub-pipeline per item.
 *
 * Step shape:
 * {
 *   type:       "loop",
 *   collection: "{{commons.pieces}}",  // expression resolving to an array
 *   as:         "item",                // name under which each element is available in ctx
 *   steps:      [ ... ],               // same structure as buildSteps
 *   parallel:   false                  // default false
 * }
 *
 * Each iteration gets ctx.${as} set to the current element before its steps run.
 * After the iteration, ctx.${as} is removed to avoid leakage.
 */
async function executeLoop(step, ctx, registry, siteRoot, options, executeStepsFn) {
  const log = options.logger || (() => {});

  const collection = resolveValue(step.collection, ctx, registry);
  const as         = step.as || 'item';
  const parallel   = step.parallel === true;

  if (!Array.isArray(collection)) {
    throw new StepError('loop', `"collection" must resolve to an Array, got: ${typeof collection}`);
  }
  if (!Array.isArray(step.steps) || step.steps.length === 0) {
    throw new StepError('loop', '"steps" must be a non-empty array');
  }

  log(`  loop: ${collection.length} item(s), parallel=${parallel}`);

  const runIteration = async (element, index) => {
    setByPath(ctx, as, element);
    log(`    loop[${index}]: ${as} = ${JSON.stringify(element).slice(0, 60)}`);
    await executeStepsFn(step.steps, ctx, registry, siteRoot, options);
  };

  if (parallel) {
    await Promise.all(collection.map((element, i) => runIteration(element, i)));
  } else {
    for (let i = 0; i < collection.length; i++) {
      await runIteration(collection[i], i);
    }
  }

  // Clean up loop variable from ctx
  delete ctx[as];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  executeResolve,
  executeOutput,
  executeCopy,
  executeLoop,
  StepError,
};
