import { SetMetadata } from '@nestjs/common';
import { Role } from '../users/role';

export const REQUIRED_ROLE = 'requiredRole';

/** Exige o perfil informado (ou um maior) na rota ou no controller. Sem o decorator, qualquer autenticado passa. */
export const Roles = (role: Role) => SetMetadata(REQUIRED_ROLE, role);
