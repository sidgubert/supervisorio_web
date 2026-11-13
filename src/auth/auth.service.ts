import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Env } from '../config/env.validation';
import { Role } from '../users/role';
import { UsersService } from '../users/users.service';

export interface AuthUser {
  username: string;
  role: Role;
}

/** Validade do token. */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Usuário atribuído às requisições quando a autenticação está desligada (sem restrição de perfil). */
export const ANONYMOUS: AuthUser = { username: 'anônimo', role: 'admin' };

/**
 * Autenticação por token HMAC, didaticamente simples:
 *
 *   token = base64url(JSON {user, exp}) + "." + base64url(HMAC-SHA256(payload, AUTH_SECRET))
 *
 * Quem não conhece AUTH_SECRET não consegue gerar uma assinatura válida, e a
 * expiração (24 h) faz parte do conteúdo assinado. Não há sessão no servidor:
 * validar é recalcular a assinatura.
 *
 * Usuários e perfis ficam no banco (senha com hash argon2, ver UsersService).
 * O token só identifica o usuário; o perfil é lido de UsersService a cada
 * validação, então desativar um usuário ou trocar seu perfil vale na hora,
 * sem esperar o token expirar.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly users: UsersService,
  ) {}

  isEnabled(): boolean {
    return this.config.get('AUTH_ENABLED', { infer: true });
  }

  async login(username: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const found = await this.users.verify(username, password);
    return {
      token: this.sign(found.username, Date.now() + TOKEN_TTL_MS),
      user: { username: found.username, role: found.role },
    };
  }

  /** Usuário do token, ou null se inválido/expirado. Com auth desligada, anônimo. */
  validateToken(token: string | undefined | null): AuthUser | null {
    if (!this.isEnabled()) return ANONYMOUS;
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    if (!safeEqual(signature, this.signature(payload))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        user?: unknown;
        exp?: unknown;
      };
      if (typeof data.user !== 'string' || typeof data.exp !== 'number') return null;
      if (data.exp < Date.now()) return null;
      const role = this.users.activeRole(data.user);
      return role ? { username: data.user, role } : null;
    } catch {
      return null;
    }
  }

  /** Token do cabeçalho "Authorization: Bearer ..." ou do parâmetro ?token= (SSE). */
  static extractToken(authorization: unknown, queryToken: unknown): string | undefined {
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      return authorization.slice(7);
    }
    return typeof queryToken === 'string' ? queryToken : undefined;
  }

  sign(username: string, exp: number): string {
    const payload = Buffer.from(JSON.stringify({ user: username, exp })).toString('base64url');
    return `${payload}.${this.signature(payload)}`;
  }

  private signature(payload: string): string {
    return createHmac('sha256', this.config.get('AUTH_SECRET', { infer: true }))
      .update(payload)
      .digest('base64url');
  }
}

/**
 * Comparação em tempo constante: `a === b` para no primeiro caractere
 * diferente, e o tempo de resposta revelaria quantos caracteres acertaram.
 * Os hashes têm sempre o mesmo tamanho, como o timingSafeEqual exige.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
