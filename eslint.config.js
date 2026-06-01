import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

// why: ESLint v9 flat config. eslint-config-prettier last so it disables any
// stylistic rules that would conflict with Prettier.
export default [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // why: Node + Web Platform globals available in modern Node (20+).
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        ReadableStream: 'readonly',
      },
    },
  },
  prettier,
];
