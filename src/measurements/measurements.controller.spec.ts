import { BadRequestException } from '@nestjs/common';
import { MeasurementsController } from './measurements.controller';
import { MeasurementsService } from './measurements.service';

describe('MeasurementsController', () => {
  const latest = jest.fn().mockResolvedValue([]);
  const history = jest.fn().mockResolvedValue([]);
  const controller = new MeasurementsController({
    latest,
    history,
  } as unknown as MeasurementsService);

  it.each([1, 100, 5000])('aceita limit=%i', async (limit) => {
    await controller.latest('TIC-101.PV', limit);
    expect(latest).toHaveBeenLastCalledWith('TIC-101.PV', limit);
  });

  it.each([0, -1, 5001])('rejeita limit=%i com 400', (limit) => {
    expect(() => controller.latest('TIC-101.PV', limit)).toThrow(BadRequestException);
  });

  it('history devolve a resolução escolhida e os pontos', async () => {
    const res = await controller.history(
      'TIC-101.PV',
      '2026-10-07T10:00:00Z',
      '2026-10-07T12:00:00Z',
    );
    expect(res).toMatchObject({ tag: 'TIC-101.PV', bucket: '1m', points: [] });
    expect(history).toHaveBeenLastCalledWith(
      'TIC-101.PV',
      expect.objectContaining({ bucket: '1m' }),
    );
  });

  it('history converte parâmetros inválidos em 400', async () => {
    await expect(controller.history('TIC-101.PV', 'ontem')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
