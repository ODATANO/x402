// decodePayment pulls in srv/bridge → @odatano/core; stub the barrel to its pure parser.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@odatano/core', () => require('../fixtures/core-parse-mock').coreParseMock());

import { Address, Credential } from '@harmoniclabs/buildooor';
import { validatePayment, matchOutput, buildClaim } from '../../srv/core/validate';
import { decodePayment } from '../../srv/core/decode';
import { Codes } from '../../srv/core/errors';
import {
  BUYER_PRIV, BUYER_ADDR, SELLER_ADDR, SELLER_VKH,
  NONCE_TX_HASH, NONCE_INDEX, NONCE_REF,
  CURRENT_SLOT, TTL_SLOT, MAX_TTL_SLOT, PAST_SLOT,
  TEST_POLICY_ID, TEST_ASSET_NAME, TEST_ASSET_STRING, TEST_ASSET_UNIT,
  NETWORK_PREPROD,
} from '../fixtures/constants';
import { buildBody, signTx, buildUnsigned, type TestOutput } from '../fixtures/build-tx';
import type { DecodedPayment, PaymentExtra, PaymentRequirements } from '../../srv/core/types';

const SELLER_MAINNET = Address.mainnet(Credential.keyHash(SELLER_VKH)).toString();

function requirements(change: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact', network: NETWORK_PREPROD, asset: 'lovelace', amount: '1000000',
    payTo: SELLER_ADDR, maxTimeoutSeconds: 600, extra: { areFeesSponsored: false }, ...change,
  };
}

interface TxArgs {
  outputs?: TestOutput[];
  ttlSlot?: number | null;
  validityStartSlot?: number;
  inputTxHash?: string;
  signed?: boolean;
  /** false builds a tx that declares a failing script. */
  scriptValid?: boolean;
}

