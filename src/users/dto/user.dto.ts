import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role, ROLES } from '../role';
import { MIN_PASSWORD_LENGTH } from '../users.service';

export class CreateUserDto {
  @IsString()
  @Matches(/^[\w.@-]{3,50}$/, {
    message: 'username deve ter 3 a 50 caracteres: letras, números, _ . @ -',
  })
  username!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(200)
  password!: string;

  @IsIn(ROLES)
  role!: Role;
}

export class UpdateUserDto {
  @IsOptional()
  @IsIn(ROLES)
  role?: Role;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(200)
  password?: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(200)
  current!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(200)
  password!: string;
}
