'use strict';

/**
 * pipeline.test.js
 *
 * Integration tests: spin up a minimal site on disk, run the full build,
 * assert output files exist with correct content.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp  = require('fs/promises');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { build } = require('../../src/cli/build');

let siteRoot;

before(async () => {
  siteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-pipeline-'));

  // Structure
  for (const d of ['_templates', '_resolvers', '_out', 'contents', 'assets/img']) {
    await fsp.mkdir(path.join(siteRoot, d), { recursive: true });
  }

  // commons.json
  await fsp.writeFile(
    path.join(siteRoot, 'contents', 'commons.json'),
    JSON.stringify({ site: { name: 'Portfolio', lang: 'en' }, pieces: [
      { id: 'nocturne', title: 'Nocturne' },
      { id: 'sonata',   title: 'Sonata'   },
    ]}),
    'utf8'
  );

  // A piece content file
  await fsp.writeFile(
    path.join(siteRoot, 'contents', 'nocturne.json'),
    JSON.stringify({ title: 'Nocturne No.1', summary: 'A quiet piece.' }),
    'utf8'
  );

  // A resolver
  await fsp.writeFile(
    path.join(siteRoot, '_resolvers', 'utils.js'),
    `module.exports = { utils: {
      upper: s => s.toUpperCase(),
      buildDate: () => '2024-01-01',
    }};`,
    'utf8'
  );

  // Templates
  await fsp.writeFile(
    path.join(siteRoot, '_templates', 'site-name.html'),
    '<span>{{commons.site.name}}</span>',
    'utf8'
  );
  await fsp.writeFile(
    path.join(siteRoot, '_templates', 'piece.html'),
    '<article><h1>{{current.title}}</h1><p>{{current.summary}}</p></article>',
    'utf8'
  );
  await fsp.writeFile(
    path.join(siteRoot, '_templates', 'index.html'),
    '<html><body>{{partials.siteName}}{{fn:utils.buildDate()}}</body></html>',
    'utf8'
  );

  // A static asset
  await fsp.writeFile(path.join(siteRoot, 'assets', 'img', 'logo.png'), 'fake-png', 'utf8');

  // build.json
  const buildDef = {
    buildSteps: [
      {
        type: 'resolve',
        template: 'site-name.html',
        target: 'partials.siteName',
      },
      {
        type: 'resolve',
        template: 'piece.html',
        content: 'nocturne.json',
        target: 'pages.nocturne',
      },
      {
        type: 'resolve',
        template: 'index.html',
        target: 'pages.index',
      },
      {
        type: 'output',
        source: 'pages.index',
        target: 'index.html',
        override: true,
      },
      {
        type: 'output',
        source: 'pages.nocturne',
        target: 'pieces/nocturne.html',
        override: true,
      },
      {
        type: 'copy',
        source: 'assets/img/logo.png',
        target: 'assets/img/logo.png',
        override: true,
      },
    ],
  };

  await fsp.writeFile(
    path.join(siteRoot, 'build.json'),
    JSON.stringify(buildDef, null, 2),
    'utf8'
  );
});

after(async () => {
  await fsp.rm(siteRoot, { recursive: true, force: true });
});

describe('full pipeline build', () => {
  it('runs without error', async () => {
    await build(siteRoot, { logger: () => {}, clearOut: true });
  });

  it('writes index.html with interpolated content', async () => {
    const content = await fsp.readFile(path.join(siteRoot, '_out', 'index.html'), 'utf8');
    assert.ok(content.includes('<span>Portfolio</span>'), 'site name present');
    assert.ok(content.includes('2024-01-01'), 'fn: result present');
  });

  it('writes piece page with content data', async () => {
    const content = await fsp.readFile(
      path.join(siteRoot, '_out', 'pieces', 'nocturne.html'),
      'utf8'
    );
    assert.ok(content.includes('Nocturne No.1'));
    assert.ok(content.includes('A quiet piece.'));
  });

  it('copies asset file', async () => {
    const exists = fs.existsSync(path.join(siteRoot, '_out', 'assets', 'img', 'logo.png'));
    assert.ok(exists);
  });
});

describe('loop step', () => {
  it('generates a page per item in collection', async () => {
    const loopSite = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-loop-'));
    try {
      for (const d of ['_templates', '_resolvers', '_out', 'contents']) {
        await fsp.mkdir(path.join(loopSite, d), { recursive: true });
      }

      await fsp.writeFile(
        path.join(loopSite, 'contents', 'commons.json'),
        JSON.stringify({ pieces: [{ slug: 'a', title: 'Alpha' }, { slug: 'b', title: 'Beta' }] }),
        'utf8'
      );
      await fsp.writeFile(
        path.join(loopSite, '_templates', 'piece.html'),
        '<h1>{{item.title}}</h1>',
        'utf8'
      );
      await fsp.writeFile(
        path.join(loopSite, 'build.json'),
        JSON.stringify({
          buildSteps: [{
            type: 'loop',
            collection: '{{commons.pieces}}',
            as: 'item',
            steps: [
              {
                type: 'resolve',
                template: 'piece.html',
                target: 'pages.current',
              },
              {
                type: 'output',
                source: 'pages.current',
                target: '{{fn:utils.outPath({{item.slug}})}}',
                override: true,
              },
            ],
          }],
        }),
        'utf8'
      );
      await fsp.writeFile(
        path.join(loopSite, '_resolvers', 'utils.js'),
        `module.exports = { utils: {
          outPath: slug => 'pieces/' + slug + '.html',
        }};`,
        'utf8'
      );

      await build(loopSite, { logger: () => {}, clearOut: true });

      const a = await fsp.readFile(path.join(loopSite, '_out', 'pieces', 'a.html'), 'utf8');
      const b = await fsp.readFile(path.join(loopSite, '_out', 'pieces', 'b.html'), 'utf8');
      assert.ok(a.includes('Alpha'));
      assert.ok(b.includes('Beta'));
    } finally {
      await fsp.rm(loopSite, { recursive: true, force: true });
    }
  });
});

describe('output step safety', () => {
  it('refuses to write outside _out/', async () => {
    const badSite = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-bad-'));
    try {
      for (const d of ['_templates', '_out', 'contents']) {
        await fsp.mkdir(path.join(badSite, d), { recursive: true });
      }
      await fsp.writeFile(
        path.join(badSite, 'contents', 'commons.json'),
        '{}', 'utf8'
      );
      await fsp.writeFile(
        path.join(badSite, '_templates', 't.html'),
        'hello', 'utf8'
      );
      await fsp.writeFile(
        path.join(badSite, 'build.json'),
        JSON.stringify({ buildSteps: [
          { type: 'resolve', template: 't.html', target: 'x' },
          { type: 'output', source: 'x', target: '../escape.html', override: true },
        ]}),
        'utf8'
      );
      await assert.rejects(
        () => build(badSite, { logger: () => {}, clearOut: true }),
        /escape/i
      );
    } finally {
      await fsp.rm(badSite, { recursive: true, force: true });
    }
  });
});
