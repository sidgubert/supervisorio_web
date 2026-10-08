import { ExecutionContext, HttpException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Env } from '../config/env.validation';
import { AuthController, MAX_LOGIN_ATTEMPTS } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { ANONYMOUS, AuthService } from './auth.service';

const SECRET = 's'.repeat(40);

function service(enabled = true, secret = SECRET) {
  const values: Partial<Env> = {
    AUTH_ENABLED: enabled,
    AUTH_USER: 'operador',
    AUTH_PASSWORD: 'senha-forte',
    AUTH_SECRET: secret,
  };
  const config = {
    get: (k: keyof Env) => values[k],
  } as unknown as ConfigService<Env, true>;
  return new AuthService(config);
}

describe('AuthService', () => {
  afterEach(() => jest.useRealTimers());

  it('login com as credenciais certas devolve um token válido', () => {
    const auth = service();
    const { token, user } = auth.login('operador', 'senha-forte');
    expect(user).toEqual({ username: 'operador' });
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(auth.validateToken(token)).toEqual({ username: 'operador' });
  });

  it.each([
    ['operador', 'errada'],
    ['outro', 'senha-forte'],
    ['', ''],
  ])('login recusa %s / %s', (u, p) => {
    expect(() => service().login(u, p)).toThrow(UnauthorizedException);
  });

  it('o token expira em 24 h', () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-08T12:00:00Z') });
    const auth = service();
    const { token } = auth.login('operador', 'senha-forte');
    jest.setSystemTime(Date.parse('2026-10-09T11:59:00Z'));
    expect(auth.validateToken(token)).not.toBeNull();
    jest.setSystemTime(Date.parse('2026-10-09T12:00:01Z'));
    expect(auth.validateToken(token)).toBeNull();
  });

  it('recusa token adulterado, assinado com outro segredo ou malformado', () => {
    const auth = service();
    const { token } = auth.login('operador', 'senha-forte');
    const [payload, sig] = token.split('.');
    // Trocar o usuário no payload invalida a assinatura.
    const forged = Buffer.from(JSON.stringify({ user: 'admin', exp: Date.now() + 1e9 })).toString(
      'base64url',
    );
    expect(auth.validateToken(`${forged}.${sig}`)).toBeNull();
    expect(auth.validateToken(`${payload}.${sig.slice(0, -2)}xx`)).toBeNull();
    expect(service(true, 'o'.repeat(40)).validateToken(token)).toBeNull();
    expect(auth.validateToken('sem-ponto')).toBeNull();
    expect(auth.validateToken(undefined)).toBeNull();
  });

  it('com a autenticação desligada, qualquer requisição é anônima', () => {
    expect(service(false).validateToken(undefined)).toEqual(ANONYMOUS);
  });

  it('extrai o token do cabeçalho Bearer ou do ?token=', () => {
    expect(AuthService.extractToken('Bearer abc', undefined)).toBe('abc');
    expect(AuthService.extractToken(undefined, 'xyz')).toBe('xyz');
    expect(AuthService.extractToken('Basic abc', 'xyz')).toBe('xyz');
    expect(AuthService.extractToken(undefined, ['a'])).toBeUndefined();
  });
});

describe('AuthGuard', () => {
  function context(req: object, isPublic = false) {
    const reflector = { getAllAndOverride: () => isPublic } as unknown as Reflector;
    const ctx = {
      getType: () => 'http',
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { reflector, ctx };
  }

  it('com a autenticação ligada, exige token válido (cabeçalho ou query)', () => {
    const auth = service();
    const { token } = auth.login('operador', 'senha-forte');

    const ok = { headers: { authorization: `Bearer ${token}` } } as { user?: unknown };
    const a = context(ok);
    expect(new AuthGuard(auth, a.reflector).canActivate(a.ctx)).toBe(true);
    expect(ok.user).toEqual({ username: 'operador' });

    const viaQuery = context({ headers: {}, query: { token } });
    expect(new AuthGuard(auth, viaQuery.reflector).canActivate(viaQuery.ctx)).toBe(true);

    const none = context({ headers: {} });
    expect(() => new AuthGuard(auth, none.reflector).canActivate(none.ctx)).toThrow(
      UnauthorizedException,
    );
  });

  it('rotas @Public passam sem token', () => {
    const { reflector, ctx } = context({ headers: {} }, true);
    expect(new AuthGuard(service(), reflector).canActivate(ctx)).toBe(true);
  });

  it('com a autenticação desligada, tudo passa como anônimo', () => {
    const req = { headers: {} } as { user?: unknown };
    const { reflector, ctx } = context(req);
    expect(new AuthGuard(service(false), reflector).canActivate(ctx)).toBe(true);
    expect(req.user).toEqual(ANONYMOUS);
  });
});

describe('AuthController', () => {
  it('limita as tentativas de login por IP (429)', () => {
    const controller = new AuthController(service());
    for (let i = 0; i < MAX_LOGIN_ATTEMPTS; i++) {
      expect(() => controller.login({ username: 'x', password: 'y' }, '10.0.0.1')).toThrow(
        UnauthorizedException,
      );
    }
    expect(() =>
      controller.login({ username: 'operador', password: 'senha-forte' }, '10.0.0.1'),
    ).toThrow(HttpException);
    // Outro IP não é afetado.
    expect(
      controller.login({ username: 'operador', password: 'senha-forte' }, '10.0.0.2').token,
    ).toBeTruthy();
  });

  it('libera de novo depois da janela de 1 minuto', () => {
    jest.useFakeTimers({ now: 0 });
    const controller = new AuthController(service());
    for (let i = 0; i <= MAX_LOGIN_ATTEMPTS; i++) {
      try {
        controller.login({ username: 'x', password: 'y' }, 'ip');
      } catch {
        /* esperado */
      }
    }
    jest.setSystemTime(61_000);
    expect(
      controller.login({ username: 'operador', password: 'senha-forte' }, 'ip').token,
    ).toBeTruthy();
    jest.useRealTimers();
  });

  it('status informa se a autenticação está ligada', () => {
    expect(new AuthController(service(true)).status()).toEqual({ enabled: true });
    expect(new AuthController(service(false)).status()).toEqual({ enabled: false });
  });
});
