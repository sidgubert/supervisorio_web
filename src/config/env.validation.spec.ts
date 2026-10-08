import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('aplica os padrões quando nada é informado', () => {
    expect(validateEnv({})).toEqual({
      DB_HOST: 'localhost',
      DB_PORT: 5432,
      DB_USER: 'scada',
      DB_PASSWORD: 'scada',
      DB_NAME: 'scada',
      PORT: 3000,
      SIM_ENABLED: true,
      SIM_INTERVAL_MS: 1000,
      INGEST_FLUSH_MS: 2000,
      INGEST_BUFFER_MAX: 100_000,
    });
  });

  it('converte números e booleanos', () => {
    const env = validateEnv({ DB_PORT: '5433', SIM_ENABLED: 'false', INGEST_BUFFER_MAX: '500' });
    expect(env.DB_PORT).toBe(5433);
    expect(env.SIM_ENABLED).toBe(false);
    expect(env.INGEST_BUFFER_MAX).toBe(500);
  });

  it('lista todos os erros de uma vez', () => {
    expect(() =>
      validateEnv({ DB_PORT: 'abc', SIM_ENABLED: 'sim', SIM_INTERVAL_MS: '0', PORT: '1.5' }),
    ).toThrow(/DB_PORT[\s\S]*PORT="1.5"[\s\S]*SIM_ENABLED[\s\S]*SIM_INTERVAL_MS/);
  });
});