function decoded(args: TxArgs = {}): DecodedPayment {
  const body = buildBody({
    inputs: [{ txHash: args.inputTxHash ?? NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
    outputs: args.outputs ?? [{ address: SELLER_ADDR, lovelace: '1000000' }, { address: BUYER_ADDR, lovelace: '5000000' }],
    ...(args.ttlSlot === null ? {} : { ttlSlot: args.ttlSlot ?? TTL_SLOT }),
    ...(args.validityStartSlot !== undefined ? { validityStartSlot: args.validityStartSlot } : {}),
  });
  const tx = args.signed === false ? buildUnsigned(body) : signTx(body, [BUYER_PRIV], args.scriptValid ?? true);
  return decodePayment({
    x402Version: 2,
    accepted: requirements(),
    payload: { transaction: Buffer.from(tx.cborHex, 'hex').toString('base64'), nonce: NONCE_REF },
  });
}

const opts = { currentSlot: CURRENT_SLOT, maxTtlSlot: MAX_TTL_SLOT };

function codeOf(d: DecodedPayment, r = requirements(), o: Parameters<typeof validatePayment>[2] = opts): string | undefined {
  const v = validatePayment(d, r, o);
  return v.ok ? undefined : v.code;
}

describe('validatePayment, happy path', () => {
  it('accepts a correct payment and reports the matched amount', () => {
    const v = validatePayment(decoded(), requirements(), opts);
    expect(v).toEqual({ ok: true, match: { amountUnits: '1000000', unit: '' } });
  });

  it('accepts overpayment', () => {
    expect(codeOf(decoded({ outputs: [{ address: SELLER_ADDR, lovelace: '3000000' }] }))).toBeUndefined();
  });

  it('accepts a native-asset payment', () => {
    const d = decoded({ outputs: [{
      address: SELLER_ADDR, lovelace: '1500000',
      assets: [{ policyId: TEST_POLICY_ID, nameHex: TEST_ASSET_NAME, qty: '10' }],
    }] });
    const v = validatePayment(d, requirements({ asset: TEST_ASSET_STRING, amount: '10' }), opts);
    expect(v).toEqual({ ok: true, match: { amountUnits: '10', unit: TEST_ASSET_UNIT } });
  });
});

describe('validatePayment, rules', () => {
  it('rejects an unsigned transaction', () => {
    expect(codeOf(decoded({ signed: false }))).toBe(Codes.UNSIGNED_TRANSACTION);
  });

  it('rejects an unsupported transfer method', () => {
    const r = requirements({ extra: { assetTransferMethod: 'masumi' } as unknown as PaymentExtra });
    expect(codeOf(decoded(), r)).toBe(Codes.UNSUPPORTED_METHOD);
  });

  it('rejects an output on another network (rule 1)', () => {
    const d = decoded({ outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }, { address: SELLER_MAINNET, lovelace: '2000000' }] });
    expect(codeOf(d)).toBe(Codes.NETWORK_MISMATCH);
  });

  it('accepts all outputs on the required network (rule 1)', () => {
    const d = decoded({ outputs: [{ address: SELLER_MAINNET, lovelace: '1000000' }] });
    expect(codeOf(d, requirements({ network: 'cardano:mainnet', payTo: SELLER_MAINNET }))).toBeUndefined();
  });

  it('rejects when no output goes to payTo (rule 2)', () => {
    expect(codeOf(decoded({ outputs: [{ address: BUYER_ADDR, lovelace: '9000000' }] }))).toBe(Codes.WRONG_RECIPIENT);
  });

  it('rejects two outputs that only sum to the amount (rule 3)', () => {
    const d = decoded({ outputs: [
      { address: SELLER_ADDR, lovelace: '600000' },
      { address: SELLER_ADDR, lovelace: '600000' },
    ] });
    expect(codeOf(d)).toBe(Codes.INSUFFICIENT_AMOUNT);
  });

  it('accepts when one of several payTo outputs covers the amount (rule 3)', () => {
    const d = decoded({ outputs: [
      { address: SELLER_ADDR, lovelace: '400000' },
      { address: SELLER_ADDR, lovelace: '1200000' },
    ] });
    const v = validatePayment(d, requirements(), opts);
    expect(v.ok && v.match.amountUnits).toBe('1200000');
  });

  it('rejects a payTo output without the asset (rule 4)', () => {
    const d = decoded({ outputs: [{ address: SELLER_ADDR, lovelace: '2000000' }] });
    expect(codeOf(d, requirements({ asset: TEST_ASSET_STRING, amount: '1' }))).toBe(Codes.WRONG_ASSET);
  });

  it('rejects a nonce that is not an input (rule 5)', () => {
    expect(codeOf(decoded({ inputTxHash: 'beef'.repeat(16) }))).toBe(Codes.NONCE_NOT_REFERENCED);
  });

  it('rejects a transaction that mints (rule 6)', () => {
    const d: DecodedPayment = {
      ...decoded(),
      mint: [{ unit: TEST_ASSET_UNIT, policyId: TEST_POLICY_ID, assetNameHex: TEST_ASSET_NAME, quantity: '1' }],
    };
    expect(codeOf(d)).toBe(Codes.PHASE1_INVALID);
  });

  it('rejects withdrawals, certificates and other body content (rule 6)', () => {
    expect(codeOf({ ...decoded(), extraBodyContent: ['withdrawals'] })).toBe(Codes.PHASE1_INVALID);
    expect(codeOf({ ...decoded(), extraBodyContent: ['certificates', 'treasury donation'] })).toBe(Codes.PHASE1_INVALID);
  });

  it('rejects a transaction marked invalid: its outputs would never exist', () => {
    expect(codeOf({ ...decoded(), isValid: false })).toBe(Codes.PHASE2_INVALID);
    expect(codeOf({ ...decoded(), isValid: true })).toBeUndefined();
  });

  it('rejects a vkey witness whose signature does not verify (rule 6)', () => {
    expect(codeOf({ ...decoded(), witnessErrors: ['witness 0 does not verify'] })).toBe(Codes.INVALID_SIGNATURE);
  });

  it('rejects a body network id of another network (rule 1)', () => {
    expect(codeOf({ ...decoded(), networkId: 1 })).toBe(Codes.NETWORK_MISMATCH);
    expect(codeOf({ ...decoded(), networkId: 0 })).toBeUndefined();
    expect(codeOf({ ...decoded(), networkId: null })).toBeUndefined();
  });

  it('accepts requirements that name the network by its CIP-34 alias', () => {
    expect(codeOf(decoded(), { ...requirements(), network: 'cip34:0-1' as never })).toBeUndefined();
    expect(codeOf(decoded(), { ...requirements(), network: 'cip34:1-764824073' as never })).toBe(Codes.NETWORK_MISMATCH);
  });

  it('rejects a transaction whose validity flag is false, as read by the real parser', () => {
    const d = decoded({ scriptValid: false });
    expect(d.isValid).toBe(false);
    expect(codeOf(d)).toBe(Codes.PHASE2_INVALID);
    expect(decoded().isValid).toBe(true);
  });

  it('rejects a transaction without TTL (rule 7)', () => {
    expect(codeOf(decoded({ ttlSlot: null }))).toBe(Codes.EXPIRED_TTL);
  });

  it('rejects an expired TTL (rule 7)', () => {
    expect(codeOf(decoded({ ttlSlot: PAST_SLOT }))).toBe(Codes.EXPIRED_TTL);
    expect(codeOf(decoded({ ttlSlot: CURRENT_SLOT }))).toBe(Codes.EXPIRED_TTL);
  });

  it('rejects a validity start in the future (rule 6)', () => {
    expect(codeOf(decoded({ validityStartSlot: CURRENT_SLOT + 1 }))).toBe(Codes.NOT_YET_VALID);
  });

  it('accepts a validity start that is reached', () => {
    expect(codeOf(decoded({ validityStartSlot: CURRENT_SLOT }))).toBeUndefined();
  });

  it('rejects a TTL beyond maxTtlSlot (rule 7)', () => {
    expect(codeOf(decoded({ ttlSlot: MAX_TTL_SLOT + 1 }))).toBe(Codes.TTL_TOO_FAR);
  });

  it('accepts a TTL at maxTtlSlot, and any TTL when no bound is given', () => {
    expect(codeOf(decoded({ ttlSlot: MAX_TTL_SLOT }))).toBeUndefined();
    expect(codeOf(decoded({ ttlSlot: MAX_TTL_SLOT + 5000 }), requirements(), { currentSlot: CURRENT_SLOT })).toBeUndefined();
  });

  it('skips the window checks when the ledger already accepted the tx', () => {
    const accepted = { ...opts, alreadyAccepted: true };
    expect(codeOf(decoded({ ttlSlot: PAST_SLOT }), requirements(), accepted)).toBeUndefined();
    expect(codeOf(decoded({ validityStartSlot: CURRENT_SLOT + 9 }), requirements(), accepted)).toBeUndefined();
    expect(codeOf(decoded({ ttlSlot: MAX_TTL_SLOT + 1 }), requirements(), accepted)).toBeUndefined();
  });

  it('still requires a TTL when the ledger already accepted the tx', () => {
    expect(codeOf(decoded({ ttlSlot: null }), requirements(), { ...opts, alreadyAccepted: true })).toBe(Codes.EXPIRED_TTL);
  });
});

