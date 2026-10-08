import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tag } from './tag.entity';

@Injectable()
export class TagsService {
  constructor(
    @InjectRepository(Tag)
    private readonly repo: Repository<Tag>,
  ) {}

  findAll(): Promise<Tag[]> {
    return this.repo.find({ order: { tag: 'ASC' } });
  }

  async findOne(tag: string): Promise<Tag> {
    const found = await this.repo.findOneBy({ tag });
    if (!found) throw new NotFoundException(`Tag "${tag}" não cadastrada`);
    return found;
  }
}
