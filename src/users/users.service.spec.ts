import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Env } from '../config/env.validation';
import { User } from './user.entity';
import { UsersService } from './users.service';

/** Repositório em memória com a parte da API do TypeORM que o serviço usa. */
function fakeRepo() {
  const rows: User[] = [];
  let seq = 0;
  const repo = {
    rows,
    create: (p: Partial<User>) => ({ ...p }) as User,
    save: (u: User) => {
      if (!u.id) {
        u.id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
        u.createdAt = new Date();
        rows.push(u);
      }
      return Promise.resolve(u);
    },
    remove: (u: User) => Promise.resolve(void rows.splice(rows.indexOf(u), 1)),
    count: () => Promise.resolve(rows.length),
    find: () => Promise.resolve([...rows].sort((a, b) => a.username.localeCompare(b.username))),
    findOneBy: (w: Partial<User>) =>
      Promise.resolve(
        rows.find((r) => Object.entries(w).every(([k, v]) => r[k as keyof User] === v)) ?? null,
      ),
    findBy: (w: Partial<User>) =>
      Promise.resolve(
        rows.filter((r) => Object.entries(w).every(([k, v]) => r[k as keyof User] === v)),
      ),
    existsBy: (w: Partial<User>) => Promise.resolve(rows.some((r) => r.username === w.username)),
    createQueryBuilder: () => ({
      where: (_: string, p: { id: string }) => ({
        getCount: () =>
          Promise.resolve(
            rows.filter((r) => r.role === 'admin' && r.active && r.id !== p.id).length,
          ),
      }),
    }),
  };
  return repo;
}

function setup(auth = true) {
  const repo = fakeRepo();
  const values: Partial<Env> = {
    AUTH_ENABLED: auth,
    AUTH_USER: 'root',
    AUTH_PASSWORD: 'inicial-123',
  };
  const config = { get: (k: keyof Env) => values[k] } as unknown as ConfigService<Env, true>;
  const service = new UsersService(repo as unknown as Repository<User>, config);
  return { repo, service };
}

describe('UsersService', () => {
  it('cria o primeiro admin a partir de AUTH_USER/AUTH_PASSWORD, com hash argon2', async () => {
    const { repo, service } = setup();
    await service.onModuleInit();
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({ username: 'root', role: 'admin', active: true });
    expect(repo.rows[0].passwordHash).toMatch(/^\$argon2id\$/);
    expect(repo.rows[0].passwordHash).not.toContain('inicial-123');
    expect(service.activeRole('root')).toBe('admin');
  });

  it('não cria o admin com a autenticação desligada, nem com a tabela já preenchida', async () => {
    const off = setup(false);
    await off.service.onModuleInit();
    expect(off.repo.rows).toHaveLength(0);

    const { repo, service } = setup();
    await service.create({ username: 'maria', password: 'senha-da-maria', role: 'viewer' });
    await service.onModuleInit();
    expect(repo.rows.map((r) => r.username)).toEqual(['maria']);
  });

  it('verify aceita a senha certa e recusa errada, desconhecido e inativo', async () => {
    const { service } = setup();
    await service.onModuleInit();
    await expect(service.verify('root', 'inicial-123')).resolves.toMatchObject({ role: 'admin' });
    await expect(service.verify('root', 'errada')).rejects.toThrow(UnauthorizedException);
    await expect(service.verify('ninguem', 'inicial-123')).rejects.toThrow(UnauthorizedException);

    const u = await service.create({
      username: 'joao',
      password: 'senha-do-joao',
      role: 'operator',
    });
    await service.update(u.id, { active: false });
    await expect(service.verify('joao', 'senha-do-joao')).rejects.toThrow(UnauthorizedException);
    expect(service.activeRole('joao')).toBeNull();
  });

  it('create recusa nome repetido e a lista nunca expõe o hash', async () => {
    const { service } = setup();
    await service.onModuleInit();
    await expect(
      service.create({ username: 'root', password: 'outra-senha-1', role: 'viewer' }),
    ).rejects.toThrow(ConflictException);
    const users = await service.list();
    expect(users[0]).not.toHaveProperty('passwordHash');
  });

  it('update troca perfil e senha, e o perfil vale na hora', async () => {
    const { service } = setup();
    await service.onModuleInit();
    const u = await service.create({ username: 'ana', password: 'senha-da-ana-1', role: 'viewer' });
    await service.update(u.id, { role: 'engineer', password: 'nova-senha-ana' });
    expect(service.activeRole('ana')).toBe('engineer');
    await expect(service.verify('ana', 'senha-da-ana-1')).rejects.toThrow(UnauthorizedException);
    await expect(service.verify('ana', 'nova-senha-ana')).resolves.toMatchObject({
      role: 'engineer',
    });
  });

  it('nunca deixa o sistema sem um admin ativo', async () => {
    const { repo, service } = setup();
    await service.onModuleInit();
    const root = repo.rows[0];
    await expect(service.update(root.id, { role: 'viewer' })).rejects.toThrow(BadRequestException);
    await expect(service.update(root.id, { active: false })).rejects.toThrow(BadRequestException);
    await expect(service.remove(root.id)).rejects.toThrow(BadRequestException);

    // Com outro admin ativo, já pode.
    await service.create({ username: 'chefe', password: 'senha-do-chefe', role: 'admin' });
    await expect(service.update(root.id, { role: 'viewer' })).resolves.toMatchObject({
      role: 'viewer',
    });
  });

  it('changePassword exige a senha atual', async () => {
    const { service } = setup();
    await service.onModuleInit();
    await expect(service.changePassword('root', 'errada', 'nova-senha-1')).rejects.toThrow(
      ForbiddenException,
    );
    await service.changePassword('root', 'inicial-123', 'nova-senha-1');
    await expect(service.verify('root', 'nova-senha-1')).resolves.toBeDefined();
  });
});
