/**
 * Who paid: the bech32 address of the nonce UTxO.
 *
 * The envelope's replay nonce is a UTxO the buyer owns and spends in the
 * payment (checks 5a/5b). Its address is therefore the buyer's, proven by
 * the signature that spent it, and the one address a resource server can
 * trust for "bind this purchase to the payer" (grants, address-bound keys).
 * One extra `getTransactionByHash` on the nonce's tx, best-effort: any
 * backend hiccup or an unknown output leaves `payerAddr` unset, it never
 * rejects a payment.
 */

import cds from '@sap/cds';
import * as bridge from '../bridge';

const log = cds.log('x402');

interface TxOutputLite { address?: string; outputIndex?: number }
interface TxLite { outputs?: TxOutputLite[] }

export async function resolvePayerAddress(nonce: { txHash: string; index: number }): Promise<string | undefined> {
  let tx: TxLite | null;
  try {
    tx = await bridge.getTransactionByHash(nonce.txHash) as TxLite | null;
  } catch (err) {
    log.debug(`payer address: getTransactionByHash(${nonce.txHash}) failed: ${(err as Error)?.message ?? err}`);
    return undefined;
  }
  const outputs = Array.isArray(tx?.outputs) ? tx!.outputs! : [];
  // Prefer the explicit index the backend reports; fall back to position.
  const out = outputs.find((o) => o?.outputIndex === nonce.index) ?? outputs[nonce.index];
  const address = typeof out?.address === 'string' && out.address.length > 0 ? out.address : undefined;
  if (!address) log.debug(`payer address: output ${nonce.txHash}#${nonce.index} not resolvable`);
  return address;
}
