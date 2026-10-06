/**
 * Script-address derivation against reference hashes. The expected values
 * come from the Evolution SDK path of `@x402/cardano` (applyParamsToScript +
 * ScriptHash.fromScript) for the same script and parameters, so a
 * divergence here breaks interop with that facilitator.
 */

// Real pure helpers from core; the barrel itself drags in uncompiled models.
jest.mock('@odatano/core', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ...require('../fixtures/core-parse-mock').coreParseMock(),
  ...jest.requireActual('@odatano/core/srv/utils/tx-build-helper'),
}));

import { Address, Credential } from '@harmoniclabs/buildooor';
import { transferExtraProblem } from '../../srv/core/transfer';
import type { ScriptTransferExtra, TransferScriptParameter } from '../../srv/core/types';

/** Minimal Plutus script, CBOR-wrapped once. */
const CODE = '4d01000033222220051200120011';

const scriptAddr = (hash: string) => Address.testnet(Credential.script(hash)).toString();

function extra(parameters?: Record<string, TransferScriptParameter>): ScriptTransferExtra {
  return { assetTransferMethod: 'script', script: { type: 'plutusV3', code: CODE }, ...(parameters ? { parameters } : {}) };
}

describe('script hash matches the reference implementation', () => {
  const cases: Array<[string, Record<string, TransferScriptParameter> | undefined, string]> = [
    ['no parameters', undefined,                                      '4fff649fb4372ec3c408b6f0468d74e4d319904cde27fd3f00910a52'],
    ['bigint',        { p: { type: 'bigint', value: '42' } },          '7bfdc59e675e288dc869395143d2ed2d227bd23f0663449c847f6fcc'],
    ['bytes',         { p: { type: 'bytes', value: 'deadbeef' } },     '8ecfdd95d4fb7aff3df92e9e9468f4095fda297e6b3fd7eb71b88c4c'],
    ['string',        { p: { type: 'string', value: 'Hello World' } }, '0e2fdbde3d6e6a9a661d9bc8e477b59452150700b34eb7b9f6032828'],
    ['boolean',       { p: { type: 'boolean', value: true } },         'cb992f08e2ea44f74fc0e14cd1eb9a918a00646875312eb57f44e2c9'],
    ['mixed, in key order', {
      a: { type: 'bytes', value: '00'.repeat(28) },
      b: { type: 'integer', value: -7 },
      c: { type: 'boolean', value: false },
    },                                                                 'f611057c66c6b27f1bad72bda53711549a99511d7828f67d696c051c'],
  ];

  it.each(cases)('%s', (_name, parameters, expectedHash) => {
    expect(transferExtraProblem(extra(parameters), scriptAddr(expectedHash))).toBeNull();
  });

  it('detects a parameter change', () => {
    expect(transferExtraProblem(extra({ p: { type: 'bigint', value: '43' } }), scriptAddr(cases[1]![2])))
      .toMatch(/is not the declared script/);
  });
});
