import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Env } from '../config/env.validation';
import { Role } from '../users/role';
import { UsersService } from '../users/users.service';
import { AuthController, MAX_LOGIN_ATTEMPTS } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { ANONYMOUS, AuthService } from './auth.service';
import { RolesGuard } from './roles.guard';

const SECRET = 's'.repeat(40);

/** Usuários em memória no lugar do banco (senha em texto, só no teste). */
function fakeUsers(roles: Record<string, Role> = { operador: 'operator' }) {
  return {
    activeRole: (u: string) => roles[u] ?? null,
    verify: (u: string, p: string) => {
      if (!(u in roles) || p !== 'senha-forte') {
        return Promise.reject(new UnauthorizedException('Usuário ou senha inválidos.'));
      }
      return Promise.resolve({ username: u, role: roles[u] });
    },
    changePassword: jest.fn(),
  } as unknown as UsersService;
}

function service(enabled = true, secret = SECRET, users = fakeUsers()) {
  const values: Partial<Env> = {
    AUTH_ENABLED: enabled,
    AUTH_SECRET: secret,
  };
  const config = {
    get: (k: keyof Env) => values[k],
  } as unknown as ConfigService<Env, true>;
  return new AuthService(config, users);
}

describe('AuthService', () => {
  afterEach(() => jest.useRealTimers());

  it('login com as credenciais certas devolve um token válido, com o perfil', async () => {
    const auth = service();
    const { token, user } = await auth.login('operador', 'senha-forte');
    expect(user).toEqual({ username: 'operador', role: 'operator' });
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(auth.validateToken(token)).toEqual({ username: 'operador', role: 'operator' });
  });

  it.each([
    ['operador', 'errada'],
    ['outro', 'senha-forte'],
    ['', ''],
  ])('login recusa %s / %s', async (u, p) => {
    await expect(service().login(u, p)).rejects.toThrow(UnauthorizedException);
  });

  it('o token expira em 24 h', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-08T12:00:00Z') });
    const auth = service();
    const { token } = await auth.login('operador', 'senha-forte');
    jest.setSystemTime(Date.parse('2026-10-09T11:59:00Z'));
    expect(auth.validateToken(token)).not.toBeNull();
    jest.setSystemTime(Date.parse('2026-10-09T12:00:01Z'));
    expect(auth.validateToken(token)).toBeNull();
  });

  it('o perfil vale na hora: usuário desativado ou promovido reflete no mesmo token', async () => {
    const roles: Record<string, Role> = { operador: 'operator' };
    const auth = service(true, SECRET, fakeUsers(roles));
    const { token } = await auth.login('operador', 'senha-forte');
    roles.operador = 'engineer';
    expect(auth.validateToken(token)?.role).toBe('engineer');
    delete roles.operador;
    expect(auth.validateToken(token)).toBeNull();
  });

  it('recusa token adulterado, assinado com outro segredo ou malformado', async () => {
    const auth = service();
    const { token } = await auth.login('operador', 'senha-forte');
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

  it('com a autenticação ligada, exige token válido (cabeçalho ou query)', async () => {
    const auth = service();
    const { token } = await auth.login('operador', 'senha-forte');

    const ok = { headers: { authorization: `Bearer ${token}` } } as { user?: unknown };
    const a = context(ok);
    expect(new AuthGuard(auth, a.reflector).canActivate(a.ctx)).toBe(true);
    expect(ok.user).toEqual({ username: 'operador', role: 'operator' });

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

describe('RolesGuard', () => {
  function check(required: Role | undefined, user: { username: string; role: Role } | undefined) {
    const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
    const ctx = {
      getType: () => 'http',
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
    return new RolesGuard(reflector).canActivate(ctx);
  }
  const as = (role: Role) => ({ username: 'u', role });

  it('rota sem perfil exigido passa para qualquer autenticado', () => {
    expect(check(undefined, as('viewer'))).toBe(true);
  });

  it('o perfil maior herda o que o menor pode', () => {
    expect(check('operator', as('operator'))).toBe(true);
    expect(check('operator', as('engineer'))).toBe(true);
    expect(check('engineer', as('admin'))).toBe(true);
  });

  it('perfil insuficiente ou sem usuário leva a 403', () => {
    expect(() => check('operator', as('viewer'))).toThrow(ForbiddenException);
    expect(() => check('engineer', as('operator'))).toThrow(ForbiddenException);
    expect(() => check('admin', as('engineer'))).toThrow(ForbiddenException);
    expect(() => check('operator', undefined)).toThrow(ForbiddenException);
  });

  it('com a autenticação desligada (anônimo admin), tudo passa', () => {
    expect(check('admin', ANONYMOUS)).toBe(true);
  });
});

describe('AuthController', () => {
  const controller = (enabled = true) => {
    const users = fakeUsers();
    return new AuthController(service(enabled, SECRET, users), users);
  };

  it('limita as tentativas de login por IP (429)', async () => {
    const c = controller();
    for (let i = 0; i < MAX_LOGIN_ATTEMPTS; i++) {
      await expect(c.login({ username: 'x', password: 'y' }, '10.0.0.1')).rejects.toThrow(
        UnauthorizedException,
      );
    }
    await expect(
      c.login({ username: 'operador', password: 'senha-forte' }, '10.0.0.1'),
    ).rejects.toThrow(HttpException);
    // Outro IP não é afetado.
    expect(
      (await c.login({ username: 'operador', password: 'senha-forte' }, '10.0.0.2')).token,
    ).toBeTruthy();
  });

  it('libera de novo depois da janela de 1 minuto', async () => {
    jest.useFakeTimers({ now: 0 });
    const c = controller();
    for (let i = 0; i <= MAX_LOGIN_ATTEMPTS; i++) {
      await c.login({ username: 'x', password: 'y' }, 'ip').catch(() => undefined);
    }
    jest.setSystemTime(61_000);
    expect(
      (await c.login({ username: 'operador', password: 'senha-forte' }, 'ip')).token,
    ).toBeTruthy();
    jest.useRealTimers();
  });

  it('status informa se a autenticação está ligada', () => {
    expect(controller(true).status()).toEqual({ enabled: true });
    expect(controller(false).status()).toEqual({ enabled: false });
  });
});
