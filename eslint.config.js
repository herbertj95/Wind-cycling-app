import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

// Files that run under Node (tooling config and maintenance scripts), not in the browser.
const nodeFiles = ['vite.config.js', 'eslint.config.js', 'scripts/**/*.mjs']

export default defineConfig([
  globalIgnores([
    // Build output
    'dist',
    'dist-ssr',
    'coverage',
    // Native Android project: Gradle output plus a copy of the minified web bundle
    'android',
    // Dependencies and local agent/tooling directories (see .gitignore)
    'node_modules',
    '.agents',
    '.playwright-mcp',
  ]),
  {
    // Browser code: the React app and its tests (tests import their helpers from 'vitest')
    files: ['**/*.{js,jsx}'],
    ignores: nodeFiles,
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // Node-side files: Node globals instead of browser globals, no React rules
    files: nodeFiles,
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
])
