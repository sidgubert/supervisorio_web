import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateTagDto } from './create-tag.dto';
import { UpdateTagDto } from './update-tag.dto';

/** O mesmo ValidationPipe registrado no AppModule. */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });
const body = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'body',
  metatype,
});

async function errorsFor(dto: typeof CreateTagDto | typeof UpdateTagDto, value: unknown) {
  try {
    await pipe.transform(value, body(dto));
    return [];
  } catch (err) {
    const res = (err as BadRequestException).getResponse() as { message: string[] };
    return res.message;
  }
}

describe('CreateTagDto', () => {
  it('aceita uma tag completa', async () => {
    expect(
      await errorsFor(CreateTagDto, {
        tag: 'TIC-101.PV',
        description: 'Temperatura',
        unit: '°C',
        engMin: 0,
        engMax: 150,
        alarmLL: null,
        alarmL: 60,
        alarmH: 90,
        alarmHH: 100,
        source: 'mqtt',
        address: 'planta/tic101',
        enabled: true,
      }),
    ).toEqual([]);
  });

  it('só o nome é obrigatório', async () => {
    expect(await errorsFor(CreateTagDto, { tag: 'X' })).toEqual([]);
  });

  it.each([
    '',
    'com espaço',
    'barra/no/nome',
    'TIC?1',
    '-começa-com-hífen',
    'Pressão',
    'x'.repeat(201),
  ])('recusa o nome %j', async (tag) => {
    expect((await errorsFor(CreateTagDto, { tag }))[0]).toMatch(/^tag deve ter/);
  });

  it('recusa tipos errados, fonte desconhecida e campos que não existem', async () => {
    const errors = await errorsFor(CreateTagDto, {
      tag: 'X',
      engMin: '10',
      source: 'profibus',
      enabled: null,
      cor: 'azul',
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^engMin must be a number/),
        expect.stringMatching(/^source must be one of/),
        expect.stringMatching(/^enabled must be a boolean/),
        'property cor should not exist',
      ]),
    );
  });
});

describe('UpdateTagDto', () => {
  it('sinótico: desenho conhecido (ou null) e posição inteira de 0 a 100', async () => {
    expect(
      await errorsFor(UpdateTagDto, { synopticKind: 'tank', synopticX: 0, synopticY: 100 }),
    ).toEqual([]);
    expect(await errorsFor(UpdateTagDto, { synopticKind: null, synopticX: null })).toEqual([]);
    const errors = await errorsFor(UpdateTagDto, {
      synopticKind: 'valvula',
      synopticX: 101,
      synopticY: 12.5,
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^synopticKind must be one of/),
        expect.stringMatching(/^synopticX must not be greater than 100/),
        expect.stringMatching(/^synopticY must be an integer/),
      ]),
    );
  });

  it('banda morta de alarme não pode ser negativa', async () => {
    expect(await errorsFor(UpdateTagDto, { alarmDeadband: 0.5 })).toEqual([]);
    expect(await errorsFor(UpdateTagDto, { alarmDeadband: -1 })).toEqual([
      'alarmDeadband must not be less than 0',
    ]);
  });

  it('aceita alteração parcial e null para apagar', async () => {
    expect(await errorsFor(UpdateTagDto, { alarmH: null, unit: 'bar' })).toEqual([]);
  });

  it('não permite trocar o nome', async () => {
    expect(await errorsFor(UpdateTagDto, { tag: 'OUTRO' })).toEqual([
      'property tag should not exist',
    ]);
  });
});
