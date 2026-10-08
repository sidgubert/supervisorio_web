import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/** Rota acessível sem login, mesmo com AUTH_ENABLED=true (ex: health, login). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
