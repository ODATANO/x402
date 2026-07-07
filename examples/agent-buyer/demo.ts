/**
 * Scripted MCP client that drives server.ts the way an AI agent would:
 * check the wallet, probe the offer, decide, buy. Doubles as the E2E
 * test for the server, no LLM required.
 *
 * Usage:
 *   NETWORK=preview BACKENDS=blockfrost BLOCKFROST_API_KEY=... npm run demo [-- <url>]
 * (start examples/cap-app as the seller first)
 */

import { createRequire } from 'module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const url = process.argv[2] ?? 'http://localhost:4004/odata/v4/prices/Quotes';
// tsx may be hoisted to the workspace root; resolve its CLI entry explicitly.
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

function printResult(label: string, result: unknown) {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const body = content.find(c => c.type === 'text')?.text ?? JSON.stringify(result);
  console.log(`\n=== ${label} ===`);
  console.log(body);
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, 'server.ts'],
    env: process.env as Record<string, string>,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'agent-buyer-demo', version: '0.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log('tools:', tools.tools.map(t => t.name).join(', '));

  printResult('wallet_status', await client.callTool({ name: 'wallet_status', arguments: {} }));
  printResult('get_offer', await client.callTool({ name: 'get_offer', arguments: { url } }));
  printResult('buy_data', await client.callTool({ name: 'buy_data', arguments: { url } }));

  await client.close();
}

main().catch(err => {
  console.error('demo failed:', err);
  process.exit(1);
});
