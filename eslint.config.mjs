import cds from '@sap/cds/eslint.config.mjs'

export default [
  // Skip tsc-emitted artefacts and generated/build directories.
  // tsc emits .js/.d.ts next to the .ts sources (outDir: ".") and
  // preserves `// eslint-disable-next-line @typescript-eslint/...`
  // comments. eslint doesn't load the TS plugin for plain .js, so
  // those disable directives raise "rule not found" if we lint them.
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
  ...cds.recommended,
]
