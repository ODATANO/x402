/**
 * Unit tests for the CSL-free Shelley address parser. The build-unsigned
 * flow relies on this for `requiredSignerHex` derivation and address-shape
 * rejection; here we cover the parser directly, including the malformed
 * and unsupported header cases.
 */

import { parsePaymentAddress } from '../../srv/helpers/address';
import { BUYER_ADDR, BUYER_VKH } from '../fixtures/constants';
import { bech32 } from 'bech32';

/** Encode raw bytes as a bech32 address with the given HRP. */
function encode(prefix: string, bytes: number[]): string {
  return bech32.encode(prefix, bech32.toWords(Uint8Array.from(bytes)), 1023);
}

describe('parsePaymentAddress', () => {
  it('extracts the payment VKey hash from an enterprise key address', () => {
    expect(parsePaymentAddress(BUYER_ADDR)).toEqual({ paymentKeyHashHex: BUYER_VKH });
  });

  it('rejects non-bech32 input', () => {
    expect(() => parsePaymentAddress('not-bech32')).toThrow(/invalid bech32/);
  });

  it('rejects a bech32 payload shorter than header + 28-byte credential', () => {
    // Valid bech32, but only 5 bytes of payload (< 29).
    const short = encode('addr_test', [0x60, 1, 2, 3, 4]);
    expect(() => parsePaymentAddress(short)).toThrow(/invalid bech32/);
  });

  it('rejects a script payment credential (enterprise type 7)', () => {
    const scriptAddr = encode('addr_test', [0x70, ...new Array(28).fill(0x11)]);
    expect(() => parsePaymentAddress(scriptAddr)).toThrow(/VKey hash, not a script/);
  });

  it('rejects reward / stake addresses (type 14)', () => {
    const stakeAddr = encode('stake_test', [0xe0, ...new Array(28).fill(0x22)]);
    expect(() => parsePaymentAddress(stakeAddr)).toThrow(/Base \/ Enterprise/);
  });
});
