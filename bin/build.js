#!/usr/bin/env node
'use strict';

const path = require('path');
const { build } = require('../src/cli/build');
const { createLogger } = require('../src/engine/logger');

const siteRoot   = process.argv[2] || '.';
const useLog     = process.argv.includes('--log');
const abs        = path.resolve(siteRoot);

let logger     = console.log;
let fileLogger = null;

if (useLog) {
  fileLogger = createLogger(abs, { echo: true });
  logger = fileLogger;
}

build(abs, { logger })
  .then(async () => {
    if (fileLogger) {
      await fileLogger.close();
      console.log(`  Log written to: ${fileLogger.logPath}`);
    }
  })
  .catch(async e => {
    if (fileLogger) logger(`✗ Build failed: ${e.message}`);
    console.error(`✗ Build failed: ${e.message}`);
    if (e.cause) console.error(`  Caused by: ${e.cause.message}`);
    if (fileLogger) await fileLogger.close().catch(() => {});
    process.exit(1);
  });
