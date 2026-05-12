'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp  = require('fs/promises');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { createLogger, formatFilename, formatLine } = require('../../src/engine/logger');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('formatFilename', () => {
  it('produces a filesystem-safe string from a Date', () => {
    const d = new Date('2024-03-15T10:30:00.123Z');
    const name = formatFilename(d);
    assert.equal(name, '2024-03-15T10-30-00-123Z');
    assert.doesNotMatch(name, /[:/]/, 'must not contain colons or slashes');
  });
});

describe('formatLine', () => {
  it('includes the message', () => {
    const line = formatLine('hello world', new Date());
    assert.ok(line.includes('hello world'));
  });
  it('includes an ISO timestamp in brackets', () => {
    const d = new Date('2024-01-01T00:00:00.000Z');
    const line = formatLine('msg', d);
    assert.ok(line.startsWith('[2024-01-01T00:00:00.000Z]'));
  });
});

// ---------------------------------------------------------------------------
// createLogger
// ---------------------------------------------------------------------------

describe('createLogger', () => {
  let siteRoot;

  before(async () => {
    siteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'statico-log-'));
  });

  after(async () => {
    await fsp.rm(siteRoot, { recursive: true, force: true });
  });

  it('creates _logs/ directory if absent', () => {
    const logger = createLogger(siteRoot, { echo: false });
    assert.ok(fs.existsSync(path.join(siteRoot, '_logs')));
    return logger.close();
  });

  it('exposes logPath pointing inside _logs/', () => {
    const logger = createLogger(siteRoot, { echo: false });
    assert.ok(logger.logPath.startsWith(path.join(siteRoot, '_logs')));
    assert.ok(logger.logPath.endsWith('.log'));
    return logger.close();
  });

  it('writes messages to the log file', async () => {
    const logger = createLogger(siteRoot, { echo: false });
    logger('first line');
    logger('second line');
    await logger.close();

    const content = fs.readFileSync(logger.logPath, 'utf8');
    assert.ok(content.includes('first line'));
    assert.ok(content.includes('second line'));
  });

  it('each line is timestamped', async () => {
    const logger = createLogger(siteRoot, { echo: false });
    logger('timestamped message');
    await logger.close();

    const content = fs.readFileSync(logger.logPath, 'utf8');
    // Each line should start with [<ISO date>]
    for (const line of content.trim().split('\n')) {
      assert.match(line, /^\[\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('uses the provided `now` timestamp for the filename', async () => {
    const now = new Date('2099-06-15T08:00:00.000Z');
    const logger = createLogger(siteRoot, { echo: false, now });
    await logger.close();
    assert.ok(path.basename(logger.logPath).startsWith('2099-06-15'));
  });

  it('close() returns a Promise that resolves', async () => {
    const logger = createLogger(siteRoot, { echo: false });
    await assert.doesNotReject(() => logger.close());
  });

  it('log file persists after close', async () => {
    const logger = createLogger(siteRoot, { echo: false });
    logger('persistent');
    await logger.close();
    assert.ok(fs.existsSync(logger.logPath));
  });
});
