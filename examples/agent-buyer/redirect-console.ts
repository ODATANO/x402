/**
 * MUST be the first import of server.ts.
 *
 * MCP over stdio owns stdout: every byte on it must be a JSON-RPC frame.
 * `@sap/cds` / `@odatano/core` log through console.* (stdout) during init,
 * which would corrupt the transport. Reroute all console output to stderr,
 * where MCP hosts show it as server logs.
 */

console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

export {};
