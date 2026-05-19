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
const { loadInterceptors }  = require('../engine/interceptors');

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

  // Change into the site folder for the duration of the build so that
  // resolver functions using relative paths always work regardless of
  // where the statico-build command was invoked from.
  const originalCwd = process.cwd();
  process.chdir(abs);

  try {
    // 1. Load resolver registry
    const resolversDir = path.join(abs, '_resolvers');
    const registry = loadRegistry(resolversDir);
    log(`[statico] Loaded ${Object.keys(registry).length} resolver namespace(s)`);

    // 2. Load interceptors
    const interceptors = loadInterceptors(abs);
    log(`[statico] Loaded ${interceptors.size} interceptor(s)`);

    // 3. Seed ctx from commons.json
    const ctx = createCtx(abs);
    log(`[statico] Context seeded`);

    // 4. Load build definition
    const buildDef = loadBuildDef(abs);
    log(`[statico] Build definition loaded (${buildDef.buildSteps.length} step(s))`);

    // 5. Optionally clear _out
    const outDir = path.join(abs, '_out');
    if (options.clearOut !== false) {
      if (fs.existsSync(outDir)) {
        await fsp.rm(outDir, { recursive: true, force: true });
        log(`[statico] Cleared _out/`);
      }
      await fsp.mkdir(outDir, { recursive: true });
    }

    // 6. Run pipeline
    await runPipeline(buildDef, ctx, registry, abs, { logger: log, interceptors });

    log(`[statico] Build complete → ${outDir}`);

  } finally {
    // Always restore the original working directory.
    process.chdir(originalCwd);
  }
}

module.exports = { build };
