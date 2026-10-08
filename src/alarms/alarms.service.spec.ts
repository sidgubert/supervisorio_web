import { Logger, NotFoundException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { Repository } from 'typeorm';
import { IngestionService } from '../ingestion/ingestion.service';
import { QUALITY_BAD, Sample } from '../ingestion/sample';
import { Tag } from '../tags/tag.entity';
import { TagChange, TagsService } from '../tags/tags.service';
import { Alarm } from './alarm.entity';
import { AlarmEvent, AlarmsService } from './alarms.service';

/** "Banco" de alarmes em memória, que entende as 3 instruções do serviço. */
function fakeRepo(initial: Alarm[] = []) {
  const rows = new Map(initial.map((a) => [a.id, { ...a }]));
  const db = {
    down: false,
    rows,
    statements: [] as string[],
    repo: {
      find: jest.fn(() =>
        Promise.resolve([...rows.values()].filter((a) => !a.clearedAt || !a.ackedAt)),
      ),
      query: jest.fn(async (sql: string, p: unknown[]) => {
        await Promise.resolve();
        if (db.down) throw new Error('ECONNREFUSED');
        const kind = sql.trim().split(/\s+/)[0];
        if (kind === 'INSERT') {
          const [id, tag, level, limitValue, raisedAt, raisedValue] = p as [
            string,
            string,
            Alarm['level'],
            number,
            Date,
            number,
          ];
          if (!rows.has(id)) {
            rows.set(id, {
              id,
              tag,
              level,
              limitValue,
              raisedAt,
              raisedValue,
              clearedAt: null,
              clearedValue: null,
              ackedAt: null,
            });
          }
          db.statements.push(`raise ${tag} ${level}`);
        } else if (sql.includes('cleared_at = $2')) {
          const row = rows.get(p[0] as string);
          if (row && !row.clearedAt) {
            row.clearedAt = p[1] as Date;
            row.clearedValue = p[2] as number | null;
          }
          db.statements.push(`clear ${row?.tag} ${row?.level}`);
        } else {
          const row = rows.get(p[0] as string);
          if (row && !row.ackedAt) row.ackedAt = p[1] as Date;
          db.statements.push(`ack ${row?.tag} ${row?.level}`);
        }
        return [];
      }),
    },
  };
  return db;
}

function setup(tags: Partial<Tag>[], initialAlarms: Alarm[] = []) {
  let registry = tags.map((t) => ({ enabled: true, ...t }) as Tag);
  const db = fakeRepo(initialAlarms);
  const samples = new Subject<Sample[]>();
  const changes = new Subject<TagChange>();
  const tagsService = { findAll: jest.fn(() => Promise.resolve(registry)), changes$: changes };
  const service = new AlarmsService(
    db.repo as unknown as Repository<Alarm>,
    { samples$: samples } as unknown as IngestionService,
    tagsService as unknown as TagsService,
  );
  const events: AlarmEvent[] = [];
  service.events$.subscribe((e) => events.push(e));
  let t = Date.parse('2026-10-08T12:00:00Z');
  /** Emite uma amostra da tag, avançando o relógio da amostra em 1 s. */
  const push = (tag: string, value: number, quality = 192) => {
    t += 1000;
    samples.next([
      { tag, value, quality, time: new Date(t), source: 'sim', receivedAt: new Date(t) },
    ]);
  };
  const setTags = async (next: Partial<Tag>[]) => {
    registry = next.map((x) => ({ enabled: true, ...x }) as Tag);
    changes.next({ type: 'updated', tag: registry[0] });
    await (service as any).reloading;
  };
  /** Espera a fila de gravação esvaziar. */
  const flushed = async () => {
    for (let i = 0; i < 50 && ((service as any).writing || (service as any).outbox.length); i++) {
      await (service as any).writing;
      await new Promise((r) => setImmediate(r));
    }
  };
  return { service, db, events, push, setTags, flushed };
}

const tic = { tag: 'TIC-101.PV', alarmL: 60, alarmH: 90, alarmHH: 100 };

beforeAll(() => Logger.overrideLogger(false));

describe('AlarmsService', () => {
  afterEach(() => jest.useRealTimers());

  it('ativa ao violar o limite e normaliza ao voltar, gravando e publicando', async () => {
    const { service, db, events, push, flushed } = setup([tic]);
    await service.onModuleInit();

    push('TIC-101.PV', 75);
    push('TIC-101.PV', 92);
    expect(service.list()).toEqual([
      expect.objectContaining({
        tag: 'TIC-101.PV',
        level: 'H',
        state: 'ACTIVE_UNACKED',
        raisedValue: 92,
        limitValue: 90,
      }),
    ]);
    push('TIC-101.PV', 93); // continua alto: nada novo
    push('TIC-101.PV', 85);
    expect(service.list()).toEqual([
      expect.objectContaining({ state: 'CLEARED_UNACKED', clearedValue: 85 }),
    ]);

    await flushed();
    expect(db.statements).toEqual(['raise TIC-101.PV H', 'clear TIC-101.PV H']);
    expect(events.map((e) => `${e.type} ${e.alarm.state}`)).toEqual([
      'raised ACTIVE_UNACKED',
      'cleared CLEARED_UNACKED',
    ]);
  });

  it('reconhecer: ativo continua na lista; normalizado e reconhecido sai', async () => {
    const { service, db, push, flushed } = setup([tic]);
    await service.onModuleInit();
    push('TIC-101.PV', 95);
    const [alarm] = service.list();

    expect(service.ack(alarm.id)).toMatchObject({ state: 'ACTIVE_ACKED' });
    expect(service.ack(alarm.id).ackedAt).toEqual(service.list()[0].ackedAt); // idempotente
    push('TIC-101.PV', 70);
    expect(service.list()).toEqual([]);
    expect(() => service.ack(alarm.id)).toThrow(NotFoundException);

    await flushed();
    expect(db.statements).toEqual(['raise TIC-101.PV H', 'ack TIC-101.PV H', 'clear TIC-101.PV H']);
    expect(db.rows.get(alarm.id)).toMatchObject({ clearedValue: 70 });
  });

  it('ackAll reconhece só os não reconhecidos', async () => {
    const { service, push } = setup([tic, { tag: 'B', alarmH: 1 }]);
    await service.onModuleInit();
    push('TIC-101.PV', 101); // H e HH
    push('B', 2);
    service.ack(service.list().find((a) => a.tag === 'B')!.id);
    expect(service.ackAll()).toBe(2);
    expect(service.list().every((a) => a.state === 'ACTIVE_ACKED')).toBe(true);
  });

  it('lista os mais graves primeiro (HH/LL antes de H/L)', async () => {
    const { service, push } = setup([tic]);
    await service.onModuleInit();
    push('TIC-101.PV', 101);
    expect(service.list().map((a) => a.level)).toEqual(['HH', 'H']);
  });

  it('respeita a banda morta do cadastro', async () => {
    const { service, push } = setup([{ ...tic, alarmDeadband: 3 }]);
    await service.onModuleInit();
    push('TIC-101.PV', 91);
    push('TIC-101.PV', 88); // dentro da banda: continua ativo
    expect(service.list()[0].state).toBe('ACTIVE_UNACKED');
    push('TIC-101.PV', 86.9);
    expect(service.list()[0].state).toBe('CLEARED_UNACKED');
  });

  it('ignora amostras Bad e tags sem limites', async () => {
    const { service, push } = setup([tic, { tag: 'SEM-LIMITE' }]);
    await service.onModuleInit();
    push('TIC-101.PV', 120, QUALITY_BAD);
    push('SEM-LIMITE', 1e9);
    expect(service.list()).toEqual([]);
  });

  it('com o banco fora, funciona em memória e grava tudo em ordem quando ele volta', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const { service, db, push, flushed } = setup([tic]);
    await service.onModuleInit();
    db.down = true;
    push('TIC-101.PV', 95);
    service.ack(service.list()[0].id);
    push('TIC-101.PV', 70);
    await flushed();
    expect(service.list()).toEqual([]); // o estado em memória seguiu normalmente
    expect(db.rows.size).toBe(0);

    db.down = false;
    await jest.advanceTimersByTimeAsync(1000); // primeira nova tentativa
    await flushed();
    expect(db.statements).toEqual(['raise TIC-101.PV H', 'ack TIC-101.PV H', 'clear TIC-101.PV H']);
    expect([...db.rows.values()][0]).toMatchObject({ level: 'H' });
    expect([...db.rows.values()][0].ackedAt).not.toBeNull();
  });

  it('na subida recarrega os alarmes abertos do banco e continua de onde parou', async () => {
    const open: Alarm = {
      id: '11111111-1111-4111-8111-111111111111',
      tag: 'TIC-101.PV',
      level: 'H',
      limitValue: 90,
      raisedAt: new Date('2026-10-08T11:00:00Z'),
      raisedValue: 92,
      clearedAt: null,
      clearedValue: null,
      ackedAt: null,
    };
    const { service, db, push, flushed } = setup([tic], [open]);
    await service.onModuleInit();
    expect(service.list().map((a) => a.id)).toEqual([open.id]);
    push('TIC-101.PV', 95); // já ativo: não cria outro
    push('TIC-101.PV', 80); // normaliza o que veio do banco
    await flushed();
    expect(db.statements).toEqual(['clear TIC-101.PV H']);
    expect(db.rows.get(open.id)!.clearedValue).toBe(80);
  });

  it('limite apagado do cadastro normaliza o alarme ativo', async () => {
    const { service, setTags, push } = setup([tic]);
    await service.onModuleInit();
    push('TIC-101.PV', 95);
    await setTags([{ ...tic, alarmH: null }]);
    expect(service.list()[0]).toMatchObject({
      level: 'H',
      state: 'CLEARED_UNACKED',
      clearedValue: null,
    });
  });

  it('alarme aberto cujo limite sumiu com a API parada normaliza na subida', async () => {
    const open: Alarm = {
      id: '22222222-2222-4222-8222-222222222222',
      tag: 'REMOVIDA',
      level: 'L',
      limitValue: 5,
      raisedAt: new Date('2026-10-08T11:00:00Z'),
      raisedValue: 4,
      clearedAt: null,
      clearedValue: null,
      ackedAt: null,
    };
    const { service } = setup([tic], [open]);
    await service.onModuleInit();
    expect(service.list()[0]).toMatchObject({ id: open.id, state: 'CLEARED_UNACKED' });
  });

  it('no encerramento tenta gravar o que ficou na fila', async () => {
    const { service, db, push } = setup([tic]);
    await service.onModuleInit();
    db.down = true;
    push('TIC-101.PV', 95);
    await new Promise((r) => setImmediate(r));
    db.down = false;
    await service.onModuleDestroy();
    expect(db.statements).toEqual(['raise TIC-101.PV H']);
  });
});
