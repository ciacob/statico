'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  getByPath,
  isExpression,
  extractInner,
  isFnCall,
  parseFnCall,
  splitArgs,
  resolveValue,
  interpolate,
  extractExpressions,
  validateFnRef,
  ResolverError,
} = require('../../src/engine/resolver');

// ---------------------------------------------------------------------------
// getByPath
// ---------------------------------------------------------------------------
describe('getByPath', () => {
  it('returns top-level value', () => {
    assert.equal(getByPath({ a: 1 }, 'a'), 1);
  });
  it('returns nested value', () => {
    assert.equal(getByPath({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
  });
  it('returns undefined for missing path', () => {
    assert.equal(getByPath({ a: 1 }, 'a.b'), undefined);
  });
  it('returns undefined for empty path', () => {
    assert.equal(getByPath({ a: 1 }, ''), undefined);
  });
  it('handles null gracefully', () => {
    assert.equal(getByPath(null, 'a'), undefined);
  });
  it('returns array value', () => {
    assert.deepEqual(getByPath({ items: [1, 2] }, 'items'), [1, 2]);
  });
});

// ---------------------------------------------------------------------------
// isExpression
// ---------------------------------------------------------------------------
describe('isExpression', () => {
  it('recognises full {{...}} expression', () => {
    assert.ok(isExpression('{{foo.bar}}'));
  });
  it('recognises fn: expression', () => {
    assert.ok(isExpression('{{fn:utils.getLanguage()}}'));
  });
  it('rejects plain string', () => {
    assert.equal(isExpression('hello'), false);
  });
  it('rejects partial expression embedded in text', () => {
    assert.equal(isExpression('hello {{foo}}'), false);
  });
  it('handles whitespace around expression', () => {
    assert.ok(isExpression('  {{foo.bar}}  '));
  });
});

// ---------------------------------------------------------------------------
// extractInner
// ---------------------------------------------------------------------------
describe('extractInner', () => {
  it('extracts inner from simple expression', () => {
    assert.equal(extractInner('{{foo.bar}}'), 'foo.bar');
  });
  it('extracts inner from fn expression', () => {
    assert.equal(extractInner('{{fn:utils.go()}}'), 'fn:utils.go()');
  });
});

// ---------------------------------------------------------------------------
// isFnCall
// ---------------------------------------------------------------------------
describe('isFnCall', () => {
  it('returns true for fn: prefix', () => {
    assert.ok(isFnCall('fn:utils.getLanguage()'));
  });
  it('returns false for plain path', () => {
    assert.equal(isFnCall('page.title'), false);
  });
});

// ---------------------------------------------------------------------------
// parseFnCall
// ---------------------------------------------------------------------------
describe('parseFnCall', () => {
  it('parses zero-arg call', () => {
    const r = parseFnCall('fn:utils.getLanguage()');
    assert.equal(r.namespace, 'utils');
    assert.equal(r.name, 'getLanguage');
    assert.deepEqual(r.rawArgs, []);
  });
  it('parses call with literal args', () => {
    const r = parseFnCall('fn:utils.translate(hello, world)');
    assert.equal(r.namespace, 'utils');
    assert.equal(r.name, 'translate');
    assert.deepEqual(r.rawArgs, ['hello', 'world']);
  });
  it('parses call with nested fn arg', () => {
    const r = parseFnCall('fn:utils.translate({{fn:utils.getLang()}}, key)');
    assert.equal(r.rawArgs[0], '{{fn:utils.getLang()}}');
    assert.equal(r.rawArgs[1], 'key');
  });
  it('parses call without parentheses (zero-arg shorthand)', () => {
    const r = parseFnCall('fn:utils.getLanguage');
    assert.equal(r.name, 'getLanguage');
    assert.deepEqual(r.rawArgs, []);
  });
});

// ---------------------------------------------------------------------------
// splitArgs
// ---------------------------------------------------------------------------
describe('splitArgs', () => {
  it('splits simple args', () => {
    assert.deepEqual(splitArgs('a, b, c'), ['a', 'b', 'c']);
  });
  it('keeps nested {{ }} intact', () => {
    const result = splitArgs('{{fn:a()}}, b');
    assert.equal(result[0], '{{fn:a()}}');
    assert.equal(result[1], 'b');
  });
  it('handles single arg', () => {
    assert.deepEqual(splitArgs('only'), ['only']);
  });
  it('handles empty string', () => {
    assert.deepEqual(splitArgs(''), []);
  });
});

// ---------------------------------------------------------------------------
// resolveValue
// ---------------------------------------------------------------------------
describe('resolveValue', () => {
  const ctx = { page: { title: 'Nocturne' }, lang: 'en' };
  const registry = { utils: { upper: s => s.toUpperCase() } };

  it('returns constant (non-string) as-is', () => {
    assert.equal(resolveValue(42, ctx, registry), 42);
    assert.equal(resolveValue(true, ctx, registry), true);
  });
  it('returns plain string as-is', () => {
    assert.equal(resolveValue('hello', ctx, registry), 'hello');
  });
  it('resolves placeholder to ctx value', () => {
    assert.equal(resolveValue('{{page.title}}', ctx, registry), 'Nocturne');
  });
  it('resolves fn: call', () => {
    assert.equal(resolveValue('{{fn:utils.upper(hello)}}', ctx, registry), 'HELLO');
  });
  it('throws ResolverError for missing ctx path', () => {
    assert.throws(
      () => resolveValue('{{page.missing}}', ctx, registry),
      ResolverError
    );
  });
  it('throws ResolverError for unknown namespace', () => {
    assert.throws(
      () => resolveValue('{{fn:unknown.fn()}}', ctx, registry),
      ResolverError
    );
  });
  it('resolves nested fn call (arg is itself a fn call)', () => {
    const reg = {
      a: { wrap: x => `[${x}]` },
      b: { val:  ()  => 'hello' },
    };
    assert.equal(resolveValue('{{fn:a.wrap({{fn:b.val()}})}}', {}, reg), '[hello]');
  });
});

// ---------------------------------------------------------------------------
// interpolate
// ---------------------------------------------------------------------------
describe('interpolate', () => {
  const ctx = { site: { name: 'MySite' }, lang: 'ro' };
  const registry = { utils: { shout: s => s + '!' } };

  it('interpolates single expression in surrounding text', () => {
    assert.equal(
      interpolate('<title>{{site.name}}</title>', ctx, registry),
      '<title>MySite</title>'
    );
  });
  it('interpolates multiple expressions', () => {
    assert.equal(
      interpolate('{{site.name}} ({{lang}})', ctx, registry),
      'MySite (ro)'
    );
  });
  it('interpolates fn call inline', () => {
    assert.equal(
      interpolate('Hello {{fn:utils.shout(world)}}', ctx, registry),
      'Hello world!'
    );
  });
  it('preserves type when entire string is expression', () => {
    const ctx2 = { items: [1, 2, 3] };
    assert.deepEqual(interpolate('{{items}}', ctx2, {}), [1, 2, 3]);
  });
  it('returns non-string values unchanged', () => {
    assert.equal(interpolate(42, ctx, registry), 42);
  });
  it('throws on missing ctx path', () => {
    assert.throws(
      () => interpolate('{{missing.key}}', ctx, registry),
      /Placeholder path not found/
    );
  });
});

// ---------------------------------------------------------------------------
// extractExpressions
// ---------------------------------------------------------------------------
describe('extractExpressions', () => {
  it('extracts from a string', () => {
    const exprs = extractExpressions('<h1>{{page.title}}</h1>');
    assert.deepEqual(exprs, ['page.title']);
  });
  it('extracts from nested object', () => {
    const exprs = extractExpressions({ a: '{{x.y}}', b: { c: '{{fn:u.fn()}}' } });
    assert.ok(exprs.includes('x.y'));
    assert.ok(exprs.includes('fn:u.fn()'));
  });
  it('extracts from array', () => {
    const exprs = extractExpressions(['{{a}}', 'plain', '{{b}}']);
    assert.deepEqual(exprs, ['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// validateFnRef
// ---------------------------------------------------------------------------
describe('validateFnRef', () => {
  const registry = { utils: { go: () => {} } };

  it('returns valid for existing fn', () => {
    assert.deepEqual(validateFnRef('fn:utils.go()', registry), { valid: true });
  });
  it('returns invalid for missing namespace', () => {
    const r = validateFnRef('fn:missing.go()', registry);
    assert.equal(r.valid, false);
    assert.ok(r.error.includes('namespace'));
  });
  it('returns invalid for missing function', () => {
    const r = validateFnRef('fn:utils.nothere()', registry);
    assert.equal(r.valid, false);
    assert.ok(r.error.includes('utils.nothere'));
  });
  it('returns valid for non-fn expression', () => {
    assert.deepEqual(validateFnRef('page.title', registry), { valid: true });
  });
});
