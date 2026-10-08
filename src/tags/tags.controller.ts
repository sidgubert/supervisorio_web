import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
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

  /** Cadastra uma tag; 409 se já existir. */
  @Post()
  create(@Body() dto: CreateTagDto) {
    return this.tags.create(dto);
  }

  /** Altera campos de uma tag (ausente = mantém; null = apaga). */
  @Patch(':tag')
  update(@Param('tag') tag: string, @Body() dto: UpdateTagDto) {
    return this.tags.update(tag, dto);
  }

  /** Remove a tag do cadastro. O histórico de medições é mantido. */
  @Delete(':tag')
  @HttpCode(204)
  remove(@Param('tag') tag: string) {
    return this.tags.remove(tag);
  }
}
