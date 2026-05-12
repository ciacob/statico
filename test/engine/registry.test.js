'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const os   = require('os');

const { loadRegistry, listFunctions, RegistryError } = require('../../src/engine/registry');

let tmpDir;

before(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-reg-'));
});

after(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function writeResolver(filename, content) {
  const dir = path.join(tmpDir, filename.replace(/[^/]+$/, ''));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(tmpDir, filename), content, 'utf8');
}

describe('loadRegistry', () => {
  it('returns empty object when resolvers dir does not exist', () => {
    const r = loadRegistry(path.join(tmpDir, 'nonexistent'));
    assert.deepEqual(r, {});
  });

  it('loads a valid resolver file', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-reg2-'));
    try {
      await fsp.writeFile(
        path.join(dir, 'utils.js'),
        `module.exports = { utils: { greet: () => 'hi' } };`,
        'utf8'
      );
      const reg = loadRegistry(dir);
      assert.ok(reg.utils);
      assert.equal(typeof reg.utils.greet, 'function');
      assert.equal(reg.utils.greet(), 'hi');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('throws on namespace collision across files', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-reg3-'));
    try {
      await fsp.writeFile(path.join(dir, 'a.js'), `module.exports = { utils: { fn: () => 1 } };`, 'utf8');
      await fsp.writeFile(path.join(dir, 'b.js'), `module.exports = { utils: { fn: () => 2 } };`, 'utf8');
      assert.throws(() => loadRegistry(dir), RegistryError);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when resolver does not export a plain object', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-reg4-'));
    try {
      await fsp.writeFile(path.join(dir, 'bad.js'), `module.exports = 'not an object';`, 'utf8');
      assert.throws(() => loadRegistry(dir), RegistryError);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when namespace value is not an object', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-reg5-'));
    try {
      await fsp.writeFile(path.join(dir, 'bad.js'), `module.exports = { utils: 42 };`, 'utf8');
      assert.throws(() => loadRegistry(dir), RegistryError);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('skips files prefixed with _', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-reg6-'));
    try {
      await fsp.writeFile(path.join(dir, '_ignored.js'), `module.exports = { bad: { fn: () => {} } };`, 'utf8');
      const reg = loadRegistry(dir);
      assert.equal(Object.keys(reg).length, 0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('listFunctions', () => {
  it('lists all namespace.fn strings', () => {
    const registry = { utils: { a: () => {}, b: () => {} }, fmt: { x: () => {} } };
    const list = listFunctions(registry);
    assert.ok(list.includes('utils.a'));
    assert.ok(list.includes('utils.b'));
    assert.ok(list.includes('fmt.x'));
    assert.equal(list.length, 3);
  });
});
