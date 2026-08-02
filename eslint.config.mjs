import tsParser from '@typescript-eslint/parser';

// The single cheapest thing preventing the architecture from eroding
// (spec §6): nothing under src/pure/ may touch an Apps Script global.
// The list covers the spec's six plus the other ambient Apps Script
// services that could sneak I/O or environment access into pure code.
const APPS_SCRIPT_GLOBALS = [
  'GmailApp',
  'DriveApp',
  'Drive',
  'Gmail',
  'SpreadsheetApp',
  'Utilities',
  'UrlFetchApp',
  'PropertiesService',
  'MailApp',
  'ScriptApp',
  'Session',
  'CacheService',
  'LockService',
  'Logger',
];

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2019,
      sourceType: 'module',
    },
  },
  {
    files: ['src/pure/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...APPS_SCRIPT_GLOBALS.map((name) => ({
          name,
          message: `src/pure/ must not reference ${name}; pass data in, return data out (spec §6).`,
        })),
      ],
    },
  },
];
