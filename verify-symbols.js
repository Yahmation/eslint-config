#!/usr/bin/env node
/**
 * verify-symbols.js — catch cross-reference bugs at build time.
 *
 * Validates three things against real code:
 *
 *   1. Every  navigation.navigate('X')  — 'X' must be a screen the app
 *      actually knows about. For React Native custom-nav apps (like voice/mobile),
 *      screens are discovered by grepping for `currentScreen?.name === 'X'`
 *      patterns in the app entry file. For React Navigation apps, grepping for
 *      `<Stack.Screen name="X"` / `<Tab.Screen name="X"`.
 *
 *   2. Every `const { foo, bar } = useSomeStore()` — every destructured key
 *      must be a property returned by the store definition. Finds Zustand
 *      stores (create((set, get) => ({ ... }))) and checks the returned keys.
 *
 *   3. Every `api.get('/path')` / `api.post('/path')` etc — '/path' should
 *      correspond to a fastify.get/post/put/delete handler in the api routes.
 *      Only checked if a sibling API project exists (e.g. /root/voice/services/api).
 *
 * Usage:
 *   node /root/shared/scripts/verify-symbols.js [--project <path>]
 *
 * Defaults to cwd if --project is omitted. Exits 0 if clean, 1 if any errors.
 *
 * The script is intentionally heuristic (uses regex, not a JS parser) to avoid
 * a heavy dep. It aims for "catches real bugs with few false positives" rather
 * than full AST correctness.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── CLI arg parsing ────────────────────────────────────────────────────
const args = process.argv.slice(2);
let projectRoot = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project') projectRoot = path.resolve(args[++i]);
}

// ── helpers ────────────────────────────────────────────────────────────
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'android', 'ios', '.expo', 'build', 'dist',
  'build-archive', '_pgbackup', 'coverage', '.next', '.turbo',
]);
const SOURCE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function rel(p) {
  return path.relative(projectRoot, p);
}

// ── error tracking ─────────────────────────────────────────────────────
const errors = [];
const record = (file, line, message) => errors.push({ file: rel(file), line, message });

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

// ── 1. Navigation screen validation ────────────────────────────────────
// Discover the set of known screen names in the project.
function discoverScreens(files) {
  const screens = new Set();
  const patterns = [
    // React Navigation: <Stack.Screen name="X" />, <Tab.Screen name="X" />
    /<(?:Stack|Tab|Drawer|Native[A-Za-z]*)\.Screen\s+name\s*=\s*["']([^"']+)["']/g,
    // Custom nav (voice mobile): currentScreen?.name === 'X'  or  name: 'X'
    /currentScreen\??\.name\s*===?\s*["']([^"']+)["']/g,
    /screen\??\.name\s*===?\s*["']([^"']+)["']/g,
    // navigate('X', ...) — if the target isn't validated, we at least track what
    // screens the code tries to navigate to, and warn on any that are used but
    // never declared.
  ];
  for (const file of files) {
    const content = readIfExists(file);
    if (!content) continue;
    for (const re of patterns) {
      let m;
      while ((m = re.exec(content)) !== null) {
        screens.add(m[1]);
      }
    }
  }
  return screens;
}

function checkNavigationCalls(files, knownScreens) {
  // Skip entirely if we couldn't discover ANY screens — means this isn't a
  // navigation-style app and we'd produce nothing but false positives.
  if (knownScreens.size === 0) return;

  // navigation.navigate('X', ...) or navigation.replace('X', ...) or nav.navigate('X', ...)
  const navRe = /\b(?:navigation|nav|navigator)\.(?:navigate|replace|push)\s*\(\s*["']([^"']+)["']/g;

  for (const file of files) {
    const content = readIfExists(file);
    if (!content) continue;
    let m;
    while ((m = navRe.exec(content)) !== null) {
      const target = m[1];
      if (!knownScreens.has(target)) {
        record(file, lineOf(content, m.index),
          `navigation.navigate('${target}') — '${target}' is not a registered screen. ` +
          `Known screens: ${[...knownScreens].sort().join(', ')}`);
      }
    }
  }
}

// ── 2. Store destructure validation ───────────────────────────────────
// Find Zustand stores and the keys they export. Then check every
// `const { a, b, c } = useStoreName(...)` call against those keys.
function discoverStores(files) {
  // Map: hookName -> Set of keys returned by the store
  // Detects:
  //   export const useFooStore = create((set, get) => ({ a: ..., b: ... }));
  //   export const useFooStore = create(set => ({ a: ..., b: ... }));
  //   export const useFooStore = create((set) => { return { a: ..., b: ... } });
  const stores = new Map();

  for (const file of files) {
    const content = readIfExists(file);
    if (!content) continue;

    // Find store declarations
    const declRe = /export\s+(?:const|let|var)\s+(use[A-Z]\w*)\s*=\s*create\s*\(/g;
    let m;
    while ((m = declRe.exec(content)) !== null) {
      const hookName = m[1];
      // Scan forward from declaration to find the object literal returned by the factory
      const start = m.index + m[0].length;
      const keys = extractTopLevelKeysFromStoreBody(content, start);
      if (keys) {
        stores.set(hookName, keys);
      }
    }
  }
  return stores;
}

// Given content and an index pointing just after `create(`, find the object
// literal that is the store body and return the set of top-level keys.
//
// Strategy: use indentation-based detection. The store body has a consistent
// indentation level for its top-level keys; anything more deeply indented is
// part of a nested function/object. This is much more robust than brace-
// balancing (which gets tripped up by template literals and other edge cases).
function extractTopLevelKeysFromStoreBody(content, startIdx) {
  // Find the `=>` that starts the arrow body, then advance to the first `{`.
  let i = startIdx;
  const arrowIdx = content.indexOf('=>', i);
  if (arrowIdx === -1) return null;
  i = arrowIdx + 2;
  while (i < content.length && /\s/.test(content[i])) i++;
  if (content[i] === '(') i++;
  while (i < content.length && /\s/.test(content[i])) i++;
  if (content.slice(i, i + 6) === 'return') {
    i += 6;
    while (i < content.length && /\s/.test(content[i])) i++;
  }
  if (content[i] !== '{') return null;

  // Find the matching `}` using brace balancing with string/comment awareness.
  const bodyStart = i + 1;
  let depth = 1;
  let j = bodyStart;
  let inStr = null;
  let inLineComment = false;
  let inBlockComment = false;
  // For template literals we need to track `${...}` expressions so we correctly
  // re-enter "code mode" inside them.
  const templateStack = []; // tracks depth inside `${...}`
  while (j < content.length && depth > 0) {
    const c = content[j];
    const next = content[j + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
    } else if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; j++; }
    } else if (inStr === '`') {
      // Inside a template literal
      if (c === '\\') j++;
      else if (c === '`') inStr = null;
      else if (c === '$' && next === '{') {
        // Enter code mode inside ${...}
        templateStack.push(depth);
        inStr = null;
        depth++;
        j++;
      }
    } else if (inStr) {
      if (c === '\\') j++;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") {
      inStr = c;
    } else if (c === '`') {
      inStr = '`';
    } else if (c === '/' && next === '/') {
      inLineComment = true; j++;
    } else if (c === '/' && next === '*') {
      inBlockComment = true; j++;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (templateStack.length > 0 && depth === templateStack[templateStack.length - 1]) {
        templateStack.pop();
        inStr = '`';
      }
    }
    j++;
  }
  if (depth !== 0) return null;
  const bodyEnd = j - 1;
  const body = content.slice(bodyStart, bodyEnd);

  // Now extract top-level keys using indentation.
  // Find the minimum non-blank indentation in the body — that's the top level.
  const rawLines = body.split('\n');
  let topIndent = null;
  for (const line of rawLines) {
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)(.)/);
    if (!m) continue;
    const leading = m[1];
    const firstChar = m[2];
    // Skip lines that start with `}` or `)` — they're closers
    if (firstChar === '}' || firstChar === ')' || firstChar === ']') continue;
    if (topIndent === null || leading.length < topIndent.length) {
      topIndent = leading;
    }
  }
  if (topIndent === null) return new Set();

  const keys = new Set();
  for (const line of rawLines) {
    if (!line.startsWith(topIndent)) continue;
    const rest = line.slice(topIndent.length);
    // Must not have further indentation
    if (/^\s/.test(rest)) continue;
    // Skip comments and spreads
    if (rest.startsWith('//') || rest.startsWith('/*')) continue;
    if (rest.startsWith('...')) continue;
    // Match a top-level key: `foo:`, `foo(`, or `'foo':` / `"foo":`
    let m = rest.match(/^([A-Za-z_$][\w$]*)\s*[:(]/);
    if (!m) m = rest.match(/^['"]([^'"]+)['"]\s*:/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

function checkStoreDestructures(files, stores) {
  if (stores.size === 0) return;
  // Match: const { a, b, c } = useStoreName(...)  or  const { a } = useStoreName
  for (const [hookName, knownKeys] of stores.entries()) {
    const re = new RegExp(
      `(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*${hookName}\\s*\\(`,
      'g'
    );
    for (const file of files) {
      const content = readIfExists(file);
      if (!content) continue;
      let m;
      while ((m = re.exec(content)) !== null) {
        const destructureBlock = m[1];
        // Parse destructured names (simple — ignore renaming/defaults)
        const names = destructureBlock
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => {
            // Handle renaming like `fooBar: localName`
            const idx = s.indexOf(':');
            return (idx >= 0 ? s.slice(0, idx) : s).trim();
          })
          .filter(n => /^[A-Za-z_$][\w$]*$/.test(n));

        for (const name of names) {
          if (!knownKeys.has(name)) {
            record(file, lineOf(content, m.index),
              `Destructured '${name}' from ${hookName}() but the store doesn't export it. ` +
              `Available: ${[...knownKeys].sort().join(', ')}`);
          }
        }
      }
    }
  }
}

// ── 3. API route validation (optional) ────────────────────────────────
// If a sibling services/api exists, build a set of available routes and
// check every api.get/post/put/delete('/path') against it.
function discoverApiRoutes(apiRoot) {
  if (!fs.existsSync(apiRoot)) return null;
  const files = walk(apiRoot);
  const routes = new Set();
  // Match: fastify.get('/path' or fastify.post('/path' etc
  const re = /fastify\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g;
  for (const file of files) {
    const content = readIfExists(file);
    if (!content) continue;
    let m;
    while ((m = re.exec(content)) !== null) {
      // Normalize: strip /api/v1 prefix if present, strip param placeholders
      let route = m[2];
      route = route.replace(/^\/api\/v\d+/, '');
      route = route.replace(/:[^/]+/g, ':param');
      routes.add(`${m[1].toUpperCase()} ${route}`);
    }
  }
  return routes;
}

function checkApiCalls(files, routes) {
  if (!routes || routes.size === 0) return;
  // Match api.METHOD(`...`) or api.METHOD('...') or api.METHOD("..."),
  // capturing the string content up to the matching closing delimiter.
  // Handles template literals with ${...} expressions.
  const re = /\bapi\.(get|post|put|delete|patch)\s*\(\s*(`|"|')/g;
  for (const file of files) {
    const content = readIfExists(file);
    if (!content) continue;
    let m;
    while ((m = re.exec(content)) !== null) {
      const method = m[1].toUpperCase();
      const quote = m[2];
      // Find the closing quote, handling ${...} in template literals
      let k = m.index + m[0].length;
      let pathRaw = '';
      let ok = false;
      while (k < content.length) {
        const c = content[k];
        if (c === '\\') { pathRaw += content[k] + content[k + 1]; k += 2; continue; }
        if (c === quote) { ok = true; break; }
        if (quote === '`' && c === '$' && content[k + 1] === '{') {
          // skip ${...}
          let depth = 1; k += 2;
          while (k < content.length && depth > 0) {
            if (content[k] === '{') depth++;
            else if (content[k] === '}') depth--;
            if (depth > 0) k++;
          }
          pathRaw += '${}';
          k++;
          continue;
        }
        pathRaw += c;
        k++;
      }
      if (!ok) continue;

      // Normalize the client path
      let routePath = pathRaw;
      // Strip template-literal placeholder markers → :param
      routePath = routePath.replace(/\$\{\}/g, ':param');
      // Strip query string (the API doesn't include it in the route definition)
      routePath = routePath.split('?')[0];
      // Strip trailing slash (except root)
      if (routePath.length > 1 && routePath.endsWith('/')) routePath = routePath.slice(0, -1);

      // Build candidate keys — try with and without /api/v1 prefix,
      // and also try stripping trailing :param (common when the ${...} is a
      // conditional query string appended to the URL, e.g. `${q ? '?'+q : ''}`).
      const candidates = [
        `${method} ${routePath}`,
        `${method} /api/v1${routePath}`,
      ];
      if (routePath.endsWith(':param')) {
        const stripped = routePath.replace(/:param$/, '').replace(/\/$/, '') || '/';
        candidates.push(`${method} ${stripped}`);
        candidates.push(`${method} /api/v1${stripped}`);
      }

      let matched = false;
      for (const key of candidates) {
        if (routes.has(key)) { matched = true; break; }
      }

      if (!matched) {
        // Fuzzy match: try comparing the path structure ignoring param names
        const clientStructure = routePath
          .split('/')
          .map(seg => seg.startsWith(':') ? ':param' : seg)
          .join('/');
        const structuralMatch = [...routes].some(r => {
          if (!r.startsWith(method + ' ')) return false;
          const apiPath = r.slice(method.length + 1);
          const apiStructure = apiPath
            .split('/')
            .map(seg => seg.startsWith(':') ? ':param' : seg)
            .join('/');
          return apiStructure === clientStructure || apiStructure === '/api/v1' + clientStructure;
        });
        if (!structuralMatch) {
          record(file, lineOf(content, m.index),
            `api.${m[1]}('${pathRaw}') — no matching route in the API. Expected ${method} ${routePath} or similar.`);
        }
      }
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────
function main() {
  console.log(`▶ verify-symbols scanning ${projectRoot}`);

  const sourceDir = fs.existsSync(path.join(projectRoot, 'src'))
    ? path.join(projectRoot, 'src')
    : projectRoot;
  const files = walk(sourceDir);

  // Also scan the project root for entry files (App.js, index.js, etc)
  for (const f of fs.readdirSync(projectRoot)) {
    if (SOURCE_EXTS.has(path.extname(f))) {
      files.push(path.join(projectRoot, f));
    }
  }

  console.log(`  scanning ${files.length} source files`);

  // 1. Navigation
  const screens = discoverScreens(files);
  if (screens.size > 0) {
    console.log(`  discovered ${screens.size} navigation screen(s): ${[...screens].sort().join(', ')}`);
    checkNavigationCalls(files, screens);
  } else {
    console.log('  no navigation screens discovered; skipping nav check');
  }

  // 2. Store destructures
  const stores = discoverStores(files);
  if (stores.size > 0) {
    console.log(`  discovered ${stores.size} store(s): ${[...stores.keys()].join(', ')}`);
    checkStoreDestructures(files, stores);
  } else {
    console.log('  no stores discovered; skipping store check');
  }

  // 3. API routes (look for a sibling services/api dir)
  const candidates = [
    path.resolve(projectRoot, '../../services/api/src'),
    path.resolve(projectRoot, '../../services/api'),
    path.resolve(projectRoot, '../services/api/src'),
    path.resolve(projectRoot, 'services/api/src'),
  ];
  let apiRoot = null;
  for (const c of candidates) { if (fs.existsSync(c)) { apiRoot = c; break; } }
  if (apiRoot) {
    const routes = discoverApiRoutes(apiRoot);
    console.log(`  discovered ${routes ? routes.size : 0} API route(s) from ${rel(apiRoot) || apiRoot}`);
    if (routes) checkApiCalls(files, routes);
  } else {
    console.log('  no sibling services/api found; skipping api route check');
  }

  // Report
  if (errors.length === 0) {
    console.log(`\n✓ verify-symbols: no issues found`);
    process.exit(0);
  }
  console.log(`\n✗ verify-symbols: ${errors.length} issue(s) found\n`);
  for (const e of errors) {
    console.log(`  ${e.file}:${e.line}`);
    console.log(`    ${e.message}\n`);
  }
  process.exit(1);
}

main();
