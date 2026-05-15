import cds from '@sap/cds/eslint.config.mjs'
import tseslint from 'typescript-eslint'

export default [
  // Skip tsc-emitted artefacts and generated/build directories.
  // tsc emits .js/.d.ts next to the .ts sources (outDir: ".") and
  // preserves `// eslint-disable-next-line @typescript-eslint/...`
  // comments. Linting those compiled files yields false positives.
  {
    ignores: [
      'srv/**/*.js',
      'srv/**/*.d.ts',
      'srv/**/*.d.ts.map',
      'srv/**/*.js.map',
      'test/**/*.js',
      'test/**/*.d.ts',
      'examples/**/srv/**/*.js',
      'examples/**/srv/**/*.d.ts',
      'examples/**/gen/**',
      'coverage/**',
      'gen/**',
    ],
  },
  // @sap/cds defaults cover .js/.cjs/.mjs only; we extend with the
  // TypeScript-ESLint recommended set so .ts sources actually get linted.
  ...cds.recommended,
  ...tseslint.configs.recommended,
]
