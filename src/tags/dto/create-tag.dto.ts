import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** Fontes de aquisição conhecidas (o `name` de cada AcquisitionSource). */
export const TAG_SOURCES = ['sim', 'mqtt', 'modbus', 'opcua'] as const;
export type TagSource = (typeof TAG_SOURCES)[number];

/**
 * Nome de tag no estilo ISA (ex: TIC-101.PV): letras, dígitos e `. _ : -`,
 * começando por letra ou dígito. Sem `/`, `?` ou `#`, porque o nome vai na URL
 * (/tags/:tag).
 */
export const TAG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const finite = { allowNaN: false, allowInfinity: false };

/**
 * Corpo de POST /tags. Campos opcionais aceitam `null` (sem valor); limites de
 * alarme e faixa são conferidos em conjunto em tag-rules.ts.
 */
export class CreateTagDto {
  @Matches(TAG_NAME_PATTERN, {
    message: 'tag deve ter até 200 caracteres: letras, dígitos e . _ : - (ex: TIC-101.PV)',
  })
  tag!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string | null;

  @IsOptional()
  @IsNumber(finite)
  engMin?: number | null;

  @IsOptional()
  @IsNumber(finite)
  engMax?: number | null;

  @IsOptional()
  @IsNumber(finite)
  alarmLL?: number | null;

  @IsOptional()
  @IsNumber(finite)
  alarmL?: number | null;

  @IsOptional()
  @IsNumber(finite)
  alarmH?: number | null;

  @IsOptional()
  @IsNumber(finite)
  alarmHH?: number | null;

  @IsOptional()
  @IsIn(TAG_SOURCES)
  source?: TagSource | null;

  /** Endereço no protocolo da fonte; o formato é conferido pela própria fonte. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;

  // `null` não é aceito: a coluna é NOT NULL.
  @ValidateIf((o: CreateTagDto) => o.enabled !== undefined)
  @IsBoolean()
  enabled?: boolean;
}
