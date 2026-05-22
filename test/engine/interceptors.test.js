'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp  = require('fs/promises');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const {
  loadInterceptors,
  validateInterceptors,
  validateConfig,
  applyConfig,
  runStepInterceptors,
  InterceptorError,
} = require('../../src/engine/interceptors');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

before(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-int-'));
});

after(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function makeInterceptor(baseDir, folderName, defOverrides, transformSrc) {
  const dir = path.join(baseDir, '_interceptors', folderName);
  await fsp.mkdir(dir, { recursive: true });

  const def = Object.assign({
    name: `test.${folderName}`,
    trigger: { stepType: 'output' },
  }, defOverrides);

  await fsp.writeFile(path.join(dir, 'interceptor.json'), JSON.stringify(def), 'utf8');
  await fsp.writeFile(
    path.join(dir, 'transformation.js'),
    transformSrc || `module.exports = { transform(args, output, tools) { output.response = true; } };`,
    'utf8'
  );
  return dir;
}

// ---------------------------------------------------------------------------
// loadInterceptors
// ---------------------------------------------------------------------------

describe('loadInterceptors', () => {
  it('returns empty map when _interceptors dir absent', () => {
    const reg = loadInterceptors(tmpDir);
    assert.equal(reg.size, 0);
  });

  it('loads a valid interceptor', async () => {
    const site = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-int-load-'));
    try {
      await makeInterceptor(site, 'alpha', { name: 'test.alpha', stepType: 'output' });
      const reg = loadInterceptors(site);
      assert.equal(reg.size, 1);
      assert.ok(reg.has('test.alpha'));
      assert.equal(typeof reg.get('test.alpha').transformFn, 'function');
    } finally {
      await fsp.rm(site, { recursive: true, force: true });
    }
  });

  it('throws if transformation.js has no transform export', async () => {
    const site = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-int-bad-'));
    try {
      await makeInterceptor(site, 'bad', {}, `module.exports = {};`);
      assert.throws(() => loadInterceptors(site), InterceptorError);
    } finally {
      await fsp.rm(site, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// validateInterceptors
// ---------------------------------------------------------------------------

describe('validateInterceptors', () => {
  it('passes clean registry', async () => {
    const site = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-int-val-'));
    try {
      await makeInterceptor(site, 'clean', { name: 'test.clean', stepType: 'copy' });
      const reg = loadInterceptors(site);
      const { errors } = validateInterceptors(reg, site);
      assert.equal(errors.length, 0);
    } finally {
      await fsp.rm(site, { recursive: true, force: true });
    }
  });

  it('rejects name starting with statico', async () => {
    const site = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-int-res-'));
    try {
      await makeInterceptor(site, 'reserved', { name: 'statico.something', stepType: 'output' });
      const reg = loadInterceptors(site);
      const { errors } = validateInterceptors(reg, site);
      assert.ok(errors.some(e => e.includes('statico')));
    } finally {
      await fsp.rm(site, { recursive: true, force: true });
    }
  });

  it('rejects step interceptor missing stepType', async () => {
    const site = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-int-nst-'));
    try {
      await makeInterceptor(site, 'nostep', { name: 'test.nostep', trigger: { type: 'step' } });
      const reg = loadInterceptors(site);
      const { errors } = validateInterceptors(reg, site);
      assert.ok(errors.some(e => e.includes('stepType')));
    } finally {
      await fsp.rm(site, { recursive: true, force: true });
    }
  });

  it('rejects missing stepType', async () => {
    const site = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-int-trg-'));
    try {
      await makeInterceptor(site, 'badtype', { name: 'test.badtype' });
      const reg = loadInterceptors(site);
      const { errors } = validateInterceptors(reg, site);
      assert.ok(errors.some(e => e.includes('stepType')));
    } finally {
      await fsp.rm(site, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runStepInterceptors
// ---------------------------------------------------------------------------

describe('runStepInterceptors', () => {
  it('returns skip:false, value:null when no interceptors match', () => {
    const reg = new Map();
    const result = runStepInterceptors(reg, 'output', { 'content': 'hi', 'file-path': '/x' }, {});
    assert.equal(result.skip, false);
    assert.equal(result.value, null);
  });

  it('passes through when interceptor returns true', () => {
    const reg = new Map([['test.pass', {
      definition: { name: 'test.pass', stepType: 'output' },
      transformFn: (args, output) => { output.response = true; },
    }]]);
    const result = runStepInterceptors(reg, 'output', { 'content': 'hello', 'file-path': '/f' }, {});
    assert.equal(result.skip, false);
    assert.equal(result.value, null);
  });

  it('returns skip:true when interceptor returns false', () => {
    const reg = new Map([['test.deny', {
      definition: { name: 'test.deny', stepType: 'copy' },
      transformFn: (args, output) => { output.response = false; },
    }]]);
    const result = runStepInterceptors(reg, 'copy', { 'source-path': '/a', 'target-path': '/b' }, {});
    assert.equal(result.skip, true);
  });

  it('returns alternate value when interceptor substitutes', () => {
    const reg = new Map([['test.alter', {
      definition: { name: 'test.alter', stepType: 'output' },
      transformFn: (args, output) => { output.response = { 'content': 'altered', 'file-path': args['file-path'] }; },
    }]]);
    const result = runStepInterceptors(reg, 'output', { 'content': 'original', 'file-path': '/f' }, {});
    assert.equal(result.skip, false);
    assert.equal(result.value['content'], 'altered');
  });

  it('ignores interceptors of a different stepType', () => {
    const reg = new Map([['test.copy', {
      definition: { name: 'test.copy', stepType: 'copy' },
      transformFn: (args, output) => { output.response = false; },
    }]]);
    const result = runStepInterceptors(reg, 'output', { 'content': 'x', 'file-path': '/f' }, {});
    assert.equal(result.skip, false);
  });

  it('throws InterceptorError if transform throws', () => {
    const reg = new Map([['test.throw', {
      definition: { name: 'test.throw', stepType: 'resolve' },
      transformFn: () => { throw new Error('boom'); },
    }]]);
    assert.throws(
      () => runStepInterceptors(reg, 'resolve', { 'template': 'x', 'value': 'y' }, {}),
      InterceptorError
    );
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  function makeReg(...entries) {
    return new Map(entries.map(([name, stepType]) => [name, {
      definition: { name, stepType },
      transformFn: () => {},
    }]));
  }

  it('passes a valid config', () => {
    const reg = makeReg(['test.a', 'output'], ['test.b', 'output']);
    const config = { stepInterceptors: { order: { output: ['test.a', 'test.b'] } } };
    const errors = validateConfig(config, reg);
    assert.equal(errors.length, 0);
  });

  it('rejects missing stepInterceptors root', () => {
    const errors = validateConfig({}, new Map());
    assert.ok(errors.some(e => e.includes('stepInterceptors')));
  });

  it('rejects missing order node', () => {
    const errors = validateConfig({ stepInterceptors: {} }, new Map());
    assert.ok(errors.some(e => e.includes('order')));
  });

  it('rejects empty order object', () => {
    const errors = validateConfig({ stepInterceptors: { order: {} } }, new Map());
    assert.ok(errors.some(e => e.includes('at least one')));
  });

  it('rejects invalid step type key', () => {
    const errors = validateConfig(
      { stepInterceptors: { order: { loop: ['test.a'] } } },
      new Map()
    );
    assert.ok(errors.some(e => e.includes('loop')));
  });

  it('rejects duplicate names within a list', () => {
    const reg = makeReg(['test.a', 'output']);
    const errors = validateConfig(
      { stepInterceptors: { order: { output: ['test.a', 'test.a'] } } },
      reg
    );
    assert.ok(errors.some(e => e.includes('duplicate')));
  });

  it('rejects reference to unknown interceptor', () => {
    const errors = validateConfig(
      { stepInterceptors: { order: { output: ['unknown.interceptor'] } } },
      new Map()
    );
    assert.ok(errors.some(e => e.includes('unknown interceptor')));
  });

  it('rejects reference to interceptor of wrong stepType', () => {
    const reg = makeReg(['test.copy', 'copy']);
    const errors = validateConfig(
      { stepInterceptors: { order: { output: ['test.copy'] } } },
      reg
    );
    assert.ok(errors.some(e => e.includes('test.copy')));
  });

  it('accepts partial lists (not exhaustive)', () => {
    const reg = makeReg(['test.a', 'output'], ['test.b', 'output'], ['test.c', 'output']);
    const errors = validateConfig(
      { stepInterceptors: { order: { output: ['test.c', 'test.a'] } } },
      reg
    );
    assert.equal(errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// applyConfig
// ---------------------------------------------------------------------------

describe('applyConfig', () => {
  function makeReg(...names) {
    return new Map(names.map(name => [name, {
      definition: { name, trigger: { stepType: 'output' } },
      transformFn: () => {},
    }]));
  }

  it('returns registry unchanged when config is null', () => {
    const reg = makeReg('a', 'b', 'c');
    const result = applyConfig(reg, null);
    assert.deepEqual([...result.keys()], ['a', 'b', 'c']);
  });

  it('reorders listed interceptors', () => {
    const reg = makeReg('a', 'b', 'c');
    const config = { stepInterceptors: { order: { output: ['c', 'a', 'b'] } } };
    const result = applyConfig(reg, config);
    assert.deepEqual([...result.keys()], ['c', 'a', 'b']);
  });

  it('puts unlisted interceptors after listed ones', () => {
    const reg = makeReg('a', 'b', 'c', 'd');
    const config = { stepInterceptors: { order: { output: ['c', 'a'] } } };
    const result = applyConfig(reg, config);
    const keys = [...result.keys()];
    assert.equal(keys[0], 'c');
    assert.equal(keys[1], 'a');
    assert.ok(keys.includes('b'));
    assert.ok(keys.includes('d'));
  });

  it('preserves all entries after reordering', () => {
    const reg = makeReg('a', 'b', 'c');
    const config = { stepInterceptors: { order: { output: ['b'] } } };
    const result = applyConfig(reg, config);
    assert.equal(result.size, 3);
  });
});
