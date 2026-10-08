import { Controller, Get, Param } from '@nestjs/common';
import { TagsService } from './tags.service';

@Controller('tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  /** Todas as tags cadastradas, em ordem alfabética. */
  @Get()
  findAll() {
    return this.tags.findAll();
  }

  /** Uma tag (ex: TIC-101.PV); 404 se não cadastrada. */
  @Get(':tag')
  findOne(@Param('tag') tag: string) {
    return this.tags.findOne(tag);
  }
}
