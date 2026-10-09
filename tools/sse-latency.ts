/**
 * Latência do tempo real (npm run bench:sse): conecta no SSE do dashboard
 * (/api/dashboard/stream) como um navegador e mede, para cada amostra
 * recebida, o tempo desde a medição (campo time) até a chegada no cliente.
 *
 *   npm run bench:sse -- [--url=http://localhost:3000] [--seconds=60] [--out=resultados/sse.json]
 *
 * A latência inclui a aquisição, o agrupamento do tempo real (LIVE_FLUSH_MS)
 * e a entrega HTTP; não inclui a gravação no banco, que corre em paralelo.
 * Com o login ligado (AUTH_ENABLED=true no .env), entra com AUTH_USER e
 * AUTH_PASSWORD do .env.
 */
import {
  cliOptions,
  fmt,
  loadEnv,
  mean,
  numberOption,
  percentile,
  saveJson,
  table,
} from './lib/common';

interface SampleEvent {
  type: 'sample';
  tag: string;
  source: string;
  time: string;
}

async function login(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login falhou: HTTP ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

async function main() {
  const opts = cliOptions();
  const env = loadEnv();
  const base = (opts.url ?? `http://localhost:${env.PORT}`).replace(/\/$/, '');
  const seconds = numberOption(opts, 'seconds', 60);

  let url = `${base}/api/dashboard/stream`;
  if (env.AUTH_ENABLED) {
    url += `?token=${encodeURIComponent(await login(base, env.AUTH_USER, env.AUTH_PASSWORD))}`;
  }

  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  if (!res.ok || !res.body) throw new Error(`SSE respondeu HTTP ${res.status}`);
  console.log(`Conectado a ${base}; medindo por ${seconds} s...`);

  const bySource = new Map<string, number[]>();
  const tags = new Set<string>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const stopAt = Date.now() + seconds * 1000;
  const timer = setTimeout(() => controller.abort(), seconds * 1000);

  try {
    while (Date.now() < stopAt) {
      const { value, done } = await reader.read();
      if (done) break;
      const arrivedAt = Date.now();
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      // Eventos SSE terminam com uma linha em branco.
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (!data) continue;
        const event = JSON.parse(data) as SampleEvent | { type: string };
        if (event.type !== 'sample') continue;
        const sample = event as SampleEvent;
        const list = bySource.get(sample.source) ?? [];
        list.push(arrivedAt - Date.parse(sample.time));
        bySource.set(sample.source, list);
        tags.add(sample.tag);
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }

  const rows = [...bySource.entries()].map(([source, values]) => {
    values.sort((a, b) => a - b);
    return {
      source,
      samples: values.length,
      perSec: values.length / seconds,
      meanMs: mean(values),
      p50Ms: percentile(values, 50),
      p95Ms: percentile(values, 95),
      p99Ms: percentile(values, 99),
      maxMs: values[values.length - 1],
    };
  });
  console.log(`\n${tags.size} tags\n`);
  console.log(
    table(
      [
        'Fonte',
        'Amostras',
        'Amostras/s',
        'Média (ms)',
        'p50 (ms)',
        'p95 (ms)',
        'p99 (ms)',
        'Máx. (ms)',
      ],
      rows.map((r) => [
        r.source,
        r.samples.toLocaleString('pt-BR'),
        fmt(r.perSec, 1),
        fmt(r.meanMs, 1),
        fmt(r.p50Ms, 0),
        fmt(r.p95Ms, 0),
        fmt(r.p99Ms, 0),
        fmt(r.maxMs, 0),
      ]),
    ),
  );
  saveJson(opts.out, { url: base, seconds, tags: tags.size, bySource: rows });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
