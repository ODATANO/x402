/**
 * Facilitator interface of x402 v2 (§7): `verify` (read-only), `settle`
 * (submit and confirm) and `supported` (discovery).
 *
 *   - `localFacilitator()` runs both in-process via `@odatano/core`.
 *   - `httpFacilitator()` calls any x402 v2 facilitator over HTTP.
 *   - `createFacilitatorRouter()` serves a facilitator over HTTP.
 */

import * as bridge from '../bridge';
import { runVerify } from './verify';
import { runSettle, type SettleContext } from './settle';
import { memorySettlementStore, type SettlementStore } from './store';
import { SUPPORTED_TRANSFER_METHODS } from '../core/transfer-method';
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettlementResponse,
  VerifyResponse,
} from '../core/types';

export interface SupportedKind {
  x402Version: 2;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

/** The facilitator's `/supported` answer. */
export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions: string[];
  /** CAIP-2 pattern → signer addresses. Empty: a Cardano facilitator signs nothing. */
  signers: Record<string, string[]>;
}

export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettlementResponse>;
  supported?(): Promise<SupportedResponse>;
}

export interface LocalFacilitatorOptions {
  /** default in-process store; share one store across instances serving the same payees */
  store?: SettlementStore;
  /** default 75_000; how long one settle waits for the required confirmations */
  settlePollBudgetMs?: number;
  /** default 3_000 */
  pollIntervalMs?: number;
  /** default 3_600_000; claim retention past the TTL */
  claimGraceMs?: number;
  /** default false; accept `l1Confirmations: -1` (broadcast acceptance only, can be rolled back) */
  allowMempoolConfirmation?: boolean;
}

const NETWORKS: Network[] = ['cardano:mainnet', 'cardano:preprod', 'cardano:preview'];

let shared: Facilitator | undefined;

/**
 * The process-wide default facilitator. Every gate without its own
 * `facilitator` uses this one, so they share the settlement claims and one
 * payment cannot be delivered by two gates.
 */
export function defaultFacilitator(): Facilitator {
  return shared ??= localFacilitator();
}

/** In-process facilitator on `@odatano/core`. Holds the settlement store, so create it once per process. */
export function localFacilitator(opts: LocalFacilitatorOptions = {}): Facilitator {
  const ctx: SettleContext = {
    store:                    opts.store ?? memorySettlementStore(),
    allowMempoolConfirmation: opts.allowMempoolConfirmation ?? false,
    pollBudgetMs:             opts.settlePollBudgetMs ?? 75_000,
    pollIntervalMs:           opts.pollIntervalMs ?? 3_000,
    claimGraceMs:             opts.claimGraceMs ?? 3_600_000,
  };
  return {
    verify: async (payload, requirements) => (await runVerify(payload, requirements, ctx)).response,
    settle: (payload, requirements) => runSettle(payload, requirements, ctx),
    async supported() {
      // Only the network the backend is on can be verified and settled.
      const backend = await bridge.getBackendNetwork();
      const networks = NETWORKS.filter(n => !backend || n === backend);
      return {
        kinds: networks.map(network => ({
          x402Version: 2 as const,
          scheme:      'exact',
          network,
          extra: {
            assetTransferMethods: [...SUPPORTED_TRANSFER_METHODS],
            areFeesSponsored:     false,
            l1Confirmations:      { minimum: ctx.allowMempoolConfirmation ? -1 : 0, maximum: 20 },
          },
        })),
        extensions: [],
        signers:    {},
      };
    },
  };
}
