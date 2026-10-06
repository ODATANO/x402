import { isSupportedTransferMethod, transferMethodOf } from '../core/transfer-method';
import type { PaymentRequirementEntry } from '../core/types';

/** Default `selectAccepts`: first entry whose transfer method this library supports. */
export function selectFirstSupported(accepts: PaymentRequirementEntry[]): PaymentRequirementEntry | undefined {
  return accepts.find(e => isSupportedTransferMethod(transferMethodOf(e)));
}
