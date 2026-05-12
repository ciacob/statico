'use strict';

/**
 * build.js  (src/cli/build.js)
 *
 * Wires together all engine modules to execute a full site build.
 * Called by bin/build.js; also importable for programmatic use.
 */

const fsp = require('fs/promises');
const fs  = require('fs');
const path = require('path');

const { loadRegistry }  = require('../engine/registry');
const { createCtx }     = require('../engine/context');
const { loadBuildDef, runPipeline } = require('../engine/pipeline');

/**
 * Run a full build for the given site root.
 *
 * @param {string}   siteRoot   Absolute path to the site folder
 * @param {object}   options    { logger?, clearOut? }
 */
async function build(siteRoot, options = {}) {
  const log = options.logger || console.log;
  const abs = path.resolve(siteRoot);

  log(`[statico] Building site at: ${abs}`);

  // 1. Load resolver registry
  const resolversDir = path.join(abs, '_resolvers');
  const registry = loadRegistry(resolversDir);
  log(`[statico] Loaded ${Object.keys(registry).length} resolver namespace(s)`);

  // 2. Seed ctx from commons.json
  const ctx = createCtx(abs);
  log(`[statico] Context seeded`);

  // 3. Load build definition
  const buildDef = loadBuildDef(abs);
  log(`[statico] Build definition loaded (${buildDef.buildSteps.length} step(s))`);

  // 4. Optionally clear _out
  const outDir = path.join(abs, '_out');
  if (options.clearOut !== false) {
    if (fs.existsSync(outDir)) {
      await fsp.rm(outDir, { recursive: true, force: true });
      log(`[statico] Cleared _out/`);
    }
    await fsp.mkdir(outDir, { recursive: true });
  }

  // 5. Run pipeline
  await runPipeline(buildDef, ctx, registry, abs, { logger: log });

  log(`[statico] Build complete → ${outDir}`);
}

module.exports = { build };
