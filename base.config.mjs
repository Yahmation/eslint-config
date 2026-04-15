// Shared ESLint base config for all Yahmation projects (web + mobile).
//
// To use in a project, create eslint.config.mjs at the project root:
//
//   import base from '/root/shared/eslint/base.config.mjs';
//   export default [
//     ...base,
//     {
//       // project-specific overrides here
//     },
//   ];
//
// Running:
//   /root/shared/eslint/node_modules/.bin/eslint .
//
// Or add a package.json script:
//   "lint": "/root/shared/eslint/node_modules/.bin/eslint ."
//
// The primary goal of this config is to catch the class of bugs we hit in
// April 2026 where code referenced functions/variables that didn't exist
// (e.g. navigation.canGoBack on a custom nav object, deleteConversation on
// a store that didn't export it, etc). The `no-undef` + import-style rules
// below would have caught every one of those at write time.

import js from '@eslint/js';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  // Ignore generated + vendor code
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.expo/**',
      '**/coverage/**',
      '**/android/**',
      '**/ios/**',
      '**/_pgbackup/**',
      '**/.next/**',
      '**/public/assets/**',
      '**/*.d.ts',   // TypeScript declaration files — checked by tsc, not ESLint
    ],
  },

  // Base recommended JS rules
  js.configs.recommended,

  // ── JS / JSX source files ────────────────────────────────────────
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2024,
        // React Native globals
        __DEV__: 'readonly',
        ErrorUtils: 'readonly',
        HermesInternal: 'readonly',
      },
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      // ── Critical: catch undefined references ───────────────────
      // These rules prevent today's bug class.
      'no-undef': 'error',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        // Allow unused imports named "React" (modern JSX transform doesn't need them
        // but they're often still imported out of habit) and any var starting with _.
        varsIgnorePattern: '^(_|React$)',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],

      // ── React hooks correctness ────────────────────────────────
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // ── React best practices (low noise) ───────────────────────
      'react/jsx-uses-react': 'off',        // not needed in modern RN/Vite
      'react/react-in-jsx-scope': 'off',    // not needed in modern RN/Vite
      'react/jsx-uses-vars': 'error',       // catches unused JSX references
      'react/jsx-no-undef': 'error',        // catches <UnknownComponent />
      'react/no-children-prop': 'warn',
      'react/no-direct-mutation-state': 'error',
      'react/prop-types': 'off',            // not using PropTypes

      // ── General correctness ────────────────────────────────────
      'no-console': 'off',                  // console.log is fine
      'no-debugger': 'warn',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-irregular-whitespace': 'error',
      'no-unreachable': 'error',
      'no-unsafe-negation': 'error',
      // Allow hoisted references to top-level const (e.g. `const styles = StyleSheet.create()`
      // defined at the bottom of a React Native file, referenced by a component above — this
      // is an idiomatic pattern and actually works at runtime).
      'no-use-before-define': ['error', { functions: false, classes: true, variables: false }],
      'valid-typeof': 'error',

      // ── Style (loose — not about enforcing opinions) ───────────
      'no-var': 'warn',
      'prefer-const': ['warn', { destructuring: 'all' }],
      'eqeqeq': ['warn', 'smart'],
    },
  },

  // ── Config files (relax a few rules) ─────────────────────────────
  {
    files: ['**/*.config.{js,mjs,cjs}', '**/vite.config.*', '**/metro.config.*'],
    rules: {
      'no-unused-vars': 'off',
    },
  },

  // ── Backend services: prefer structured logging over console.* ──
  // Backend code should use Fastify's pino logger (req.log.info / fastify.log.warn)
  // or a module-level pino instance — emits structured JSON that integrates with
  // log aggregators. console.* writes plain strings and can't be filtered by level
  // or queried by field. Warn (don't error) so existing code keeps building.
  // Allowlist: cron entry points + diagnostic scripts where stdout IS the log.
  // Glob matches both fully-qualified paths (linting from repo root) and
  // path-relative invocations (eslint services/api/src).
  {
    files: ['**/services/api/src/lib/**/*.{js,mjs,ts}', '**/services/api/src/routes/**/*.{js,mjs,ts}', '**/services/api/src/ws/**/*.{js,mjs,ts}'],
    rules: {
      'no-console': ['warn', { allow: [] }],
    },
  },
];
