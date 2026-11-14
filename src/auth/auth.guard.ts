import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService, AuthUser } from './auth.service';
import { IS_PUBLIC } from './public.decorator';

interface AuthRequest {
  headers: Record<string, unknown>;
  query?: Record<string, unknown>;
  user?: AuthUser;
}

export const QUERY_TOKEN = 'queryToken';

/**
 * Rota que também aceita o token em ?token= (o EventSource do SSE não envia
 * cabeçalhos). Só onde for preciso: um token na URL acaba em históricos e
 * logs de proxy.
 */
export const AllowQueryToken = () => SetMetadata(QUERY_TOKEN, true);

/**
 * Guard global (APP_GUARD): com AUTH_ENABLED=true, toda rota da API exige um
 * token válido, exceto as marcadas com @Public(). O token vem no cabeçalho
 * Authorization: Bearer ou, nas rotas com @AllowQueryToken(), em ?token=.
 * Com a autenticação desligada, a requisição segue como anônima.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true; // WebSocket: ver LiveGateway
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    const targets = [context.getHandler(), context.getClass()];
    const viaQuery = this.reflector.getAllAndOverride<boolean>(QUERY_TOKEN, targets);
    const token = AuthService.extractToken(
      req.headers.authorization,
      viaQuery ? req.query?.token : undefined,
    );
    const user = this.auth.validateToken(token);
    if (user) {
      req.user = user;
      return true;
    }
    if (isPublic) return true;
    throw new UnauthorizedException('Autenticação necessária.');
  }
}

/** Usuário autenticado da requisição (ou anônimo, com a autenticação desligada). */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser | undefined =>
    ctx.switchToHttp().getRequest<AuthRequest>().user,
);
