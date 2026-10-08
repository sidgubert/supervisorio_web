import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateTagDto } from './create-tag.dto';

/**
 * Corpo de PATCH /tags/:tag: qualquer campo do cadastro, exceto o nome.
 * Campo ausente = não altera; `null` = apaga o valor.
 */
export class UpdateTagDto extends PartialType(OmitType(CreateTagDto, ['tag'] as const)) {}
