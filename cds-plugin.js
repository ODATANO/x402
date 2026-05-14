/**
 * CAP plugin entry. CDS picks this up automatically when @odatano/x402
 * is present in node_modules — it imports the compiled plugin module
 * which registers the served / shutdown hooks.
 *
 * The .ts source is at srv/plugin.ts; tsc emits srv/plugin.js in-place
 * (outDir: ".") so this require path resolves both in dev (tsx) and
 * after `npm run build`.
 */
module.exports = require('./srv/plugin');
