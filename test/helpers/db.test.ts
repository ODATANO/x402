import cds from '@sap/cds';
import { runDetached, entityOption } from '../../srv/helpers/db';
import { deployTestDb, closeTestDb, rowsOf } from '../fixtures/db';

const ENTITY = 'odatano.x402.X402Settlements';
const row = (txId: string) => ({ txId, state: 'submitting', expiresAt: new Date(Date.now() + 60_000).toISOString() });

beforeAll(deployTestDb);
afterAll(closeTestDb);

describe('runDetached', () => {
  it('commits on its own, so the row survives a failing outer transaction', async () => {
    await expect(cds.tx(async () => {
      await runDetached(cds.ql.INSERT.into(ENTITY).entries(row('aa')));
      throw new Error('request failed');
    })).rejects.toThrow('request failed');
    expect(await rowsOf(ENTITY)).toEqual([expect.objectContaining({ txId: 'aa' })]);
  });

  it('rejects when the statement fails', async () => {
    // The driver's error objects belong to another jest realm, so match the message, not the class.
    await expect(runDetached(cds.ql.INSERT.into(ENTITY).entries(row('aa'))))
      .rejects.toMatchObject({ message: expect.stringContaining('UNIQUE') });
  });
});

describe('entityOption', () => {
  it('is null when off, the default for true, the named entity otherwise', () => {
    expect(entityOption(undefined, 'a.B')).toBeNull();
    expect(entityOption(false, 'a.B')).toBeNull();
    expect(entityOption(true, 'a.B')).toBe('a.B');
    expect(entityOption({}, 'a.B')).toBe('a.B');
    expect(entityOption({ entity: 'c.D' }, 'a.B')).toBe('c.D');
  });
});
