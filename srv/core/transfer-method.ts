/** Dependency-free transfer-method helpers, safe for browser bundles. */

import type { PaymentExtra, PaymentRequirementEntry, ScriptTransferExtra } from './types';

/** Methods this library builds requirements for and verifies. */
export const SUPPORTED_TRANSFER_METHODS = ['default', 'script'] as const;

/** `extra.assetTransferMethod`, `'default'` when absent. */
export function transferMethodOf(entry: Pick<PaymentRequirementEntry, 'extra'>): string {
  const method = entry.extra?.assetTransferMethod;
  return typeof method === 'string' ? method : 'default';
}

export function isSupportedTransferMethod(method: string): boolean {
  return (SUPPORTED_TRANSFER_METHODS as readonly string[]).includes(method);
}

export function isScriptExtra(extra: PaymentExtra | undefined): extra is ScriptTransferExtra {
  return extra?.assetTransferMethod === 'script';
}
