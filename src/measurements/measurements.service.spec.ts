import { Repository } from 'typeorm';
import { Sample } from '../ingestion/sample';
import { Measurement } from './measurement.entity';
import { MeasurementsService } from './measurements.service';

function rows(n: number): Sample[] {
  return Array.from({ length: n }, (_, i) => ({
    time: new Date(i),
    tag: `T${i}`,
    value: i / 2,
    quality: 192,
    source: 'sim',
    receivedAt: new Date(1000 + i),
  }));
}

describe('MeasurementsService.insertBatch', () => {
  const query = jest.fn();
  const service = new MeasurementsService({ query } as unknown as Repository<Measurement>);

  beforeEach(() => query.mockReset());

  it('lote vazio não toca no banco', async () => {
    expect(await service.insertBatch([])).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('grava o lote numa instrução só, com uma coluna por parâmetro', async () => {
    query.mockResolvedValue([{ inserted: 3 }]);
    const batch = rows(3);
    await service.insertBatch(batch);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[][]];
    expect(sql).toMatch(
      /INSERT INTO measurements \(time, tag, value, quality, source, received_at\)/,
    );
    expect(sql).toMatch(/unnest\(/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
    expect(params).toEqual([
      batch.map((r) => r.time),
      ['T0', 'T1', 'T2'],
      [0, 0.5, 1],
      [192, 192, 192],
      ['sim', 'sim', 'sim'],
      batch.map((r) => r.receivedAt),
    ]);
  });

  it('usa sempre 6 parâmetros, mesmo em lotes grandes', async () => {
    query.mockResolvedValue([{ inserted: 100_000 }]);
    await service.insertBatch(rows(100_000));
    const params = query.mock.calls[0][1] as unknown[][];
    expect(params).toHaveLength(6);
    expect(params[0]).toHaveLength(100_000);
  });

  it('devolve quantas foram inseridas (duplicatas são ignoradas pelo banco)', async () => {
    query.mockResolvedValue([{ inserted: 2 }]);
    expect(await service.insertBatch(rows(5))).toBe(2);
  });

  it('propaga a falha do banco', async () => {
    query.mockRejectedValue(new Error('boom'));
    await expect(service.insertBatch(rows(1))).rejects.toThrow('boom');
  });
});
