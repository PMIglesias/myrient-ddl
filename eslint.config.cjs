const js = require('@eslint/js');
const vue = require('eslint-plugin-vue');
const prettier = require('eslint-config-prettier');
const globals = require('globals');
const parser = require('vue-eslint-parser');

module.exports = [
  // Configuración base de ESLint
  js.configs.recommended,
  
  // Desactiva reglas de formato que entran en conflicto con Prettier
  prettier,
  
  // Configuración para archivos JavaScript
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
      },
    },
    rules: {
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'no-debugger': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      // Permitir variables no usadas que empiecen con _ o estén en catch blocks
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_|^(e|error|.*Error)$',
        },
      ],
      // Permitir declaraciones en case blocks si están en bloques
      'no-case-declarations': 'off',
      // Advertir sobre escape innecesario
      'no-useless-escape': 'warn',
    },
  },
  
  // Configuración para archivos Vue usando configs flat
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: parser,
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        console: 'readonly',
      },
    },
    rules: {
      // Reglas personalizadas
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'no-debugger': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'warn',
      // Permitir variables no usadas que empiecen con _ o estén en catch blocks
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_|^(e|error|.*Error)$',
        },
      ],
      // Permitir declaraciones en case blocks si están en bloques
      'no-case-declarations': 'off',
    },
  },
  
  // Ignorar directorios y archivos de configuración
  {
    ignores: [
      'dist-electron/**',
      'dist/**',
      'node_modules/**',
      '*.db',
      '*.log',
      'package-lock.json',
      'eslint.config.cjs', // No lintear el archivo de configuración de ESLint
      'vite.config.js', // No lintear el archivo de configuración de Vite
    ],
  },
];
