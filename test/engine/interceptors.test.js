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
  runStepInterceptors,
  runExplicitInterceptor,
  resolveExplicitInterceptors,
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
    trigger: { type: 'step', stepType: 'output' },
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
      await makeInterceptor(site, 'alpha', { name: 'test.alpha', trigger: { type: 'step', stepType: 'output' } });
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
      await makeInterceptor(site, 'clean', { name: 'test.clean', trigger: { type: 'step', stepType: 'copy' } });
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
      await makeInterceptor(site, 'reserved', { name: 'statico.something', trigger: { type: 'step', stepType: 'output' } });
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

  it('rejects interceptBy reference to unknown interceptor', async () => {
    const site = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-int-ref-'));
    try {
      await fsp.mkdir(path.join(site, '_interceptors'), { recursive: true });
      await fsp.mkdir(path.join(site, 'contents'), { recursive: true });
      await fsp.writeFile(
        path.join(site, 'contents', 'commons.json'),
        JSON.stringify({ field: { interceptBy: 'nonexistent.interceptor' } }),
        'utf8'
      );
      const reg = loadInterceptors(site);
      const { errors } = validateInterceptors(reg, site);
      assert.ok(errors.some(e => e.includes('nonexistent.interceptor')));
    } finally {
      await fsp.rm(site, { recursive: true, force: true });
    }
  });

  it('rejects interceptBy when no _interceptors folder exists', async () => {
    const site = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-int-nof-'));
    try {
      await fsp.mkdir(path.join(site, 'contents'), { recursive: true });
      await fsp.writeFile(
        path.join(site, 'contents', 'commons.json'),
        JSON.stringify({ field: { interceptBy: 'some.interceptor' } }),
        'utf8'
      );
      const reg = loadInterceptors(site);
      const { errors } = validateInterceptors(reg, site);
      assert.ok(errors.some(e => e.includes('interceptBy')));
    } finally {
      await fsp.rm(site, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runStepInterceptors
// ---------------------------------------------------------------------------

describe('runStepInterceptors', () => {
  function makeRegistry(name, stepType, transformSrc) {
    const fn = new Function(
      'require', 'module', 'exports',
      `(function(){ ${transformSrc} })()`
    );
    const mod = { exports: {} };
    // simpler: just eval the transform inline
    const transformFn = eval(`(${transformSrc})`);
    return new Map([[name, {
      definition: { name, trigger: { type: 'step', stepType } },
      transformFn,
    }]]);
  }

  it('returns skip:false, value:null when no interceptors match', () => {
    const reg = new Map();
    const result = runStepInterceptors(reg, 'output', { 'content': 'hi', 'file-path': '/x' }, {});
    assert.equal(result.skip, false);
    assert.equal(result.value, null);
  });

  it('passes through when interceptor returns true', () => {
    const reg = new Map([['test.pass', {
      definition: { name: 'test.pass', trigger: { type: 'step', stepType: 'output' } },
      transformFn: (args, output) => { output.response = true; },
    }]]);
    const result = runStepInterceptors(reg, 'output', { 'content': 'hello', 'file-path': '/f' }, {});
    assert.equal(result.skip, false);
    assert.equal(result.value, null);
  });

  it('returns skip:true when interceptor returns false', () => {
    const reg = new Map([['test.deny', {
      definition: { name: 'test.deny', trigger: { type: 'step', stepType: 'copy' } },
      transformFn: (args, output) => { output.response = false; },
    }]]);
    const result = runStepInterceptors(reg, 'copy', { 'source-path': '/a', 'target-path': '/b' }, {});
    assert.equal(result.skip, true);
  });

  it('returns alternate value when interceptor substitutes', () => {
    const reg = new Map([['test.alter', {
      definition: { name: 'test.alter', trigger: { type: 'step', stepType: 'output' } },
      transformFn: (args, output) => { output.response = { 'content': 'altered', 'file-path': args['file-path'] }; },
    }]]);
    const result = runStepInterceptors(reg, 'output', { 'content': 'original', 'file-path': '/f' }, {});
    assert.equal(result.skip, false);
    assert.equal(result.value['content'], 'altered');
  });

  it('ignores interceptors of a different stepType', () => {
    const reg = new Map([['test.copy', {
      definition: { name: 'test.copy', trigger: { type: 'step', stepType: 'copy' } },
      transformFn: (args, output) => { output.response = false; },
    }]]);
    // Running for 'output' — copy interceptor should not fire
    const result = runStepInterceptors(reg, 'output', { 'content': 'x', 'file-path': '/f' }, {});
    assert.equal(result.skip, false);
  });

  it('throws InterceptorError if transform throws', () => {
    const reg = new Map([['test.throw', {
      definition: { name: 'test.throw', trigger: { type: 'step', stepType: 'resolve' } },
      transformFn: () => { throw new Error('boom'); },
    }]]);
    assert.throws(
      () => runStepInterceptors(reg, 'resolve', { 'template': 'x', 'value': 'y' }, {}),
      InterceptorError
    );
  });
});

// ---------------------------------------------------------------------------
// resolveExplicitInterceptors
// ---------------------------------------------------------------------------

describe('resolveExplicitInterceptors', () => {
  const registry = new Map([['test.upper', {
    definition: { name: 'test.upper', trigger: { type: 'explicit' } },
    transformFn: (args, output) => {
      output.response = (args['text'] || '').toUpperCase();
    },
  }]]);

  it('replaces interceptBy node with response value', () => {
    const input = { interceptBy: 'test.upper', '@text': 'hello' };
    const result = resolveExplicitInterceptors(input, registry);
    assert.equal(result, 'HELLO');
  });

  it('recurses into nested objects', () => {
    const input = { outer: { interceptBy: 'test.upper', '@text': 'world' } };
    const result = resolveExplicitInterceptors(input, registry);
    assert.equal(result.outer, 'WORLD');
  });

  it('recurses into arrays', () => {
    const input = [{ interceptBy: 'test.upper', '@text': 'a' }, 'plain'];
    const result = resolveExplicitInterceptors(input, registry);
    assert.equal(result[0], 'A');
    assert.equal(result[1], 'plain');
  });

  it('leaves non-interceptor nodes untouched', () => {
    const input = { title: 'hello', count: 42 };
    const result = resolveExplicitInterceptors(input, registry);
    assert.deepEqual(result, input);
  });

  it('throws for unknown interceptor name', () => {
    const input = { interceptBy: 'test.nonexistent' };
    assert.throws(() => resolveExplicitInterceptors(input, registry), InterceptorError);
  });

  it('throws when explicitly triggering a step interceptor', () => {
    const stepReg = new Map([['test.step', {
      definition: { name: 'test.step', trigger: { type: 'step', stepType: 'output' } },
      transformFn: (args, output) => { output.response = true; },
    }]]);
    const input = { interceptBy: 'test.step' };
    assert.throws(() => resolveExplicitInterceptors(input, stepReg), InterceptorError);
  });
});


// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  function makeReg(...entries) {
    return new Map(entries.map(([name, stepType]) => [name, {
      definition: { name, trigger: { type: 'step', stepType } },
      transformFn: () => {},
    }]));
  }

  it('passes a valid config', () => {
    const reg = makeReg(['test.a', 'output'], ['test.b', 'output']);
    const config = { stepInterceptors: { order: { output: ['test.a', 'test.b'] } } };
    const { validateConfig } = require('../../src/engine/interceptors');
    const errors = validateConfig(config, reg);
    assert.equal(errors.length, 0);
  });

  it('rejects missing stepInterceptors root', () => {
    const { validateConfig } = require('../../src/engine/interceptors');
    const errors = validateConfig({}, new Map());
    assert.ok(errors.some(e => e.includes('stepInterceptors')));
  });

  it('rejects missing order node', () => {
    const { validateConfig } = require('../../src/engine/interceptors');
    const errors = validateConfig({ stepInterceptors: {} }, new Map());
    assert.ok(errors.some(e => e.includes('order')));
  });

  it('rejects empty order object', () => {
    const { validateConfig } = require('../../src/engine/interceptors');
    const errors = validateConfig({ stepInterceptors: { order: {} } }, new Map());
    assert.ok(errors.some(e => e.includes('at least one')));
  });

  it('rejects invalid step type key', () => {
    const { validateConfig } = require('../../src/engine/interceptors');
    const errors = validateConfig(
      { stepInterceptors: { order: { loop: ['test.a'] } } },
      new Map()
    );
    assert.ok(errors.some(e => e.includes('loop')));
  });

  it('rejects duplicate names within a list', () => {
    const reg = makeReg(['test.a', 'output']);
    const { validateConfig } = require('../../src/engine/interceptors');
    const errors = validateConfig(
      { stepInterceptors: { order: { output: ['test.a', 'test.a'] } } },
      reg
    );
    assert.ok(errors.some(e => e.includes('duplicate')));
  });

  it('rejects reference to unknown interceptor', () => {
    const { validateConfig } = require('../../src/engine/interceptors');
    const errors = validateConfig(
      { stepInterceptors: { order: { output: ['unknown.interceptor'] } } },
      new Map()
    );
    assert.ok(errors.some(e => e.includes('unknown interceptor')));
  });

  it('rejects reference to interceptor of wrong stepType', () => {
    const reg = makeReg(['test.copy', 'copy']);
    const { validateConfig } = require('../../src/engine/interceptors');
    const errors = validateConfig(
      { stepInterceptors: { order: { output: ['test.copy'] } } },
      reg
    );
    assert.ok(errors.some(e => e.includes('test.copy')));
  });

  it('rejects reference to explicit interceptor', () => {
    const reg = new Map([['test.explicit', {
      definition: { name: 'test.explicit', trigger: { type: 'explicit' } },
      transformFn: () => {},
    }]]);
    const { validateConfig } = require('../../src/engine/interceptors');
    const errors = validateConfig(
      { stepInterceptors: { order: { output: ['test.explicit'] } } },
      reg
    );
    assert.ok(errors.some(e => e.includes('test.explicit')));
  });

  it('accepts partial lists (not exhaustive)', () => {
    const reg = makeReg(['test.a', 'output'], ['test.b', 'output'], ['test.c', 'output']);
    const { validateConfig } = require('../../src/engine/interceptors');
    // Only listing two of three — should be valid
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
  const { applyConfig } = require('../../src/engine/interceptors');

  function makeReg(...names) {
    return new Map(names.map(name => [name, {
      definition: { name, trigger: { type: 'step', stepType: 'output' } },
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
    // c and a must come first
    assert.equal(keys[0], 'c');
    assert.equal(keys[1], 'a');
    // b and d follow in filesystem scan order
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
