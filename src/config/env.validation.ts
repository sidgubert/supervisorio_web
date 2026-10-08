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
  };

  if (errors.length > 0) {
    throw new Error(`Variáveis de ambiente inválidas:\n  - ${errors.join('\n  - ')}`);
  }
  return env;
}
