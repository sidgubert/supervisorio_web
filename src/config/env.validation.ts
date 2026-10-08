/**
 * Validação das variáveis de ambiente na subida da aplicação.
 *
 * Usado em ConfigModule.forRoot({ validate }). Se algo estiver inválido a API
 * não sobe, com uma mensagem listando todos os problemas, em vez de falhar
 * mais tarde (ex: Number('abc') = NaN num setInterval).
 *
 * Os valores retornados já vêm convertidos (number/boolean), e é isso que o
 * ConfigService.get() devolve.
 */

export interface Env {
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  DB_MIGRATIONS_RUN: boolean;
  PORT: number;
  SIM_ENABLED: boolean;
  SIM_INTERVAL_MS: number;
  INGEST_FLUSH_MS: number;
  INGEST_BUFFER_MAX: number;
  /** Janela de agrupamento do envio pelo WebSocket (0 = imediato). */
  LIVE_FLUSH_MS: number;
  LIVE_MAX_SAMPLES_PER_TAG: number;
  MQTT_ENABLED: boolean;
  MQTT_URL: string;
  /** Vazio = sem autenticação. */
  MQTT_USERNAME: string;
  MQTT_PASSWORD: string;
  MODBUS_ENABLED: boolean;
  MODBUS_HOST: string;
  MODBUS_PORT: number;
  MODBUS_POLL_MS: number;
  MODBUS_TIMEOUT_MS: number;
  OPCUA_ENABLED: boolean;
  OPCUA_ENDPOINT: string;
  OPCUA_SAMPLING_MS: number;
  /** Pasta dos certificados do cliente OPC UA (relativa ao diretório da API). */
  OPCUA_PKI_DIR: string;
}

/** Variáveis de ambiente cruas (sempre strings, vindas do process.env/.env). */
type Raw = Record<string, string | undefined>;

export function validateEnv(raw: Raw): Env {
  const errors: string[] = [];

  const str = (key: string, def: string): string => {
    const v = raw[key];
    if (v === undefined || v === '') return def;
    return v;
  };

  const int = (key: string, def: number, min: number, max: number): number => {
    const v = raw[key];
    if (v === undefined || v === '') return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${key}="${v}" deve ser inteiro entre ${min} e ${max}`);
      return def;
    }
    return n;
  };

  const bool = (key: string, def: boolean): boolean => {
    const v = raw[key];
    if (v === undefined || v === '') return def;
    if (v === 'true') return true;
    if (v === 'false') return false;
    errors.push(`${key}="${v}" deve ser "true" ou "false"`);
    return def;
  };

  const url = (key: string, def: string, protocols: string[]): string => {
    const v = str(key, def);
    let protocol: string;
    try {
      protocol = new URL(v).protocol.replace(/:$/, '');
    } catch {
      errors.push(`${key}="${v}" não é uma URL válida`);
      return def;
    }
    if (!protocols.includes(protocol)) {
      errors.push(`${key}="${v}" deve usar ${protocols.map((p) => `${p}://`).join(', ')}`);
      return def;
    }
    return v;
  };

  const env: Env = {
    DB_HOST: str('DB_HOST', 'localhost'),
    DB_PORT: int('DB_PORT', 5432, 1, 65535),
    DB_USER: str('DB_USER', 'scada'),
    DB_PASSWORD: str('DB_PASSWORD', 'scada'),
    DB_NAME: str('DB_NAME', 'scada'),
    DB_MIGRATIONS_RUN: bool('DB_MIGRATIONS_RUN', true),
    PORT: int('PORT', 3000, 1, 65535),
    SIM_ENABLED: bool('SIM_ENABLED', true),
    SIM_INTERVAL_MS: int('SIM_INTERVAL_MS', 1000, 10, 3_600_000),
    INGEST_FLUSH_MS: int('INGEST_FLUSH_MS', 2000, 10, 3_600_000),
    INGEST_BUFFER_MAX: int('INGEST_BUFFER_MAX', 100_000, 100, 10_000_000),
    LIVE_FLUSH_MS: int('LIVE_FLUSH_MS', 200, 0, 10_000),
    LIVE_MAX_SAMPLES_PER_TAG: int('LIVE_MAX_SAMPLES_PER_TAG', 100, 1, 100_000),
    MQTT_ENABLED: bool('MQTT_ENABLED', false),
    MQTT_URL: url('MQTT_URL', 'mqtt://localhost:1883', ['mqtt', 'mqtts', 'tcp', 'ws', 'wss']),
    MQTT_USERNAME: str('MQTT_USERNAME', ''),
    MQTT_PASSWORD: str('MQTT_PASSWORD', ''),
    MODBUS_ENABLED: bool('MODBUS_ENABLED', false),
    MODBUS_HOST: str('MODBUS_HOST', 'localhost'),
    MODBUS_PORT: int('MODBUS_PORT', 502, 1, 65535),
    MODBUS_POLL_MS: int('MODBUS_POLL_MS', 1000, 50, 3_600_000),
    MODBUS_TIMEOUT_MS: int('MODBUS_TIMEOUT_MS', 2000, 100, 60_000),
    OPCUA_ENABLED: bool('OPCUA_ENABLED', false),
    OPCUA_ENDPOINT: url('OPCUA_ENDPOINT', 'opc.tcp://localhost:4840', ['opc.tcp']),
    OPCUA_SAMPLING_MS: int('OPCUA_SAMPLING_MS', 1000, 50, 3_600_000),
    OPCUA_PKI_DIR: str('OPCUA_PKI_DIR', '.opcua-pki'),
  };

  if (errors.length > 0) {
    throw new Error(`Variáveis de ambiente inválidas:\n  - ${errors.join('\n  - ')}`);
  }
  return env;
}
