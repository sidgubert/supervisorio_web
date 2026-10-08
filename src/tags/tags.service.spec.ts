import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Tag } from './tag.entity';
import { TagsService } from './tags.service';

describe('TagsService', () => {
  const tic = { tag: 'TIC-101.PV', unit: '°C' } as Tag;
  const repo = {
    find: jest.fn().mockResolvedValue([tic]),
    findOneBy: jest.fn(({ tag }: { tag: string }) => Promise.resolve(tag === tic.tag ? tic : null)),
  };
  const service = new TagsService(repo as unknown as Repository<Tag>);

  it('lista as tags em ordem alfabética', async () => {
    await expect(service.findAll()).resolves.toEqual([tic]);
    expect(repo.find).toHaveBeenCalledWith({ order: { tag: 'ASC' } });
  });

  it('retorna a tag cadastrada', async () => {
    await expect(service.findOne('TIC-101.PV')).resolves.toBe(tic);
  });

  it('lança 404 para tag não cadastrada', async () => {
    await expect(service.findOne('NAO-EXISTE')).rejects.toBeInstanceOf(NotFoundException);
  });
});
