'use strict';

/**
 * init.js
 *
 * Scaffolds a new site folder with the expected structure,
 * info markdown files, sample content, and a starter utils resolver.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const STRUCTURE = [
  '_templates',
  '_resolvers',
  '_interceptors',
  '_logs',
  '_out',
  'assets',
  'contents',
];

const INFO_FILES = {
  '_site-info.md': `# Site Info

Fill in your site's name, description, and language settings here.
This file is for human reference only — it is not read by the engine.

## Languages
List the languages your site supports, e.g. en, ro.

## Entry Points
List the main output files expected after a build, e.g. _out/index.html.
`,

  '_interceptors/_interceptors-info.md': `# Interceptors

Place interceptor subfolders here. Each subfolder must contain:
  - interceptor.json  — defines the interceptor name and trigger
  - transformation.js — exports a pure \`transform(args, output, tools)\` function

Two trigger types:
  step:     hooked into copy/resolve/output steps automatically
  explicit: triggered via \`interceptBy\` in any JSON node

Engine-injected argument keys by step type:
  copy    : { "source-path", "target-path" }
  resolve : { "template", "value" }
  output  : { "content", "file-path" }

Interceptor names must not begin with "statico".

To control execution order of same-stepType interceptors, create
a config.json in this folder:

  {
    "stepInterceptors": {
      "order": {
        "output": ["my.first.interceptor", "my.second.interceptor"]
      }
    }
  }

Unlisted interceptors run after listed ones in filesystem scan order.
See the Statico documentation for full examples.
`,

  '_templates/_templates-info.md': `# Templates

Place your HTML (or any text) snippet files here.
Templates may contain:
  - Plain text / markup
  - Placeholders: {{some.ctx.path}}
  - Function calls: {{fn:namespace.functionName(arg1, arg2)}}

Snippets need not be complete files — they can be any stretch of a string.
They are composed via \`resolve\` steps in build.json.
`,

  '_resolvers/_resolvers-info.md': `# Resolvers

Place your Node.js resolver modules here.
Each file must export a plain object whose keys are namespace names:

  // utils.js
  module.exports = {
    utils: {
      getLanguage() { ... },
      translate(key, lang) { ... },
    }
  };

Functions are then callable as {{fn:utils.getLanguage()}} in templates or build.json.
Namespaces must be unique across all resolver files.
`,

  'assets/_assets-info.md': `# Assets

Place static assets here: images, fonts, audio files, PDFs, etc.
Use \`copy\` steps in build.json to move them to _out/ during the build.
`,

  'contents/_contents-info.md': `# Contents

Place your JSON data files here.
commons.json is always loaded automatically into ctx.commons at build start.
Other JSON files are loaded explicitly via \`resolve\` steps in build.json.
`,

  '_logs/_logs-info.md': `# Logs

Build logs are written here when the --log flag is used.
This folder is safe to clear at any time.
`,
};

const SAMPLE_COMMONS = {
  site: {
    name: 'My Site',
    description: 'A site built with Statico.',
    languages: ['en'],
    defaultLanguage: 'en',
  },
};

const SAMPLE_UTILS_RESOLVER = `'use strict';

/**
 * utils.js — Stock utility resolver for Statico sites.
 *
 * Export a "utils" namespace with helper functions available
 * throughout your templates and build.json as {{fn:utils.*}}.
 *
 * File access note
 * ----------------
 * The build engine changes into the site root before running the pipeline,
 * so relative paths like 'contents/commons.json' always resolve correctly
 * regardless of where you invoke statico-build from.
 */

/**
 * Read a cookie by name from document.cookie.
 * Returns null if not found or if not in a browser context.
 * This is intended to be embedded in a <script> tag in your HTML output.
 * It is provided here as a string so you can inject it via a resolve step.
 */
function getCookieScript() {
  return \`
function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}
\`.trim();
}

/**
 * Return a minimal JS snippet that reads the "lang" cookie and redirects
 * to the appropriate language path if needed.
 *
 * @param {string[]} languages    e.g. ["en", "ro"]
 * @param {string}   defaultLang  e.g. "en"
 */
function getLanguageSwitcherScript(languages, defaultLang) {
  return \`
(function() {
  var lang = getCookie('lang') || '\${defaultLang}';
  var supported = \${JSON.stringify(languages)};
  var seg = window.location.pathname.split('/').filter(Boolean)[0];
  if (supported.indexOf(seg) === -1 && supported.indexOf(lang) !== -1) {
    window.location.replace('/' + lang + window.location.pathname);
  }
})();
\`.trim();
}

/**
 * Simple utility: join an array of path segments with '/'.
 */
function joinPath(...parts) {
  return parts.filter(Boolean).join('/').replace(/\\/+/g, '/');
}

/**
 * Return the current ISO date string (build time).
 */
function buildDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Read and parse a JSON file relative to the site root.
 *
 * @param {string} relativePath   e.g. 'contents/commons.json'
 * @returns {*}
 */
function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(relativePath, 'utf8'));
}

/**
 * Example prepare function: reads commons.json and returns a plain object
 * that will be stored at ctx.current. Call it from a prepare template like:
 *   {{fn:utils.preparePage({{langItem.lang}})}}
 *
 * @param {string} lang
 * @returns {object}
 */
function preparePage(lang) {
  const commons = readJson('contents/commons.json');
  return {
    lang,
    siteTitle: commons.site && commons.site.name ? commons.site.name : '',
    buildDate: buildDate(),
  };
}

module.exports = {
  utils: {
    getCookieScript,
    getLanguageSwitcherScript,
    joinPath,
    buildDate,
    readJson,
    preparePage,
  },
};
`;

const SAMPLE_BUILD_JSON = {
  before: [],
  buildSteps: [
    {
      _comment: "Example: resolve the site's <head> partial into ctx",
      type: 'resolve',
      template: 'head.html',
      target: 'partials.head',
    },
    {
      _comment: 'Example: write a resolved page to _out/',
      type: 'output',
      source: 'partials.head',
      target: 'index.html',
      override: true,
    },
  ],
  after: [],
};

const SAMPLE_HEAD_TEMPLATE = `<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{{commons.site.name}}</title>
  <meta name="description" content="{{commons.site.description}}" />
</head>
`;

/**
 * Scaffold a new site at the given path.
 *
 * @param {string} sitePath   Absolute or relative path for the new site folder
 */
async function initSite(sitePath) {
  const abs = path.resolve(sitePath);

  if (fs.existsSync(abs)) {
    throw new Error(`Target folder already exists: ${abs}`);
  }

  // Create directory structure
  for (const dir of STRUCTURE) {
    await fsp.mkdir(path.join(abs, dir), { recursive: true });
  }

  // Write info files
  for (const [relPath, content] of Object.entries(INFO_FILES)) {
    const full = path.join(abs, relPath);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, 'utf8');
  }

  // Write commons.json
  await fsp.writeFile(
    path.join(abs, 'contents', 'commons.json'),
    JSON.stringify(SAMPLE_COMMONS, null, 2),
    'utf8'
  );

  // Write starter utils resolver
  await fsp.writeFile(
    path.join(abs, '_resolvers', 'utils.js'),
    SAMPLE_UTILS_RESOLVER,
    'utf8'
  );

  // Write sample build.json
  await fsp.writeFile(
    path.join(abs, 'build.json'),
    JSON.stringify(SAMPLE_BUILD_JSON, null, 2),
    'utf8'
  );

  // Write sample template
  await fsp.writeFile(
    path.join(abs, '_templates', 'head.html'),
    SAMPLE_HEAD_TEMPLATE,
    'utf8'
  );

  return abs;
}

module.exports = { initSite };
