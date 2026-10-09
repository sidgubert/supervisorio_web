/**
 * Utilitários das ferramentas de experimento (tools/): conexão com o banco do
 * .env, opções da linha de comando, estatística e saída em Markdown/JSON.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { DataSource } from 'typeorm';
import { Env, validateEnv } from '../../src/config/env.validation';
import { buildDataSourceOptions } from '../../src/database/typeorm.config';

/** Variáveis do .env, validadas como na API. */
export function loadEnv(): Env {
  return validateEnv(process.env);
}

/** Conecta ao banco do .env (as mesmas variáveis DB_* da API). */
export function connectDb(env = loadEnv()): Promise<DataSource> {
  return new DataSource({
    ...buildDataSourceOptions(env),
    entities: [],
    migrations: [],
  }).initialize();
}

/** Opções `--nome=valor` ou `--nome valor` (com npm: `npm run x -- --nome=valor`). */
export function cliOptions(argv = process.argv.slice(2)): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) continue;
    if (match[2] !== undefined) out[match[1]] = match[2];
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[match[1]] = argv[++i];
    else out[match[1]] = 'true';
  }
  return out;
}

/** Opção numérica positiva, com padrão. Encerra com erro se for inválida. */
export function numberOption(opts: Record<string, string>, name: string, def: number): number {
  if (opts[name] === undefined) return def;
  const n = Number(opts[name]);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--${name}="${opts[name]}" deve ser um número positivo`);
    process.exit(1);
  }
  return n;
}

/** Percentil p (0–100) de uma lista em ordem crescente (vizinho mais próximo). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

export function mean(values: number[]): number {
  return values.length === 0 ? NaN : values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number {
  return percentile(
    [...values].sort((a, b) => a - b),
    50,
  );
}

/** Número no formato brasileiro (vírgula decimal), para colar no texto. */
export function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Tabela em Markdown. */
export function table(headers: string[], rows: (string | number)[][]): string {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** Grava o resultado em JSON, se --out foi informado. */
export function saveJson(path: string | undefined, data: unknown) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nResultado gravado em ${path}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
