import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import sveltePlugin from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  // Base recommended rules
  js.configs.recommended,

  // Global settings for all files
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2020,
        chrome: 'readonly',
        module: 'readonly',
      },
    },
    rules: {
      // Downgrade to warnings for existing codebase compatibility
      'no-case-declarations': 'warn',
      'no-empty': 'warn',
      'no-useless-escape': 'warn',
      'no-useless-catch': 'warn',
      'require-yield': 'warn',
      'no-unused-vars': 'warn',
      'no-global-assign': 'warn',
      'no-dupe-else-if': 'warn',
    },
  },

  // TypeScript files
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      // Disable base rules handled by TypeScript
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-redeclare': 'off',
      // Relax rules to match original config behavior
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },

  // Svelte files
  ...sveltePlugin.configs['flat/recommended'],
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tsParser,
      },
    },
    rules: {
      // Disable rules that conflict with Svelte
      'no-undef': 'off',
      'no-unused-vars': 'off',
      // Downgrade svelte rules to warnings for existing codebase
      'svelte/infinite-reactive-loop': 'warn',
      'svelte/require-each-key': 'warn',
      'svelte/require-event-dispatcher-types': 'warn',
      'svelte/no-at-html-tags': 'warn',
      'svelte/no-immutable-reactive-statements': 'warn',
      'svelte/no-unused-svelte-ignore': 'warn',
      'svelte/no-reactive-literals': 'warn',
    },
  },

  // Prettier (disables formatting rules)
  prettier,

  // Ignores
  {
    ignores: [
      'node_modules/',
      'dist/',
      'build/',
      'coverage/',
      '**/*.min.js',
      '.vite/',
      'vite.config.ts',
      'vitest.config.ts',
      'vite.config.*.mjs',
      'vite.config.*.mts',
      'vitest.config.mjs',
      'eslint.config.js',
    ],
  },
];
