import { isSupportedTransferMethod, transferMethodOf } from '../core/transfer-method';
import type { PaymentRequirements } from '../core/types';

/**
 * Default `selectAccepts`: first entry with a supported transfer method and
 * the `authorization` payment flow (absent means `authorization`).
 */
export function selectFirstSupported(accepts: PaymentRequirements[]): PaymentRequirements | undefined {
  return accepts.find(e =>
    isSupportedTransferMethod(transferMethodOf(e))
    && (e.extra?.paymentFlow === undefined || e.extra.paymentFlow === 'authorization'));
}
