#!/usr/bin/env node
'use strict';

const { initSite } = require('../src/init/init');

const sitePath = process.argv[2];

if (!sitePath) {
  console.error('Usage: statico-init <site-folder>');
  process.exit(1);
}

initSite(sitePath)
  .then(abs => {
    console.log(`✓ Site scaffolded at: ${abs}`);
    console.log(`  Next steps:`);
    console.log(`    1. cd ${sitePath}`);
    console.log(`    2. Edit contents/commons.json`);
    console.log(`    3. Add templates to _templates/`);
    console.log(`    4. Write your build.json`);
    console.log(`    5. statico-validate . && statico-build .`);
  })
  .catch(e => {
    console.error(`✗ Init failed: ${e.message}`);
    process.exit(1);
  });