describe('matchOutput', () => {
  it('matches without the chain-free checks of validatePayment', () => {
    expect(matchOutput(decoded({ signed: false }), requirements())).toEqual({ ok: true, match: { amountUnits: '1000000', unit: '' } });
  });

  it('rejects an insufficient payment', () => {
    const m = matchOutput(decoded({ outputs: [{ address: SELLER_ADDR, lovelace: '999999' }] }), requirements());
    expect(m.ok ? undefined : m.code).toBe(Codes.INSUFFICIENT_AMOUNT);
  });
});

describe('buildClaim', () => {
  it('builds the claim of a verified payment', () => {
    const d = decoded();
    const r = requirements();
    expect(buildClaim(d, r, { amountUnits: '1000000', unit: '' }, '/r', BUYER_ADDR)).toEqual({
      txHash:      d.txHash,
      amountUnits: '1000000',
      network:     NETWORK_PREPROD,
      unit:        '',
      asset:       'lovelace',
      payTo:       SELLER_ADDR,
      resourceUrl: '/r',
      nonceRef:    NONCE_REF,
      payerAddr:   BUYER_ADDR,
    });
  });

  it('omits payerAddr when unknown and carries script extra', () => {
    const extra = { assetTransferMethod: 'script' as const, lockRefs: ['x#0'] };
    const c = buildClaim(decoded(), requirements(), { amountUnits: '1', unit: '', extra }, '/r');
    expect(c).not.toHaveProperty('payerAddr');
    expect(c.extra).toEqual(extra);
  });
});
