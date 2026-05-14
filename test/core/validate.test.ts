import { validatePayment } from '../../srv/core/validate';
import { Codes } from '../../srv/core/errors';
import {
  BUYER_PRIV, BUYER_ADDR, SELLER_ADDR,
  NONCE_TX_HASH, NONCE_INDEX, NONCE_REF,
  CURRENT_SLOT, FUTURE_SLOT, PAST_SLOT,
  TEST_POLICY_ID, TEST_ASSET_NAME, TEST_ASSET_STRING,
  NETWORK_PREPROD, NETWORK_MAINNET,
} from '../fixtures/constants';
import { buildBody, signTx, buildUnsigned } from '../fixtures/build-tx';
import { buildEnvelope } from '../fixtures/envelope';
import { decode } from '../../srv/core/decode';
import { buildEntry } from '../../srv/core/requirements';
import type { PaymentRequirementEntry } from '../../srv/core/types';

/** Build a fully-decoded payment + the matching requirements entry. */
function makeFixture({
  outputs,
  asset = 'lovelace',
  amount = '1000000',
  ttlSlot,
  withWitness = true,
  inputTxHash = NONCE_TX_HASH,
  network = NETWORK_PREPROD,
}: {
  outputs: Array<{
    address: string;
    lovelace: string;
    assets?: Array<{ policyId: string; nameHex: string; qty: string }>;
  }>;
  asset?: string;
  amount?: string;
  ttlSlot?: number | null;
  withWitness?: boolean;
  inputTxHash?: string;
  network?: string;
}) {
  const body = buildBody({
    inputs: [{ txHash: inputTxHash, outputIndex: NONCE_INDEX }],
    outputs,
    ...(ttlSlot !== null ? { ttlSlot: ttlSlot ?? FUTURE_SLOT } : {}),
  });
  const signed = withWitness ? signTx(body, [BUYER_PRIV]) : buildUnsigned(body);
  const header = buildEnvelope({ txCborHex: signed.cborHex, nonceRef: NONCE_REF, network });
  const decoded = decode(header);
  const requirements: PaymentRequirementEntry = buildEntry({
    amount,
    asset,
    payTo: SELLER_ADDR,
    network: NETWORK_PREPROD,
    resource: '/r',
  });
  return { decoded, requirements };
}

describe('validatePayment — check 1: network', () => {
  it('rejects mismatched network', () => {
    const { decoded, requirements } = makeFixture({
      outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
      network: NETWORK_MAINNET,
    });
    const r = validatePayment(decoded, requirements, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.NETWORK_MISMATCH);
  });
});

describe('validatePayment — check 2: recipient', () => {
  it('rejects when no output is to payTo', () => {
    const { decoded, requirements } = makeFixture({
      outputs: [{ address: BUYER_ADDR, lovelace: '1000000' }],
    });
    const r = validatePayment(decoded, requirements, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.WRONG_RECIPIENT);
  });
});

describe('validatePayment — check 3: amount', () => {
  it('rejects insufficient amount', () => {
    const { decoded, requirements } = makeFixture({
      outputs: [{ address: SELLER_ADDR, lovelace: '500000' }],
      asset: 'lovelace',
      amount: '1000000',
    });
    const r = validatePayment(decoded, requirements, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.INSUFFICIENT_AMOUNT);
  });

  it('sums outputs to payTo across multiple outputs', () => {
    const { decoded, requirements } = makeFixture({
      outputs: [
        { address: SELLER_ADDR, lovelace: '600000' },
        { address: SELLER_ADDR, lovelace: '500000' }, // total 1_100_000 ≥ 1_000_000
      ],
      asset: 'lovelace',
      amount: '1000000',
    });
    const r = validatePayment(decoded, requirements, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claim.amountUnits).toBe('1100000');
  });
});

describe('validatePayment — check 4: asset', () => {
  it('rejects when payTo receives only the wrong asset', () => {
    // payTo gets lovelace; requirements want a native asset
    const { decoded, requirements } = makeFixture({
      outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
      asset: TEST_ASSET_STRING,
      amount: '5',
    });
    const r = validatePayment(decoded, requirements, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.WRONG_ASSET);
  });

  it('matches exact policy + name', () => {
    const { decoded, requirements } = makeFixture({
      outputs: [{
        address: SELLER_ADDR,
        lovelace: '1500000',
        assets: [{ policyId: TEST_POLICY_ID, nameHex: TEST_ASSET_NAME, qty: '5' }],
      }],
      asset: TEST_ASSET_STRING,
      amount: '5',
    });
    const r = validatePayment(decoded, requirements, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claim.amountUnits).toBe('5');
      expect(r.claim.unit).toBe((TEST_POLICY_ID + TEST_ASSET_NAME).toLowerCase());
    }
  });
});

describe('validatePayment — check 5a: nonce input reference', () => {
  it('rejects when nonce UTxO is not referenced as a tx input', () => {
    // Build a fixture where the input txHash is NOT the nonce txHash
    const other = 'cafe'.repeat(16);
    const { decoded, requirements } = makeFixture({
      outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
      inputTxHash: other,
    });
    const r = validatePayment(decoded, requirements, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.NONCE_NOT_REFERENCED);
  });
});

describe('validatePayment — check 6: TTL', () => {
  it('rejects expired TTL', () => {
    const { decoded, requirements } = makeFixture({
      outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
      ttlSlot: PAST_SLOT,
    });
    const r = validatePayment(decoded, requirements, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.EXPIRED_TTL);
  });

  it('rejects no-TTL tx in strict mode (default)', () => {
    const { decoded, requirements } = makeFixture({
      outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
      ttlSlot: null,
    });
    const r = validatePayment(decoded, requirements, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.EXPIRED_TTL);
  });

  it('accepts no-TTL tx when allowNoTtl=true', () => {
    const { decoded, requirements } = makeFixture({
      outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
      ttlSlot: null,
    });
    const r = validatePayment(decoded, requirements, { currentSlot: CURRENT_SLOT, allowNoTtl: true });
    expect(r.ok).toBe(true);
  });

  it('treats currentSlot == ttlSlot as expired (boundary)', () => {
    const { decoded, requirements } = makeFixture({
      outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
      ttlSlot: CURRENT_SLOT,
    });
    const r = validatePayment(decoded, requirements, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.EXPIRED_TTL);
  });
});

describe('validatePayment — supporting: unsigned tx', () => {
  it('rejects when no vkey witnesses present', () => {
    const { decoded, requirements } = makeFixture({
      outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
      withWitness: false,
    });
    const r = validatePayment(decoded, requirements, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.UNSIGNED_TRANSACTION);
  });
});

describe('validatePayment — happy path', () => {
  it('returns a populated PaymentClaim', () => {
    const { decoded, requirements } = makeFixture({
      outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
    });
    const r = validatePayment(decoded, requirements, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claim).toMatchObject({
        amountUnits: '1000000',
        network: NETWORK_PREPROD,
        nonceRef: NONCE_REF,
        asset: 'lovelace',
        resourceUrl: '/r',
        txHash: decoded.txHash,
      });
    }
  });
});
