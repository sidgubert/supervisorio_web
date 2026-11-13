import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasRole, Role } from '../users/role';
import { AuthUser } from './auth.service';
import { REQUIRED_ROLE } from './roles.decorator';

/**
 * Guard global, executado depois do AuthGuard (que preenche req.user): recusa
 * com 403 quem não tem o perfil exigido por @Roles(). Com a autenticação
 * desligada o usuário é anônimo com perfil admin, e tudo passa.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const required = this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user || !hasRole(user.role, required)) {
      throw new ForbiddenException(`Requer o perfil ${required} ou superior.`);
    }
    return true;
  }
}
