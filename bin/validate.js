#!/usr/bin/env node
'use strict';

const path = require('path');
const { validate, formatResults } = require('../src/engine/validator');
const { loadRegistry } = require('../src/engine/registry');

const siteRoot  = process.argv[2] || '.';
const checkCtx  = process.argv.includes('--check-ctx');
const abs       = path.resolve(siteRoot);

let registry = {};
try {
  registry = loadRegistry(require('path').join(abs, '_resolvers'));
} catch (e) {
  console.error(`✗ Failed to load resolvers: ${e.message}`);
  process.exit(1);
}

const result = validate(abs, registry, { checkCtx });
console.log(formatResults(result));

if (result.errors.length > 0) process.exit(1);
