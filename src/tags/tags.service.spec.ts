import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Tag } from './tag.entity';
import { TagChange, TagsService } from './tags.service';

/** Repositório em memória com a parte da API do TypeORM que o serviço usa. */
function fakeRepo(initial: Partial<Tag>[] = []) {
  const rows = new Map<string, Tag>(initial.map((t) => [t.tag!, { enabled: true, ...t } as Tag]));
  return {
    rows,
    repo: {
      find: jest.fn(({ where }: { where?: Partial<Tag> } = {}) =>
        Promise.resolve(
          [...rows.values()]
            .filter(
              (t) => !where || Object.entries(where).every(([k, v]) => t[k as keyof Tag] === v),
            )
            .sort((a, b) => a.tag.localeCompare(b.tag)),
        ),
      ),
      findOneBy: jest.fn(({ tag }: { tag: string }) => Promise.resolve(rows.get(tag) ?? null)),
      existsBy: jest.fn(({ tag }: { tag: string }) => Promise.resolve(rows.has(tag))),
      create: jest.fn((dto: Partial<Tag>) => ({ enabled: true, ...dto })),
      insert: jest.fn((t: Tag) => {
        rows.set(t.tag, t);
        return Promise.resolve();
      }),
      update: jest.fn(({ tag }: { tag: string }, dto: Partial<Tag>) => {
        rows.set(tag, { ...rows.get(tag)!, ...dto });
        return Promise.resolve();
      }),
      delete: jest.fn(({ tag }: { tag: string }) => {
        rows.delete(tag);
        return Promise.resolve();
      }),
    },
  };
}

function setup(initial: Partial<Tag>[] = []) {
  const { repo, rows } = fakeRepo(initial);
  const service = new TagsService(repo as unknown as Repository<Tag>);
  const changes: TagChange[] = [];
  service.changes$.subscribe((c) => changes.push(c));
  return { service, repo, rows, changes };
}

describe('TagsService', () => {
  it('lista em ordem alfabética e filtra as habilitadas de uma fonte', async () => {
    const { service } = setup([
      { tag: 'B', source: 'mqtt' },
      { tag: 'A', source: 'mqtt' },
      { tag: 'C', source: 'mqtt', enabled: false },
      { tag: 'D', source: 'modbus' },
    ]);
    expect((await service.findAll()).map((t) => t.tag)).toEqual(['A', 'B', 'C', 'D']);
    expect((await service.findEnabledBySource('mqtt')).map((t) => t.tag)).toEqual(['A', 'B']);
  });

  it('findOne lança 404 para tag não cadastrada', async () => {
    const { service } = setup();
    await expect(service.findOne('NAO-EXISTE')).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('create', () => {
    it('cadastra e avisa em changes$', async () => {
      const { service, changes } = setup();
      const created = await service.create({ tag: 'T1', unit: 'bar' });
      expect(created).toMatchObject({ tag: 'T1', unit: 'bar', enabled: true });
      expect(changes).toEqual([{ type: 'created', tag: created }]);
    });

    it('recusa nome repetido com 409', async () => {
      const { service } = setup([{ tag: 'T1' }]);
      await expect(service.create({ tag: 'T1' })).rejects.toBeInstanceOf(ConflictException);
    });

    it('recusa limites fora de ordem com 400', async () => {
      const { service, repo } = setup();
      await expect(service.create({ tag: 'T1', alarmL: 50, alarmH: 10 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('valida o endereço com o validador registrado pela fonte', async () => {
      const { service } = setup();
      service.registerAddressValidator('mqtt', (a) => (a ? undefined : 'obrigatório'));
      await expect(service.create({ tag: 'T1', source: 'mqtt' })).rejects.toMatchObject({
        response: { message: ['address: obrigatório'] },
      });
      await expect(
        service.create({ tag: 'T1', source: 'mqtt', address: 'a/b' }),
      ).resolves.toBeDefined();
      // Fonte sem validador registrado: endereço livre.
      await expect(service.create({ tag: 'T2', source: 'opcua' })).resolves.toBeDefined();
    });
  });

  describe('update', () => {
    it('altera só os campos enviados, null apaga, e avisa com o estado anterior', async () => {
      const { service, changes } = setup([{ tag: 'T1', unit: 'bar', alarmH: 5, alarmL: 1 }]);
      const updated = await service.update('T1', { alarmH: null, description: 'Pressão' });
      expect(updated).toMatchObject({
        unit: 'bar',
        alarmH: null,
        alarmL: 1,
        description: 'Pressão',
      });
      expect(changes[0]).toMatchObject({
        type: 'updated',
        tag: { alarmH: null },
        previous: { alarmH: 5 },
      });
    });

    it('confere as regras sobre o resultado da alteração (cadastro + corpo)', async () => {
      const { service, repo } = setup([{ tag: 'T1', alarmL: 10, alarmH: 90 }]);
      await expect(service.update('T1', { alarmH: 5 })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('confere o endereço quando a fonte muda', async () => {
      const { service } = setup([{ tag: 'T1', source: 'sim' }]);
      service.registerAddressValidator('mqtt', (a) => (a ? undefined : 'obrigatório'));
      await expect(service.update('T1', { source: 'mqtt' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('lança 404 para tag não cadastrada', async () => {
      const { service } = setup();
      await expect(service.update('X', { unit: 'm' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('apaga e avisa com o último estado', async () => {
      const { service, rows, changes } = setup([{ tag: 'T1', source: 'mqtt' }]);
      await service.remove('T1');
      expect(rows.has('T1')).toBe(false);
      expect(changes[0]).toMatchObject({ type: 'deleted', tag: { tag: 'T1', source: 'mqtt' } });
    });

    it('lança 404 para tag não cadastrada', async () => {
      const { service } = setup();
      await expect(service.remove('X')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
