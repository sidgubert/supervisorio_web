import { BadRequestException } from '@nestjs/common';
import { AlarmsController } from './alarms.controller';
import { AlarmsService } from './alarms.service';

describe('AlarmsController', () => {
  const service = {
    list: jest.fn().mockReturnValue([]),
    history: jest.fn().mockResolvedValue([]),
    ack: jest.fn().mockReturnValue({ state: 'ACTIVE_ACKED' }),
    ackAll: jest.fn().mockReturnValue(3),
  };
  const controller = new AlarmsController(service as unknown as AlarmsService);

  beforeEach(() => jest.clearAllMocks());

  it('history: padrão das últimas 24 h e limite 200', async () => {
    await controller.history();
    const q = service.history.mock.calls[0][0] as { from: Date; to: Date; limit: number };
    expect(q.to.getTime() - q.from.getTime()).toBe(24 * 60 * 60_000);
    expect(q.limit).toBe(200);
  });

  it('history: repassa período, tag e limite', async () => {
    await controller.history('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', 'TIC-101.PV', '50');
    expect(service.history).toHaveBeenCalledWith({
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-02T00:00:00Z'),
      tag: 'TIC-101.PV',
      limit: 50,
    });
  });

  it.each([
    [['ontem'], /from deve ser/],
    [['2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z'], /anterior a to/],
    [[undefined, undefined, undefined, '0'], /limit deve estar/],
    [[undefined, undefined, undefined, '1001'], /limit deve estar/],
    [[undefined, undefined, undefined, 'dez'], /limit deve estar/],
  ])('history recusa %j com 400', (args, msg) => {
    expect(() => controller.history(...(args as [string?, string?, string?, string?]))).toThrow(
      BadRequestException,
    );
    expect(() => controller.history(...(args as [string?, string?, string?, string?]))).toThrow(
      msg,
    );
  });

  const id = '11111111-1111-4111-8111-111111111111';

  it('ack e ack-all registram o usuário autenticado (ignorando o "by" do corpo)', () => {
    expect(controller.ack(id, { by: 'outro' }, { username: 'maria' })).toEqual({
      state: 'ACTIVE_ACKED',
    });
    expect(service.ack).toHaveBeenCalledWith(id, 'maria');
    expect(controller.ackAll({}, { username: 'maria' })).toEqual({ acknowledged: 3 });
    expect(service.ackAll).toHaveBeenCalledWith('maria');
  });

  it('sem autenticação, usa o "by" do corpo, ou "anônimo"', () => {
    controller.ack(id, { by: '  João  ' }, { username: 'anônimo' });
    expect(service.ack).toHaveBeenLastCalledWith(id, 'João');
    controller.ack(id, {}, { username: 'anônimo' });
    expect(service.ack).toHaveBeenLastCalledWith(id, 'anônimo');
    controller.ackAll({ by: '' }, undefined);
    expect(service.ackAll).toHaveBeenLastCalledWith('anônimo');
  });
});
