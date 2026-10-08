import { SampleInput } from '../../ingestion/sample';

/** Amostra lida de uma mensagem MQTT (a tag vem do tópico). */
export type ParsedPayload = Omit<SampleInput, 'tag'>;

const NUMBER_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * Epoch abaixo deste valor é tratado como segundos; acima, milissegundos.
 * 1e11 s ≈ ano 5138; 1e11 ms ≈ 1973 — não há ambiguidade para datas reais.
 */
const EPOCH_SECONDS_LIMIT = 1e11;

const FORMAT_HELP =
  'esperado número, true/false ou JSON {"value": 21.5, "time": "...", "quality": 192}';

/**
 * Converte o payload de uma mensagem MQTT em amostra. Formatos aceitos:
 *
 *   21.5                     número em texto
 *   true / false             booleano (1 / 0)
 *   {"value": 21.5}          JSON; também aceita booleano em value
 *   {"value": 21.5, "time": "2026-10-08T12:00:00Z", "quality": 192}
 *
 * `time` (ou `timestamp`/`ts`): ISO 8601 ou epoch em segundos/milissegundos;
 * omitido = instante de recebimento. `quality` (ou `q`): byte de qualidade.
 */
export function parseMqttPayload(raw: string): ParsedPayload | { error: string } {
  const text = raw.trim();
  if (text === '') return { error: 'payload vazio' };

  const lower = text.toLowerCase();
  if (lower === 'true') return { value: 1 };
  if (lower === 'false') return { value: 0 };
  if (NUMBER_TEXT.test(text)) return { value: Number(text) };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: `formato não reconhecido; ${FORMAT_HELP}` };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { error: `formato não reconhecido; ${FORMAT_HELP}` };
  }

  const obj = json as Record<string, unknown>;
  const value = toValue(obj.value);
  if (value === undefined) return { error: '"value" deve ser número ou booleano' };

  const out: ParsedPayload = { value };

  const rawTime = obj.time ?? obj.timestamp ?? obj.ts;
  if (rawTime !== undefined && rawTime !== null) {
    const time = toDate(rawTime);
    if (!time) return { error: '"time" deve ser ISO 8601 ou epoch (segundos ou milissegundos)' };
    out.time = time;
  }

  const rawQuality = obj.quality ?? obj.q;
  if (rawQuality !== undefined && rawQuality !== null) {
    if (typeof rawQuality !== 'number') return { error: '"quality" deve ser número' };
    out.quality = rawQuality;
  }
  return out;
}

function toValue(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
}

function toDate(v: unknown): Date | undefined {
  let d: Date;
  if (typeof v === 'number' && Number.isFinite(v)) {
    d = new Date(Math.abs(v) < EPOCH_SECONDS_LIMIT ? v * 1000 : v);
  } else if (typeof v === 'string') {
    d = new Date(v);
  } else {
    return undefined;
  }
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Valida o `address` de uma tag MQTT: o tópico exato a assinar.
 * Devolve a mensagem de erro, ou undefined se estiver ok.
 */
export function validateMqttTopic(address: string | null | undefined): string | undefined {
  if (!address) return 'informe o tópico MQTT (ex: planta/area1/tic101)';
  if (/[+#]/.test(address)) {
    return 'curingas (+ e #) não são permitidos: cada tag corresponde a um tópico';
  }
  if (address.includes('\u0000')) return 'o tópico não pode conter o caractere NUL';
  return undefined;
}
