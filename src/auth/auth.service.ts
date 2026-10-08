import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Env } from '../config/env.validation';

export interface AuthUser {
  username: string;
}

/** Validade do token. */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Usuário atribuído às requisições quando a autenticação está desligada. */
export const ANONYMOUS: AuthUser = { username: 'anônimo' };

/**
 * Autenticação por token HMAC, didaticamente simples:
 *
 *   token = base64url(JSON {user, exp}) + "." + base64url(HMAC-SHA256(payload, AUTH_SECRET))
 *
 * Quem não conhece AUTH_SECRET não consegue gerar uma assinatura válida, e a
 * expiração (24 h) faz parte do conteúdo assinado. Não há sessão no servidor:
 * validar é recalcular a assinatura.
 *
 * Usuário e senha vêm de AUTH_USER/AUTH_PASSWORD (um operador), adequado ao
 * laboratório; em produção, use um cadastro de usuários com senhas em hash
 * (bcrypt/argon2) e um padrão como JWT/OIDC.
 */
@Injectable()
export class AuthService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  isEnabled(): boolean {
    return this.config.get('AUTH_ENABLED', { infer: true });
  }

  login(username: string, password: string): { token: string; user: AuthUser } {
    const okUser = safeEqual(username, this.config.get('AUTH_USER', { infer: true }));
    const okPass = safeEqual(password, this.config.get('AUTH_PASSWORD', { infer: true }));
    if (!okUser || !okPass) throw new UnauthorizedException('Usuário ou senha inválidos.');
    return { token: this.sign(username, Date.now() + TOKEN_TTL_MS), user: { username } };
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
      return { username: data.user };
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
