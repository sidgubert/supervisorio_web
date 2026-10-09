/**
 * Benchmark de gravação (npm run bench:insert): compara gravar amostras linha
 * a linha com gravar em lote, usando a mesma instrução da ingestão
 * (MeasurementsService.insertBatch: INSERT ... SELECT FROM unnest).
 *
 *   npm run bench:insert -- [--rows=10000] [--runs=3] [--out=resultados/insert.json]
 *
 * Grava numa hypertable temporária (bench_measurements, criada com a mesma
 * estrutura de measurements e apagada no fim): não toca nos dados do sistema.
 *
 * 1. Vazão: --rows linhas gravadas de cada jeito (mediana de --runs execuções):
 *    - linha a linha, uma transação por linha (o que um código ingênuo faz);
 *    - linha a linha, todas numa transação (separa o custo do commit);
 *    - em lotes de 100, 1.000 e 10.000 linhas.
 * 2. Latência de um lote, de 1 a 10.000 linhas: quanto demora cada INSERT.
 */
import { performance } from 'perf_hooks';
import { DataSource } from 'typeorm';
import { INSERT_SQL } from '../src/measurements/measurements.service';
import {
  cliOptions,
  connectDb,
  fmt,
  median,
  numberOption,
  percentile,
  saveJson,
  table,
} from './lib/common';

const TABLE = 'bench_measurements';
const BATCH_SQL = INSERT_SQL.replace('INSERT INTO measurements', `INSERT INTO ${TABLE}`);
const ROW_SQL = `INSERT INTO ${TABLE} (time, tag, value, quality, source, received_at)
  VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`;

interface Row {
  time: Date;
  tag: string;
  value: number;
  quality: number;
  source: string;
  receivedAt: Date;
}

/** Linhas sintéticas: 100 tags, instantes distintos (nenhum conflito). */
function makeRows(count: number, offset: number): Row[] {
  const base = Date.now() - 3_600_000;
  const now = new Date();
  return Array.from({ length: count }, (_, i) => ({
    time: new Date(base + offset + i),
    tag: `BENCH-${String(i % 100).padStart(3, '0')}`,
    value: Math.round(Math.random() * 100_000) / 1000,
    quality: 192,
    source: 'bench',
    receivedAt: now,
  }));
}

const params = (r: Row) => [r.time, r.tag, r.value, r.quality, r.source, r.receivedAt];
const columns = (rows: Row[]) => [
  rows.map((r) => r.time),
  rows.map((r) => r.tag),
  rows.map((r) => r.value),
  rows.map((r) => r.quality),
  rows.map((r) => r.source),
  rows.map((r) => r.receivedAt),
];

async function rowByRow(ds: DataSource, rows: Row[]) {
  for (const r of rows) await ds.query(ROW_SQL, params(r));
}

async function rowByRowInTransaction(ds: DataSource, rows: Row[]) {
  const runner = ds.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    for (const r of rows) await runner.query(ROW_SQL, params(r));
    await runner.commitTransaction();
  } finally {
    await runner.release();
  }
}

async function batches(ds: DataSource, rows: Row[], size: number) {
  for (let i = 0; i < rows.length; i += size) {
    await ds.query(BATCH_SQL, columns(rows.slice(i, i + size)));
  }
}

async function main() {
  const opts = cliOptions();
  const totalRows = numberOption(opts, 'rows', 10_000);
  const runs = numberOption(opts, 'runs', 3);
  const ds = await connectDb();
  const [{ version }] = await ds.query<{ version: string }[]>(
    `SELECT extversion AS version FROM pg_extension WHERE extname = 'timescaledb'`,
  );

  await ds.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await ds.query(`CREATE TABLE ${TABLE} (LIKE measurements INCLUDING DEFAULTS INCLUDING INDEXES)`);
  await ds.query(`SELECT create_hypertable('${TABLE}', 'time')`);
  const reset = () => ds.query(`TRUNCATE ${TABLE}`);

  try {
    // Aquecimento: conexões abertas, planos em cache.
    await batches(ds, makeRows(2000, 0), 100);
    await rowByRow(ds, makeRows(200, 10_000));
    await reset();

    console.log(`TimescaleDB ${version}; ${totalRows} linhas; mediana de ${runs} execuções\n`);
    const methods: [string, (rows: Row[]) => Promise<void>][] = [
      ['Linha a linha (1 transação por linha)', (r) => rowByRow(ds, r)],
      ['Linha a linha (todas em 1 transação)', (r) => rowByRowInTransaction(ds, r)],
      ['Lotes de 100 (unnest)', (r) => batches(ds, r, 100)],
      ['Lotes de 1.000 (unnest)', (r) => batches(ds, r, 1000)],
      ['Lotes de 10.000 (unnest)', (r) => batches(ds, r, 10_000)],
    ];
    const throughput: { method: string; seconds: number; rowsPerSec: number }[] = [];
    for (const [method, run] of methods) {
      const times: number[] = [];
      for (let k = 0; k < runs; k++) {
        const rows = makeRows(totalRows, (k + 1) * 10_000_000);
        const t0 = performance.now();
        await run(rows);
        times.push((performance.now() - t0) / 1000);
        await reset();
      }
      const seconds = median(times);
      throughput.push({ method, seconds, rowsPerSec: totalRows / seconds });
      console.log(`  ${method}: ${fmt(seconds, 2)} s`);
    }
    const baseline = throughput[0].rowsPerSec;
    console.log('\n## Vazão\n');
    console.log(
      table(
        ['Método', 'Tempo (s)', 'Linhas/s', 'Ganho'],
        throughput.map((t) => [
          t.method,
          fmt(t.seconds, 2),
          fmt(t.rowsPerSec, 0),
          `${fmt(t.rowsPerSec / baseline, 1)}×`,
        ]),
      ),
    );

    // Latência de um INSERT em lote, por tamanho do lote.
    const latency: { size: number; meanMs: number; p50Ms: number; p95Ms: number }[] = [];
    for (const size of [1, 10, 20, 100, 1000, 10_000]) {
      const repeats = size >= 10_000 ? 10 : 50;
      const samples: number[] = [];
      for (let k = 0; k < repeats; k++) {
        const rows = makeRows(size, 100_000_000 + k * 20_000);
        const t0 = performance.now();
        await ds.query(BATCH_SQL, columns(rows));
        samples.push(performance.now() - t0);
      }
      await reset();
      samples.sort((a, b) => a - b);
      latency.push({
        size,
        meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
        p50Ms: percentile(samples, 50),
        p95Ms: percentile(samples, 95),
      });
    }
    console.log('\n## Latência de um lote (INSERT ... unnest)\n');
    console.log(
      table(
        ['Linhas no lote', 'Média (ms)', 'p50 (ms)', 'p95 (ms)', 'ms por linha'],
        latency.map((l) => [
          l.size.toLocaleString('pt-BR'),
          fmt(l.meanMs, 2),
          fmt(l.p50Ms, 2),
          fmt(l.p95Ms, 2),
          fmt(l.meanMs / l.size, 4),
        ]),
      ),
    );

    saveJson(opts.out, { timescaledb: version, rows: totalRows, runs, throughput, latency });
  } finally {
    await ds.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
