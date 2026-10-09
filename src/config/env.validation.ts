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
  /** Quantidade de tags do simulador (as 4 de exemplo e, acima disso, geradas). */
  SIM_TAGS: number;
  INGEST_FLUSH_MS: number;
  INGEST_BUFFER_MAX: number;
  /** Janela de agrupamento do envio do tempo real, SSE e WebSocket (0 = imediato). */
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
  OPCUA_SECURITY_MODE: OpcUaSecurityMode;
  /** Algoritmos da conexão segura (ignorado com OPCUA_SECURITY_MODE=none). */
  OPCUA_SECURITY_POLICY: OpcUaSecurityPolicy;
  /** Aceita certificado de servidor desconhecido (laboratório) ou só os confiáveis. */
  OPCUA_TRUST_UNKNOWN_CERTS: boolean;
  /** Autenticação (token HMAC). */
  AUTH_ENABLED: boolean;
  AUTH_USER: string;
  AUTH_PASSWORD: string;
  AUTH_SECRET: string;
  /** Banda morta padrão dos alarmes, em % do |limite| (quando a tag não define a sua). */
  ALARM_HYSTERESIS_PCT: number;
  /** Retenção do histórico bruto (TimescaleDB). */
  RETENTION_ENABLED: boolean;
  RETENTION_DAYS: number;
}

export const OPCUA_SECURITY_MODES = ['none', 'sign', 'sign_and_encrypt'] as const;
export type OpcUaSecurityMode = (typeof OPCUA_SECURITY_MODES)[number];

/** Políticas atuais da especificação (as antigas, como Basic128Rsa15, são inseguras). */
export const OPCUA_SECURITY_POLICIES = [
  'Basic256Sha256',
  'Aes128_Sha256_RsaOaep',
  'Aes256_Sha256_RsaPss',
] as const;
export type OpcUaSecurityPolicy = (typeof OPCUA_SECURITY_POLICIES)[number];

/** Valor de exemplo do .env.example: recusado com a autenticação ligada. */
export const EXAMPLE_AUTH_SECRET = 'troque-por-um-segredo-aleatorio-de-32-caracteres-ou-mais';

/**
 * A retenção precisa ser maior que a janela de reprocessamento do agregado de
 * 1 hora (7 dias, migration ContinuousAggregates); senão, o refresh recalcularia
 * os buckets a partir de dados brutos já apagados e perderia o agregado.
 */
export const MIN_RETENTION_DAYS = 8;

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

  const num = (key: string, def: number, min: number, max: number): number => {
    const v = raw[key];
    if (v === undefined || v === '') return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) {
      errors.push(`${key}="${v}" deve ser um número entre ${min} e ${max}`);
      return def;
    }
    return n;
  };

  const oneOf = <T extends string>(key: string, def: T, allowed: readonly T[]): T => {
    const v = raw[key];
    if (v === undefined || v === '') return def;
    if ((allowed as readonly string[]).includes(v)) return v as T;
    errors.push(`${key}="${v}" deve ser ${allowed.join(', ')}`);
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
    SIM_TAGS: int('SIM_TAGS', 4, 1, 10_000),
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
    OPCUA_SECURITY_MODE: oneOf('OPCUA_SECURITY_MODE', 'none', OPCUA_SECURITY_MODES),
    OPCUA_SECURITY_POLICY: oneOf(
      'OPCUA_SECURITY_POLICY',
      'Basic256Sha256',
      OPCUA_SECURITY_POLICIES,
    ),
    OPCUA_TRUST_UNKNOWN_CERTS: bool('OPCUA_TRUST_UNKNOWN_CERTS', true),
    AUTH_ENABLED: bool('AUTH_ENABLED', false),
    AUTH_USER: str('AUTH_USER', 'operador'),
    AUTH_PASSWORD: str('AUTH_PASSWORD', ''),
    AUTH_SECRET: str('AUTH_SECRET', ''),
    ALARM_HYSTERESIS_PCT: num('ALARM_HYSTERESIS_PCT', 2, 0, 50),
    RETENTION_ENABLED: bool('RETENTION_ENABLED', false),
    RETENTION_DAYS: int('RETENTION_DAYS', 90, MIN_RETENTION_DAYS, 36_500),
  };

  // Com a autenticação ligada, recusa subir sem senha ou com segredo fraco.
  if (env.AUTH_ENABLED) {
    if (env.AUTH_PASSWORD === '') errors.push('AUTH_ENABLED=true exige AUTH_PASSWORD');
    if (env.AUTH_SECRET.length < 32 || env.AUTH_SECRET === EXAMPLE_AUTH_SECRET) {
      errors.push(
        'AUTH_ENABLED=true exige AUTH_SECRET aleatório com 32 caracteres ou mais ' +
          "(gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\")",
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Variáveis de ambiente inválidas:\n  - ${errors.join('\n  - ')}`);
  }
  return env;
}
