# Statico

A small, modular static site compiler. You write JSON, templates, and plain Node.js functions — Statico wires them together and writes files to disk.

Statico does not prescribe a folder structure for your HTML, does not ship themes, and does not have a plugin ecosystem. It is a build pipeline engine. What you build with it is entirely up to you.

> This project is not yet published to npm. Install it by cloning the repository directly.

---

## How it works

A site built with Statico is a folder containing:

- **`build.json`** — the build manifest; tells Statico what to do and in what order
- **`_templates/`** — text snippet files (HTML, or any format)
- **`contents/`** — JSON data files, including `commons.json` which is always loaded
- **`_resolvers/`** — Node.js modules that expose functions callable from templates and `build.json`
- **`assets/`** — static files to be copied to output
- **`_out/`** — where the built site lands (generated; do not edit by hand)
- **`_logs/`** — optional build logs

Statico reads `build.json`, executes its steps in order, and writes the result to `_out/`.

---

## Expressions

Templates and `build.json` values share the same expression syntax. Any string value can be one of:

| Form | Example | Meaning |
|---|---|---|
| Constant | `"My Site"` | Plain value, returned as-is |
| Placeholder | `"{{commons.site.name}}"` | Dotted path into the build context (`ctx`) |
| Function call | `"{{fn:utils.buildDate()}}"` | Calls `buildDate()` from the `utils` resolver namespace |

Expressions can be embedded inside larger strings:

```html
<title>{{commons.site.name}} — {{commons.site.tagline}}</title>
```

Function arguments can themselves be expressions:

```
{{fn:utils.translate({{fn:utils.getLang()}}, welcome)}}
```

---

## Build context (`ctx`)

`ctx` is a plain JavaScript object that grows as steps execute. It is seeded automatically from `contents/commons.json` at the start of every build (available at `ctx.commons`). Steps add to it; later steps can reference what earlier steps produced.

---

## `build.json`

```json
{
  "before": [],
  "buildSteps": [
    { "type": "resolve", "template": "head.html", "target": "partials.head" },
    { "type": "output",  "source": "pages.index", "target": "index.html" }
  ],
  "after": []
}
```

`before` and `after` are optional hook arrays with the same structure as `buildSteps`.

---

## Step types

### `resolve`

Loads a template, interpolates it against `ctx` (and optionally a content file), and stores the result in `ctx`.

```json
{
  "type":     "resolve",
  "template": "piece.html",
  "content":  "pieces/nocturne.json",
  "target":   "pages.nocturne"
}
```

- **`template`** *(required)* — path relative to `_templates/`
- **`content`** *(optional)* — path relative to `contents/`; loaded data is available as `{{current.*}}` during this step
- **`target`** *(required)* — dotted path in `ctx` where the resolved string is stored

### `output`

Writes a `ctx` value to a file under `_out/`.

```json
{
  "type":     "output",
  "source":   "pages.nocturne",
  "target":   "pieces/nocturne.html",
  "override": true
}
```

- **`source`** *(required)* — dotted path in `ctx`
- **`target`** *(required)* — file path relative to `_out/`
- **`override`** *(optional, default `true`)* — if `false`, logs the action but does not write

### `copy`

Copies a file or directory from anywhere inside the site root to `_out/`.

```json
{
  "type":     "copy",
  "source":   "assets/images",
  "target":   "assets/images",
  "override": true
}
```

### `loop`

Iterates over an array, running a sub-pipeline for each element.

```json
{
  "type":       "loop",
  "collection": "{{commons.pieces}}",
  "as":         "item",
  "parallel":   false,
  "steps": [
    { "type": "resolve", "template": "piece.html", "target": "pages.current" },
    { "type": "output",  "source": "pages.current", "target": "{{fn:utils.outPath({{item.slug}})}}" }
  ]
}
```

- **`collection`** *(required)* — any expression resolving to an array
- **`as`** *(optional, default `"item"`)* — name under which the current element is available in `ctx`
- **`parallel`** *(optional, default `false`)* — if `true`, all iterations are launched concurrently; the user is responsible for ensuring steps are safe to run in parallel
- **`steps`** *(required)* — same structure as `buildSteps`

---

## Resolvers

A resolver is a `.js` file in `_resolvers/` that exports a plain object of named functions:

```js
// _resolvers/utils.js
module.exports = {
  utils: {
    outPath: slug => `pieces/${slug}.html`,
    buildDate: () => new Date().toISOString().slice(0, 10),
  }
};
```

The object key (`utils`) becomes the namespace. Functions are then callable anywhere as `{{fn:utils.outPath(...)}}`.

Namespaces must be unique across all resolver files. Filenames are not used as namespaces — the exported key is authoritative, which means one file may export multiple namespaces if needed.

---

## Getting started

**1. Clone the repository**

```bash
git clone https://github.com/ciacob/statico.git
cd statico
```

**2. Scaffold a new site**

```bash
node bin/init.js ../my-site
cd ../my-site
```

This creates the full folder structure, a `commons.json` with sample data, a starter `utils.js` resolver, a sample template, and a minimal `build.json`. Each folder contains a `*-info.md` file with brief guidance.

**3. Validate**

```bash
node /path/to/statico/bin/validate.js .
```

Checks that `build.json` is structurally sound, all referenced templates and assets exist on disk, and all `fn:` calls resolve to known functions in the registry. Pass `--check-ctx` to also validate placeholder paths against a partially-built `ctx`.

**4. Build**

```bash
node /path/to/statico/bin/build.js .
```

Clears `_out/`, runs the pipeline, writes output files. Pass `--log` to also write a timestamped log to `_logs/`.

---

## Project structure

```
statico/
├── bin/
│   ├── init.js          # statico-init
│   ├── build.js         # statico-build
│   └── validate.js      # statico-validate
├── src/
│   ├── engine/
│   │   ├── resolver.js  # expression parser and evaluator
│   │   ├── registry.js  # resolver module loader
│   │   ├── context.js   # ctx management
│   │   ├── pipeline.js  # build.json orchestration
│   │   ├── steps.js     # step executors
│   │   ├── logger.js    # file logger
│   │   └── validator.js # static analysis
│   ├── cli/
│   │   └── build.js     # programmatic build entry point
│   ├── init/
│   │   └── init.js      # site scaffolder
│   └── index.js         # public API
└── test/
    └── engine/          # unit and integration tests (Node built-in test runner)
```

---

## Running tests

Requires Node.js 20 or later. No dependencies to install.

```bash
node --test test/engine/*.test.js
```

---

## Programmatic use

```js
const { build, validate, init } = require('./src/index.js');

// Build a site
await build('/absolute/path/to/my-site', { logger: console.log });

// Validate without building
const { errors, warnings } = validate('/absolute/path/to/my-site', registry);

// Scaffold a new site
await init('/absolute/path/to/new-site');
```

---

## Limitations and known gaps

- No incremental builds — `_out/` is cleared and rebuilt in full every time
- No built-in dev server or file watcher
- Template format is engine-agnostic by design; there is no default templating language beyond the `{{...}}` expression syntax — full HTML structure is your responsibility
- `--check-ctx` validation cannot verify paths that are populated by function calls at runtime
- Not published to npm; intended for direct use from source

---

## License

[Statico License v1.0](./LICENSE) — free to use and modify, including commercially; no rebranding or resale; derivatives must carry the same terms.
