import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

const sourceFiles = [
  '**/*.{js,mjs,cjs,jsx}',
]

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'tui/native/**',
    ],
  },
  {
    files: sourceFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-dupe-else-if': 'error',
      'no-fallthrough': 'error',
      'no-irregular-whitespace': 'error',
      'no-loss-of-precision': 'error',
      'no-self-assign': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
        varsIgnorePattern: '^_',
      }],
      'no-useless-catch': 'error',
      'no-useless-escape': 'error',
      'no-with': 'error',
      'valid-typeof': 'error',
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
  {
    files: ['**/test/**/*.{js,mjs,cjs,jsx}', 'test/**/*.{js,mjs,cjs,jsx}'],
    rules: {
      'no-useless-escape': 'off',
    },
  },
  {
    files: ['web/src/**/*.{js,jsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
]
