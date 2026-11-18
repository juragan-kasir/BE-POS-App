export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.wwebjs_auth*/**',
      '**/.wwebjs_auth_default*/**'
    ]
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        Promise: 'readonly',
        Math: 'readonly',
        Date: 'readonly',
        JSON: 'readonly',
        Array: 'readonly',
        Object: 'readonly',
        String: 'readonly',
        Number: 'readonly',
        Boolean: 'readonly',
        Error: 'readonly',
        TypeError: 'readonly',
        RegExp: 'readonly',
        Map: 'readonly',
        Set: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      'no-unsafe-finally': 'warn',
      'no-console': 'off'
    }
  },
  {
    // Undefined identifiers are runtime ReferenceErrors (BE audit 2026-11-18:
    // the Cash Flow Excel export crashed on an undefined `argb` for a month
    // because this rule was off). Scoped to the application code CI lints;
    // tests run under Jest globals.
    files: ['api/**/*.js', 'utils/**/*.js'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        structuredClone: 'readonly',
        queueMicrotask: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Intl: 'readonly',
        Symbol: 'readonly',
        WeakMap: 'readonly',
        WeakSet: 'readonly',
        Reflect: 'readonly',
        BigInt: 'readonly',
        RangeError: 'readonly',
        SyntaxError: 'readonly',
        isNaN: 'readonly',
        isFinite: 'readonly',
        parseInt: 'readonly',
        parseFloat: 'readonly',
        encodeURIComponent: 'readonly',
        decodeURIComponent: 'readonly',
        encodeURI: 'readonly',
        global: 'readonly',
        globalThis: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error'
    }
  },
  {
    // Sequelize CLI passes (queryInterface, Sequelize) even when unused
    files: ['db/migrations/**', 'db/seeders/**'],
    rules: {
      'no-unused-vars': 'off'
    }
  }
]