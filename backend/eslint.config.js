/*
  eslint.config.js — minimal flat config for the backend only.
  Frontend (vanilla JS pages) is intentionally out of scope for now;
  it gets linted when it moves under a build step, if ever.
*/

const js      = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'logs/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType:  'commonjs',
      globals:     { ...globals.node },
    },
    rules: {
      // Express error middleware must declare 4 args even when `next` is unused
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^next$' }],
    },
  },
];
