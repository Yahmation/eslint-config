# @yahmation/eslint-config

Shared ESLint flat config for all Yahmation projects (web + mobile + API).

## What it catches

The primary goal is to catch the class of bugs we hit in April 2026 where code referenced functions/variables that didn't exist — e.g. `navigation.canGoBack` on a custom nav object, `deleteConversation` on a store that didn't export it, etc. The `no-undef` + `rules-of-hooks` rules below would have caught every one of those at write time.

- `no-undef: 'error'` — catches undefined global / missing imports
- `no-unused-vars: 'warn'` with sensible ignores
- `react-hooks/rules-of-hooks: 'error'`
- `react-hooks/exhaustive-deps: 'warn'`
- `react/jsx-no-undef: 'error'`
- Sane `no-use-before-define` for React Native's `const styles = StyleSheet.create(...)` pattern at the bottom of a file
- Style nudges: `no-var`, `prefer-const`, `eqeqeq`

## Install

```bash
npm install --save-dev github:Yahmation/eslint-config
```

You also need `eslint` itself in your project (it's a transitive dep of this package, so `npm install` will bring it in).

## Use

Create `eslint.config.mjs` at your project root:

```js
import base from '@yahmation/eslint-config';

export default [
  ...base,
  {
    // project-specific overrides here
    ignores: ['**/dist/**', '**/public/**'],
  },
];
```

Then run:

```bash
./node_modules/.bin/eslint .
```

Or add a script to your `package.json`:

```json
"scripts": {
  "lint": "eslint .",
  "lint:fix": "eslint . --fix"
}
```

## Pre-commit hook (Husky + lint-staged)

```json
"scripts": {
  "prepare": "husky"
},
"lint-staged": {
  "*.{js,jsx,ts,tsx,mjs,cjs}": "eslint --max-warnings=100"
}
```

And `.husky/pre-commit`:

```sh
npx lint-staged
```

## Updating

This package pins ESLint 9.15+ and all plugins. Bump versions by updating `package.json` and publishing a new release tag on GitHub. Consumers will pick it up on their next `npm install`.
