/**
 * Build the canonical Cardano-x402-v2 PaymentRequirements body.
 *
 * Asset-agnostic by design, the consumer passes a v2 asset string
 * (`<policy>.<nameHex>` or `'lovelace'`), a payTo bech32, a network, and
 * a resource descriptor. There is NO USDM default and no decimals
 * assumption, both belong to the consumer's product config.
 *
 * The v2 shape diverges from v1 in five places (see `docs/spec-v2-summary.md`
 * once written):
 *   1. `x402Version: 2`               (was 1)
 *   2. `accepts[].amount`             (was `maxAmountRequired`)
 *   3. `accepts[].asset` is a single  (was split: `asset` + `extra.assetNameHex`)
 *      string `<policy>.<nameHex>` or `'lovelace'`
 *   4. `accepts[].resource` is an     (was a string)
 *      object `{ url, description, mimeType }`
 *   5. `accepts[].assetTransferMethod`(new field)
 */

import { parseNetwork, type Network } from './network';
import { parseAsset } from './asset';
import type {
  PaymentRequirementEntry,
  PaymentRequirementsBody,
  ResourceDescriptor,
  AssetTransferMethod,
  RouteOption,
} from './types';

export interface BuildPaymentRequirementsArgs {
  /** Asset amount in raw units (BigInt-safe). */
  amount: string | number | bigint;
  asset: string;                    // 'lovelace' or '<policy>.<nameHex>'
  payTo: string;                    // bech32
  network: Network | string;        // 'cardano:mainnet|preprod|preview'
  resource: ResourceDescriptor | string; // string is sugar for { url, description: '', mimeType: 'application/json' }
  description?: string;             // overrides resource.description when resource is a string
  mimeType?: string;                // overrides resource.mimeType when resource is a string
  outputSchema?: unknown;
  assetTransferMethod?: AssetTransferMethod; // default: 'default'
  maxTimeoutSeconds?: number;       // default: 600
  /** Free-form extras (decimals, fingerprint, UI hints). */
  extra?: Record<string, unknown>;
  /**
   * If true, prepend the standard 'PAYMENT-SIGNATURE header is required'
   * error string. Used for the missing-header path; omit for downstream
   * rejection bodies where the caller sets a more specific `error`.
   */
  withMissingHeaderError?: boolean;
}

function normalizeResource(
  resource: ResourceDescriptor | string,
  description: string | undefined,
  mimeType: string | undefined,
  outputSchema: unknown,
): ResourceDescriptor {
  if (typeof resource === 'string') {
    return {
      url:          resource,
      description:  description ?? '',
      mimeType:     mimeType ?? 'application/json',
      ...(outputSchema !== undefined ? { outputSchema } : {}),
    };
  }
  // Object form: caller's fields win, but allow per-call overrides.
  return {
    url:          resource.url,
    description:  description ?? resource.description ?? '',
    mimeType:     mimeType ?? resource.mimeType ?? 'application/json',
    ...(outputSchema !== undefined
        ? { outputSchema }
        : (resource.outputSchema !== undefined ? { outputSchema: resource.outputSchema } : {})),
  };
}

/**
 * Construct a single `accepts[]` entry. Most callers want
 * `buildPaymentRequirements()` which wraps this in the 402 envelope ,
 * use `buildEntry()` directly when composing multi-asset accept lists.
 */
export function buildEntry(args: BuildPaymentRequirementsArgs): PaymentRequirementEntry {
  if (!args.payTo) throw new Error('buildEntry: payTo is required');
  const network = parseNetwork(args.network);
  const parsedAsset = parseAsset(args.asset);
  const amount = String(args.amount);
  if (!/^\d+$/.test(amount) || amount === '0') {
    throw new Error(`buildEntry: amount must be a positive integer (got '${amount}')`);
  }

  const resource = normalizeResource(args.resource, args.description, args.mimeType, args.outputSchema);

  return {
    scheme:               'exact',
    network,
    asset:                parsedAsset.raw,
    amount,
    payTo:                args.payTo,
    resource,
    assetTransferMethod:  args.assetTransferMethod ?? 'default',
    maxTimeoutSeconds:    args.maxTimeoutSeconds ?? 600,
    ...(args.extra ? { extra: args.extra } : {}),
  };
}

export function buildPaymentRequirements(args: BuildPaymentRequirementsArgs): PaymentRequirementsBody {
  const accepts = [buildEntry(args)];
  return {
    x402Version: 2,
    ...(args.withMissingHeaderError ? { error: 'PAYMENT-SIGNATURE header is required' } : {}),
    accepts,
  };
}

/** Pick the first `accepts[]` entry, what the validator inspects. */
export function flatRequirements(body: PaymentRequirementsBody): PaymentRequirementEntry {
  if (!body.accepts || body.accepts.length === 0) {
    throw new Error('flatRequirements: PaymentRequirementsBody.accepts is empty');
  }
  return body.accepts[0]!;
}

// ─── Multi-accept builder ────────────────────────────────────────────────

export interface BuildMultiArgs {
  /**
   * Payment options the seller advertises. Buyer picks one implicitly by
   * which (payTo, asset) the payment tx actually credits. MUST be non-empty.
   */
  options: RouteOption[];
  /** Default recipient if a `RouteOption` omits `payTo`. */
  payTo: string;
  /** Default network if a `RouteOption` omits `network`. */
  network: Network | string;
  /** Default asset if a `RouteOption` omits `asset`. */
  asset?: string;
  resource: ResourceDescriptor | string;
  description?: string;
  mimeType?: string;
  outputSchema?: unknown;
  assetTransferMethod?: AssetTransferMethod;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
  /** Same as the single-entry builder's flag. See `BuildPaymentRequirementsArgs`. */
  withMissingHeaderError?: boolean;
}

/**
 * Build a multi-entry `accepts[]` body. Each option inherits the
 * top-level `payTo` / `network` / `asset` / etc. defaults unless it sets
 * its own. The `resource` block is shared across all entries (a 402 is
 * for one route, even when it offers many payment options).
 *
 * Single-entry callers should keep using `buildPaymentRequirements()`;
 * this function is the path for the multi-accept feature.
 */
export function buildPaymentRequirementsMulti(args: BuildMultiArgs): PaymentRequirementsBody {
  if (!args.options || args.options.length === 0) {
    throw new Error('buildPaymentRequirementsMulti: options must be non-empty');
  }

  const accepts = args.options.map((opt) => {
    const asset = opt.asset ?? args.asset;
    if (!asset) {
      throw new Error(
        'buildPaymentRequirementsMulti: option is missing `asset` and no top-level default was set',
      );
    }
    return buildEntry({
      amount:               opt.amount,
      asset,
      payTo:                opt.payTo ?? args.payTo,
      network:              opt.network ?? args.network,
      resource:             args.resource,
      description:          opt.description ?? args.description,
      mimeType:             opt.mimeType ?? args.mimeType,
      outputSchema:         args.outputSchema,
      assetTransferMethod:  opt.assetTransferMethod ?? args.assetTransferMethod,
      maxTimeoutSeconds:    opt.maxTimeoutSeconds   ?? args.maxTimeoutSeconds,
      extra:                opt.extra              ?? args.extra,
    });
  });

  return {
    x402Version: 2,
    ...(args.withMissingHeaderError ? { error: 'PAYMENT-SIGNATURE header is required' } : {}),
    accepts,
  };
}
