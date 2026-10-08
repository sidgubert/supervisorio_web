import { validateEnv } from './env.validation';

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
    });
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
