import { Repository } from 'typeorm';
import { Measurement } from './measurement.entity';
import { MeasurementsService } from './measurements.service';

function rows(n: number): Partial<Measurement>[] {
  return Array.from({ length: n }, (_, i) => ({ time: new Date(i), tag: 'T', value: i }));
}

describe('MeasurementsService.insertBatch', () => {
  const insert = jest.fn();
  const transaction = jest.fn((work: (em: { insert: jest.Mock }) => Promise<void>) =>
    work({ insert }),
  );
  const repo = { manager: { transaction } } as unknown as Repository<Measurement>;
  const service = new MeasurementsService(repo);

  beforeEach(() => jest.clearAllMocks());

  it('lote vazio não toca no banco', async () => {
    expect(await service.insertBatch([])).toBe(0);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('divide lotes grandes em blocos de 1000 numa única transação', async () => {
    expect(await service.insertBatch(rows(2500))).toBe(2500);
    expect(transaction).toHaveBeenCalledTimes(1);
    const sizes = insert.mock.calls.map((c: unknown[]) => (c[1] as unknown[]).length);
    expect(sizes).toEqual([1000, 1000, 500]);
  });

  it('propaga a falha (a transação desfaz tudo)', async () => {
    insert.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('boom'));
    await expect(service.insertBatch(rows(1500))).rejects.toThrow('boom');
  });
});
