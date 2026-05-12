'use strict';

/**
 * logger.js
 *
 * Creates a logger that writes timestamped entries to _logs/<timestamp>.log
 * and optionally echoes to stdout.
 *
 * Usage:
 *   const { createLogger } = require('./logger');
 *   const logger = createLogger(siteRoot, { echo: true });
 *   logger('Hello');        // writes + echoes
 *   logger.close();         // flushes and closes the file stream
 *
 * The log filename is fixed at creation time:
 *   _logs/2024-01-01T12-00-00-000Z.log
 *
 * If _logs/ does not exist it is created. If the site has no _logs/ folder
 * configured, passing siteRoot is still safe — the directory is created
 * on demand.
 */

const fs  = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * Format a Date as a filesystem-safe ISO string.
 * e.g. 2024-01-01T12-00-00-000Z
 *
 * @param {Date} date
 * @returns {string}
 */
function formatFilename(date) {
  return date.toISOString().replace(/:/g, '-').replace(/\./g, '-');
}

/**
 * Format a log line with a short timestamp prefix.
 *
 * @param {string} message
 * @param {Date}   date
 * @returns {string}
 */
function formatLine(message, date) {
  const ts = date.toISOString();
  return `[${ts}] ${message}`;
}

/**
 * Create a logger bound to a site's _logs/ directory.
 *
 * @param {string} siteRoot          Absolute path to the site folder
 * @param {object} options
 * @param {boolean} [options.echo=true]   Also write to stdout
 * @param {Date}   [options.now]          Override creation timestamp (for tests)
 * @returns {Function & { close: Function, logPath: string }}
 */
function createLogger(siteRoot, options = {}) {
  const echo = options.echo !== false;
  const now  = options.now || new Date();

  const logsDir  = path.join(siteRoot, '_logs');
  const filename = `${formatFilename(now)}.log`;
  const logPath  = path.join(logsDir, filename);

  // Create _logs/ synchronously so the stream can open immediately
  fs.mkdirSync(logsDir, { recursive: true });

  const stream = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });

  /**
   * Write a message to the log file (and optionally stdout).
   *
   * @param {string} message
   */
  function logger(message) {
    const line = formatLine(String(message), new Date());
    stream.write(line + '\n');
    if (echo) process.stdout.write(line + '\n');
  }

  /**
   * Flush and close the underlying file stream.
   * Returns a Promise that resolves when the stream is fully closed.
   *
   * @returns {Promise<void>}
   */
  logger.close = () =>
    new Promise((resolve, reject) => {
      stream.end(err => (err ? reject(err) : resolve()));
    });

  logger.logPath = logPath;

  return logger;
}

module.exports = { createLogger, formatFilename, formatLine };
