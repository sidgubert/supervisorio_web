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

  it('normaliza: aplica qualidade Good por padrão e grava o nome da fonte', async () => {
    const { service, calls, pushed } = setup();
    const src = fakeSource('mqtt', calls);
    service.register(src);
    await service.onApplicationBootstrap();
    const t = new Date(0);
    src.emit!([
      { time: t, tag: 'A', value: 1 },
      { time: t, tag: 'B', value: 2, quality: 0 },
    ]);
    expect(pushed).toEqual([
      { time: t, tag: 'A', value: 1, quality: 192, source: 'mqtt' },
      { time: t, tag: 'B', value: 2, quality: 0, source: 'mqtt' },
    ]);
  });

  it('descarta amostras inválidas', () => {
    const { service, pushed } = setup();
    const t = new Date(0);
    service.ingest('x', [
      { time: t, tag: 'ok', value: 1 },
      { time: t, tag: '', value: 1 },
      { time: t, tag: 'nan', value: NaN },
      { time: t, tag: 'inf', value: Infinity },
      { time: new Date('lixo'), tag: 'data', value: 1 },
      { time: t, tag: 'q', value: 1, quality: 1.5 },
    ]);
    expect(pushed.map((s) => s.tag)).toEqual(['ok']);
  });
});
