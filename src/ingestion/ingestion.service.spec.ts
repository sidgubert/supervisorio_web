import { Logger } from '@nestjs/common';
import { EmitFn } from './acquisition-source';
import { IngestionBuffer } from './ingestion-buffer';
import { IngestionService } from './ingestion.service';
import { Sample } from './sample';

function fakeBuffer() {
  const calls: string[] = [];
  const pushed: Sample[] = [];
  const buffer = {
    start: jest.fn(() => calls.push('buffer.start')),
    stop: jest.fn(async () => {
      await Promise.resolve();
      calls.push('buffer.stop');
    }),
    push: jest.fn((s: Sample[]) => pushed.push(...s)),
  };
  return { buffer, calls, pushed };
}

/** Fonte de teste que guarda o `emit` recebido para emitir sob demanda. */
function fakeSource(name: string, calls: string[], failStart = false) {
  const source = {
    name,
    emit: undefined as EmitFn | undefined,
    start: jest.fn((emit: EmitFn) => {
      if (failStart) throw new Error('broker fora');
      source.emit = emit;
      calls.push(`${name}.start`);
    }),
    stop: jest.fn(() => {
      calls.push(`${name}.stop`);
    }),
  };
  return source;
}

function setup() {
  const fb = fakeBuffer();
  const service = new IngestionService(fb.buffer as unknown as IngestionBuffer);
  return { service, ...fb };
}

beforeAll(() => Logger.overrideLogger(false));

describe('IngestionService', () => {
  it('inicia o buffer e depois as fontes registradas', async () => {
    const { service, calls } = setup();
    service.register(fakeSource('a', calls));
    service.register(fakeSource('b', calls));
    await service.onApplicationBootstrap();
    expect(calls).toEqual(['buffer.start', 'a.start', 'b.start']);
  });

  it('no encerramento para as fontes antes de esvaziar o buffer', async () => {
    const { service, calls } = setup();
    service.register(fakeSource('a', calls));
    await service.onApplicationBootstrap();
    calls.length = 0;
    await service.onModuleDestroy();
    expect(calls).toEqual(['a.stop', 'buffer.stop']);
  });

  it('uma fonte que falha ao iniciar não impede as outras', async () => {
    const { service, calls } = setup();
    service.register(fakeSource('ruim', calls, true));
    service.register(fakeSource('boa', calls));
    await service.onApplicationBootstrap();
    expect(calls).toContain('boa.start');
  });

  it('rejeita nomes duplicados e registro após a subida', async () => {
    const { service, calls } = setup();
    service.register(fakeSource('a', calls));
    expect(() => service.register(fakeSource('a', calls))).toThrow(/Já existe/);
    await service.onApplicationBootstrap();
    expect(() => service.register(fakeSource('b', calls))).toThrow(/após a subida/);
  });

  describe('ingest', () => {
    const NOW = new Date('2026-10-08T12:00:00Z');
    const MIN = 60_000;
    const at = (deltaMs: number) => new Date(NOW.getTime() + deltaMs);

    beforeEach(() => jest.useFakeTimers({ now: NOW }));
    afterEach(() => jest.useRealTimers());

    it('normaliza: qualidade Good por padrão, nome da fonte e instante de recebimento', async () => {
      const { service, calls, pushed } = setup();
      const src = fakeSource('mqtt', calls);
      service.register(src);
      await service.onApplicationBootstrap();
      const t = at(-1000);
      src.emit!([
        { time: t, tag: 'A', value: 1 },
        { time: t, tag: 'B', value: 2, quality: 0 },
      ]);
      expect(pushed).toEqual([
        { time: t, tag: 'A', value: 1, quality: 192, source: 'mqtt', receivedAt: NOW },
        { time: t, tag: 'B', value: 2, quality: 0, source: 'mqtt', receivedAt: NOW },
      ]);
    });

    it('sem time, usa o instante de recebimento', () => {
      const { service, pushed } = setup();
      service.ingest('modbus', [{ tag: 'A', value: 1 }]);
      expect(pushed[0].time).toEqual(NOW);
    });

    it.each([
      ['adiantado 6 min', 6 * MIN],
      ['de 1970 (relógio zerado)', -NOW.getTime()],
      ['de 2 dias atrás', -2 * 24 * 60 * MIN],
    ])('time implausível (%s) é trocado pelo de recebimento', (_, delta) => {
      const { service, pushed } = setup();
      service.ingest('x', [{ time: at(delta), tag: 'A', value: 1 }]);
      expect(pushed[0].time).toEqual(NOW);
    });

    it.each([
      ['adiantado 4 min', 4 * MIN],
      ['de 23 h atrás (chegou atrasado)', -23 * 60 * MIN],
    ])('time plausível (%s) é mantido', (_, delta) => {
      const { service, pushed } = setup();
      service.ingest('x', [{ time: at(delta), tag: 'A', value: 1 }]);
      expect(pushed[0].time).toEqual(at(delta));
    });

    it('descarta amostras inválidas', () => {
      const { service, pushed } = setup();
      const t = at(0);
      service.ingest('x', [
        { time: t, tag: 'ok', value: 1 },
        { time: t, tag: '', value: 1 },
        { time: t, tag: 'x'.repeat(201), value: 1 },
        { time: t, tag: 'nul\u0000', value: 1 },
        { time: t, tag: 'quebra\nde-linha', value: 1 },
        { time: t, tag: 'nan', value: NaN },
        { time: t, tag: 'inf', value: Infinity },
        { time: t, tag: 'texto', value: '1' as unknown as number },
        { time: new Date('lixo'), tag: 'data', value: 1 },
        { time: t, tag: 'q-frac', value: 1, quality: 1.5 },
        { time: t, tag: 'q-neg', value: 1, quality: -1 },
        { time: t, tag: 'q-256', value: 1, quality: 256 },
        { time: t, tag: 'q-max', value: 1, quality: 255 },
      ]);
      expect(pushed.map((s) => s.tag)).toEqual(['ok', 'q-max']);
    });

    it('avisa no log no máximo uma vez por minuto por fonte, somando os problemas', () => {
      const { service } = setup();
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
      const bad = { tag: '', value: 1 };

      service.ingest('x', [bad]); // primeiro problema: avisa na hora
      service.ingest('x', [bad, bad]); // dentro do minuto: só acumula
      service.ingest('y', [bad]); // outra fonte: avisa
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0][0]).toMatch(/Fonte "x": 1 amostra/);

      jest.advanceTimersByTime(MIN);
      service.ingest('x', [{ time: at(-NOW.getTime()), tag: 'A', value: 1 }]);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[2][0]).toMatch(
        /Fonte "x": 2 amostra\(s\) inválida\(s\).*; 1 com horário implausível.*desde o último aviso/,
      );
    });

    it('publica em samples$ só as amostras válidas, e nada se o lote for todo inválido', () => {
      const { service } = setup();
      const received: Sample[][] = [];
      service.samples$.subscribe((b) => received.push(b));
      service.ingest('x', [
        { tag: 'ok', value: 1 },
        { tag: 'nan', value: NaN },
      ]);
      service.ingest('x', [{ tag: 'nan', value: NaN }]);
      expect(received).toHaveLength(1);
      expect(received[0].map((s) => s.tag)).toEqual(['ok']);
    });
  });

  it('completa samples$ no encerramento', async () => {
    const { service } = setup();
    const complete = jest.fn();
    service.samples$.subscribe({ complete });
    await service.onModuleDestroy();
    expect(complete).toHaveBeenCalled();
  });
});
