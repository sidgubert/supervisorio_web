import { parseMqttPayload, validateMqttTopic } from './mqtt-payload';

describe('parseMqttPayload', () => {
  it.each([
    ['21.5', 21.5],
    ['  -3 ', -3],
    ['1e3', 1000],
    ['.5', 0.5],
    ['true', 1],
    ['FALSE', 0],
  ])('texto %j -> value %d', (raw, value) => {
    expect(parseMqttPayload(raw)).toEqual({ value });
  });

  it('JSON só com value (número ou booleano)', () => {
    expect(parseMqttPayload('{"value": 7.25}')).toEqual({ value: 7.25 });
    expect(parseMqttPayload('{"value": true}')).toEqual({ value: 1 });
  });

  it('JSON com time ISO e quality', () => {
    expect(parseMqttPayload('{"value": 1, "time": "2026-10-08T12:00:00Z", "quality": 64}')).toEqual(
      { value: 1, time: new Date('2026-10-08T12:00:00Z'), quality: 64 },
    );
  });

  it('aceita os apelidos timestamp/ts e q', () => {
    const t = new Date('2026-10-08T12:00:00Z');
    expect(parseMqttPayload(`{"value": 1, "timestamp": "${t.toISOString()}", "q": 0}`)).toEqual({
      value: 1,
      time: t,
      quality: 0,
    });
  });

  it('epoch em segundos ou em milissegundos', () => {
    const t = new Date('2026-10-08T12:00:00Z');
    expect(parseMqttPayload(`{"value": 1, "ts": ${t.getTime() / 1000}}`)).toEqual({
      value: 1,
      time: t,
    });
    expect(parseMqttPayload(`{"value": 1, "ts": ${t.getTime()}}`)).toEqual({ value: 1, time: t });
  });

  it.each([
    ['', /vazio/],
    ['abc', /formato não reconhecido/],
    ['0x10', /formato não reconhecido/],
    ['[1, 2]', /formato não reconhecido/],
    ['"21.5"', /formato não reconhecido/],
    ['{"valor": 1}', /"value" deve ser/],
    ['{"value": "1"}', /"value" deve ser/],
    ['{"value": 1, "time": "ontem"}', /"time" deve ser/],
    ['{"value": 1, "quality": "boa"}', /"quality" deve ser/],
  ])('recusa %j', (raw, msg) => {
    const result = parseMqttPayload(raw);
    expect('error' in result && result.error).toMatch(msg);
  });
});

describe('validateMqttTopic', () => {
  it('aceita tópicos comuns', () => {
    expect(validateMqttTopic('planta/area1/tic101')).toBeUndefined();
    expect(validateMqttTopic('$SYS/broker/uptime')).toBeUndefined();
  });

  it.each([
    [undefined, /informe o tópico/],
    ['', /informe o tópico/],
    ['planta/+/tic101', /curingas/],
    ['planta/#', /curingas/],
    ['a\u0000b', /NUL/],
  ])('recusa %j', (topic, msg) => {
    expect(validateMqttTopic(topic)).toMatch(msg);
  });
});
