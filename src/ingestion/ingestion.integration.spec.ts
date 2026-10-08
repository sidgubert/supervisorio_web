import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { validateEnv } from '../config/env.validation';
import { Measurement } from '../measurements/measurement.entity';
import { MeasurementsService } from '../measurements/measurements.service';
import { DEFAULT_SIGNALS } from '../sources/simulator/signal';
import { SimulatorModule } from '../sources/simulator/simulator.module';
import { Sample } from './sample';

/**
 * Monta os módulos reais (config, ingestão, simulador) com o Nest, trocando só
 * o banco. Valida a injeção de dependências e o ciclo de vida de ponta a ponta:
 * simulador -> IngestionService -> IngestionBuffer -> MeasurementsService.
 */
describe('Ingestão (integração com o Nest)', () => {
  const ENV = { SIM_ENABLED: 'true', SIM_INTERVAL_MS: '100', INGEST_FLUSH_MS: '250' };
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    Logger.overrideLogger(false);
    // O validate do ConfigModule só processa variáveis de ambiente (não `load`).
    for (const [k, v] of Object.entries(ENV)) {
      original[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('gera, normaliza e grava; no encerramento grava o restante', async () => {
    jest.useFakeTimers();
    const saved: Sample[] = [];

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: validateEnv,
        }),
        SimulatorModule,
      ],
    })
      .overrideProvider(getRepositoryToken(Measurement))
      .useValue({})
      .overrideProvider(MeasurementsService)
      .useValue({
        insertBatch: (rows: Sample[]) => {
          saved.push(...rows);
          return Promise.resolve(rows.length);
        },
      })
      .compile();

    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    await jest.advanceTimersByTimeAsync(250); // 2 ciclos do simulador, 1 flush
    expect(saved).toHaveLength(2 * DEFAULT_SIGNALS.length);
    expect(saved[0]).toMatchObject({ quality: 192, source: 'sim' });

    await jest.advanceTimersByTimeAsync(100); // mais 1 ciclo, ainda não gravado
    await app.close();
    expect(saved).toHaveLength(3 * DEFAULT_SIGNALS.length);

    jest.useRealTimers();
  });
});
