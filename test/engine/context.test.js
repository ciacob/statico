'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp  = require('fs/promises');
const path = require('path');
const os   = require('os');

const { createCtx, setByPath, loadContent, loadTemplate, ContextError } = require('../../src/engine/context');

let siteRoot;

before(async () => {
  siteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-ctx-'));
  await fsp.mkdir(path.join(siteRoot, 'contents'), { recursive: true });
  await fsp.mkdir(path.join(siteRoot, '_templates'), { recursive: true });
  await fsp.writeFile(
    path.join(siteRoot, 'contents', 'commons.json'),
    JSON.stringify({ site: { name: 'Test' } }),
    'utf8'
  );
  await fsp.writeFile(
    path.join(siteRoot, 'contents', 'piece.json'),
    JSON.stringify({ title: 'Nocturne', lang: 'en' }),
    'utf8'
  );
  await fsp.writeFile(
    path.join(siteRoot, '_templates', 'head.html'),
    '<title>{{commons.site.name}}</title>',
    'utf8'
  );
});

after(async () => {
  await fsp.rm(siteRoot, { recursive: true, force: true });
});

describe('setByPath', () => {
  it('sets a top-level key', () => {
    const obj = {};
    setByPath(obj, 'key', 'val');
    assert.equal(obj.key, 'val');
  });
  it('creates intermediate objects', () => {
    const obj = {};
    setByPath(obj, 'a.b.c', 42);
    assert.equal(obj.a.b.c, 42);
  });
  it('overwrites existing value', () => {
    const obj = { x: 1 };
    setByPath(obj, 'x', 2);
    assert.equal(obj.x, 2);
  });
  it('throws on invalid path', () => {
    assert.throws(() => setByPath({}, '', 'v'), ContextError);
  });
  it('throws when intermediate segment is not an object', () => {
    const obj = { a: 42 };
    assert.throws(() => setByPath(obj, 'a.b', 'val'), ContextError);
  });
});

describe('createCtx', () => {
  it('seeds ctx.commons from commons.json', () => {
    const ctx = createCtx(siteRoot);
    assert.equal(ctx.commons.site.name, 'Test');
  });
  it('returns empty object when no commons.json', async () => {
    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-empty-'));
    try {
      const ctx = createCtx(empty);
      assert.deepEqual(ctx, {});
    } finally {
      await fsp.rm(empty, { recursive: true, force: true });
    }
  });
});

describe('loadContent', () => {
  it('loads and parses a JSON content file', () => {
    const data = loadContent(siteRoot, 'piece.json');
    assert.equal(data.title, 'Nocturne');
  });
  it('throws ContextError for missing file', () => {
    assert.throws(() => loadContent(siteRoot, 'missing.json'), ContextError);
  });
});

describe('loadTemplate', () => {
  it('loads a template file as a string', () => {
    const tpl = loadTemplate(siteRoot, 'head.html');
    assert.ok(tpl.includes('{{commons.site.name}}'));
  });
  it('throws ContextError for missing template', () => {
    assert.throws(() => loadTemplate(siteRoot, 'missing.html'), ContextError);
  });
});
