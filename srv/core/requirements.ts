/**
 * Build `PaymentRequirements` entries and the `PaymentRequired` object of a
 * 402 answer (x402 v2).
 *
 * Asset-agnostic: the consumer passes a v2 asset string (`'lovelace'` or
 * `<policy>.<nameHex>`), a bech32 `payTo` and a network. The resource is
 * described once per `PaymentRequired`, not per entry.
 */

import { parseNetwork, type Network } from './network';
import { parseAsset } from './asset';
import { transferExtraProblem } from './transfer';
import type {
  ConfirmationPolicy,
  Extensions,
  PaymentExtra,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  RouteOption,
} from './types';

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export interface BuildRequirementsArgs {
  amount: string | number | bigint;
  /** `'lovelace'` or `<policy>.<nameHex>`. */
  asset: string;
  /** Bech32 recipient. */
  payTo: string;
  network: Network | string;
  /** default 600 */
  maxTimeoutSeconds?: number;
  /** Transfer method plus free-form extras. */
  extra?: PaymentExtra;
  /** Written to `extra.confirmationPolicy` unless `extra` sets one. */
  confirmationPolicy?: ConfirmationPolicy;
}

/** Throws unless `policy` is an integer `l1Confirmations` in -1..20. */
export function assertConfirmationPolicy(policy: unknown): asserts policy is ConfirmationPolicy {
  const n = (policy as ConfirmationPolicy | undefined)?.l1Confirmations;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < -1 || n > 20) {
    throw new Error('confirmationPolicy.l1Confirmations must be an integer from -1 to 20');
  }
}

/** One `accepts[]` entry. Throws on invalid input so a misconfigured seller fails on its own server. */
export function buildRequirements(args: BuildRequirementsArgs): PaymentRequirements {
  if (!args.payTo) throw new Error('buildRequirements: payTo is required');
  const network = parseNetwork(args.network);
  const parsedAsset = parseAsset(args.asset);
  const amount = String(args.amount);
  if (!/^\d+$/.test(amount) || /^0+$/.test(amount)) {
    throw new Error(`buildRequirements: amount must be a positive integer (got '${amount}')`);
  }
  const transferProblem = transferExtraProblem(args.extra, args.payTo);
  if (transferProblem) throw new Error(`buildRequirements: ${transferProblem}`);

  const policy = args.extra?.confirmationPolicy ?? args.confirmationPolicy;
  if (policy !== undefined) assertConfirmationPolicy(policy);

  return {
    scheme:            'exact',
    network,
    asset:             parsedAsset.raw,
    amount,
    payTo:             args.payTo,
    maxTimeoutSeconds: args.maxTimeoutSeconds ?? 600,
    extra: {
      ...args.extra,
      areFeesSponsored: false,
      ...(policy !== undefined ? { confirmationPolicy: policy } : {}),
    } as PaymentExtra,
  };
}

/** Checks the spec limits of the optional `ResourceInfo` fields; throws on violation. */
export function normalizeResource(resource: ResourceInfo | string): ResourceInfo {
  const r: ResourceInfo = typeof resource === 'string' ? { url: resource } : { ...resource };
  if (!r.url) throw new Error('resource.url is required');
  if (r.serviceName !== undefined && (r.serviceName.length > 32 || !PRINTABLE_ASCII.test(r.serviceName))) {
    throw new Error('resource.serviceName must be printable ASCII, max 32 chars');
  }
  if (r.tags !== undefined
    && (r.tags.length > 5 || r.tags.some(t => t.length > 32 || !PRINTABLE_ASCII.test(t)))) {
    throw new Error('resource.tags: max 5 entries, each printable ASCII, max 32 chars');
  }
  if (r.iconUrl !== undefined && (r.iconUrl.length > 2048 || !/^https?:\/\//.test(r.iconUrl))) {
    throw new Error('resource.iconUrl must be an absolute http(s) URL, max 2048 chars');
  }
  return r;
}

export interface BuildPaymentRequiredArgs {
  /**
   * Payment options the seller advertises. MUST be non-empty. Each option
   * inherits `payTo`, `network`, `asset`, `maxTimeoutSeconds`, `extra`
   * and `confirmationPolicy` unless it sets its own. An option's `extra`
   * replaces the default `extra`, it is not merged.
   */
  options: RouteOption[];
  payTo: string;
  network: Network | string;
  asset?: string;
  maxTimeoutSeconds?: number;
  extra?: PaymentExtra;
  confirmationPolicy?: ConfirmationPolicy;
  /** A string is shorthand for `{ url }`. */
  resource: ResourceInfo | string;
  error?: string;
  extensions?: Extensions;
}

/** The `PaymentRequired` object of a 402 answer. */
export function buildPaymentRequired(args: BuildPaymentRequiredArgs): PaymentRequired {
  if (!args.options || args.options.length === 0) {
    throw new Error('buildPaymentRequired: options must be non-empty');
  }
  const accepts = args.options.map((opt) => {
    const asset = opt.asset ?? args.asset;
    if (!asset) {
      throw new Error('buildPaymentRequired: option is missing `asset` and no default was set');
    }
    const maxTimeoutSeconds = opt.maxTimeoutSeconds ?? args.maxTimeoutSeconds;
    const extra = opt.extra ?? args.extra;
    return buildRequirements({
      amount:  opt.amount,
      asset,
      payTo:   opt.payTo ?? args.payTo,
      network: opt.network ?? args.network,
      ...(maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds } : {}),
      ...(extra !== undefined ? { extra } : {}),
      ...(args.confirmationPolicy !== undefined ? { confirmationPolicy: args.confirmationPolicy } : {}),
    });
  });

  return {
    x402Version: 2,
    ...(args.error !== undefined ? { error: args.error } : {}),
    resource: normalizeResource(args.resource),
    accepts,
    ...(args.extensions !== undefined ? { extensions: args.extensions } : {}),
  };
}
