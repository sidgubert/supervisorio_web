import { EXAMPLE_AUTH_SECRET, validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('aplica os padrões quando nada é informado', () => {
    expect(validateEnv({})).toEqual({
      DB_HOST: 'localhost',
      DB_PORT: 5432,
      DB_USER: 'scada',
      DB_PASSWORD: 'scada',
      DB_NAME: 'scada',
      DB_MIGRATIONS_RUN: true,
      PORT: 3000,
      SIM_ENABLED: true,
      SIM_INTERVAL_MS: 1000,
      INGEST_FLUSH_MS: 2000,
      INGEST_BUFFER_MAX: 100_000,
      LIVE_FLUSH_MS: 200,
      LIVE_MAX_SAMPLES_PER_TAG: 100,
      MQTT_ENABLED: false,
      MQTT_URL: 'mqtt://localhost:1883',
      MQTT_USERNAME: '',
      MQTT_PASSWORD: '',
      MODBUS_ENABLED: false,
      MODBUS_HOST: 'localhost',
      MODBUS_PORT: 502,
      MODBUS_POLL_MS: 1000,
      MODBUS_TIMEOUT_MS: 2000,
      OPCUA_ENABLED: false,
      OPCUA_ENDPOINT: 'opc.tcp://localhost:4840',
      OPCUA_SAMPLING_MS: 1000,
      OPCUA_PKI_DIR: '.opcua-pki',
      AUTH_ENABLED: false,
      AUTH_USER: 'operador',
      AUTH_PASSWORD: '',
      AUTH_SECRET: '',
      ALARM_HYSTERESIS_PCT: 2,
      RETENTION_ENABLED: false,
      RETENTION_DAYS: 90,
    });
  });

  it('com a autenticação ligada, exige senha e segredo forte', () => {
    expect(() => validateEnv({ AUTH_ENABLED: 'true' })).toThrow(/exige AUTH_PASSWORD/);
    expect(() =>
      validateEnv({ AUTH_ENABLED: 'true', AUTH_PASSWORD: 'x', AUTH_SECRET: 'curto' }),
    ).toThrow(/AUTH_SECRET aleatório com 32 caracteres/);
    expect(() =>
      validateEnv({ AUTH_ENABLED: 'true', AUTH_PASSWORD: 'x', AUTH_SECRET: EXAMPLE_AUTH_SECRET }),
    ).toThrow(/AUTH_SECRET aleatório/);
    const ok = validateEnv({
      AUTH_ENABLED: 'true',
      AUTH_PASSWORD: 'x',
      AUTH_SECRET: 'a'.repeat(32),
    });
    expect(ok.AUTH_ENABLED).toBe(true);
  });

  it('retenção abaixo da janela dos agregados é recusada', () => {
    expect(() => validateEnv({ RETENTION_DAYS: '7' })).toThrow(/RETENTION_DAYS="7"/);
    expect(validateEnv({ RETENTION_DAYS: '8' }).RETENTION_DAYS).toBe(8);
  });

  it('ALARM_HYSTERESIS_PCT aceita decimais entre 0 e 50', () => {
    expect(validateEnv({ ALARM_HYSTERESIS_PCT: '1.5' }).ALARM_HYSTERESIS_PCT).toBe(1.5);
    expect(() => validateEnv({ ALARM_HYSTERESIS_PCT: '60' })).toThrow(/ALARM_HYSTERESIS_PCT/);
  });

  it('converte números e booleanos', () => {
    const env = validateEnv({ DB_PORT: '5433', SIM_ENABLED: 'false', INGEST_BUFFER_MAX: '500' });
    expect(env.DB_PORT).toBe(5433);
    expect(env.SIM_ENABLED).toBe(false);
    expect(env.INGEST_BUFFER_MAX).toBe(500);
  });

  it('valida a URL do broker MQTT', () => {
    expect(validateEnv({ MQTT_URL: 'mqtts://broker.local:8883' }).MQTT_URL).toBe(
      'mqtts://broker.local:8883',
    );
    expect(() => validateEnv({ MQTT_URL: 'broker.local' })).toThrow(/não é uma URL válida/);
    expect(() => validateEnv({ MQTT_URL: 'http://broker.local' })).toThrow(/deve usar mqtt:\/\//);
  });

  it('lista todos os erros de uma vez', () => {
    expect(() =>
      validateEnv({ DB_PORT: 'abc', SIM_ENABLED: 'sim', SIM_INTERVAL_MS: '0', PORT: '1.5' }),
    ).toThrow(/DB_PORT[\s\S]*PORT="1.5"[\s\S]*SIM_ENABLED[\s\S]*SIM_INTERVAL_MS/);
  });
});
