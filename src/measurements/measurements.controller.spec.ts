import { BadRequestException } from '@nestjs/common';
import { MeasurementsController } from './measurements.controller';
import { MeasurementsService } from './measurements.service';

describe('MeasurementsController.latest', () => {
  const latest = jest.fn().mockResolvedValue([]);
  const controller = new MeasurementsController({ latest } as unknown as MeasurementsService);

  it.each([1, 100, 5000])('aceita limit=%i', async (limit) => {
    await controller.latest('TIC-101.PV', limit);
    expect(latest).toHaveBeenLastCalledWith('TIC-101.PV', limit);
  });

  it.each([0, -1, 5001])('rejeita limit=%i com 400', (limit) => {
    expect(() => controller.latest('TIC-101.PV', limit)).toThrow(BadRequestException);
  });
});
