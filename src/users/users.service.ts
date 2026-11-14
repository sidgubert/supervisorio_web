import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { Env } from '../config/env.validation';
import { Role } from './role';
import { User } from './user.entity';

/** Usuário como a API o devolve: nunca com o hash. */
export type PublicUser = Pick<User, 'id' | 'username' | 'role' | 'active' | 'createdAt'>;

export const MIN_PASSWORD_LENGTH = 8;

const stampOf = (passwordHash: string) =>
  createHash('sha256').update(passwordHash).digest('base64url').slice(0, 16);

function toPublic(u: User): PublicUser {
  return { id: u.id, username: u.username, role: u.role, active: u.active, createdAt: u.createdAt };
}

/**
 * Cadastro de usuários (senha só como hash argon2id).
 *
 * Mantém em memória o perfil dos usuários ativos (`roles`), recarregado a cada
 * alteração. Assim a validação do token, que roda em toda requisição e no
 * WebSocket, não consulta o banco e ainda assim reflete na hora um usuário
 * desativado ou com o perfil trocado. É correto para uma instância da API; com
 * várias, a recarga precisaria ser compartilhada (ex: LISTEN/NOTIFY).
 */
@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);
  private roles = new Map<string, Role>();
  private stamps = new Map<string, string>();
  /** Hash de uma senha qualquer: gasta o mesmo tempo ao recusar um usuário inexistente. */
  private dummyHash?: Promise<string>;
  /** Fim da última alteração de usuário (ver serial). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onModuleInit() {
    await this.seedAdmin();
    await this.reload();
  }

  /** Perfil do usuário ativo, ou null se não existe ou está inativo. */
  activeRole(username: string): Role | null {
    return this.roles.get(username) ?? null;
  }

  /**
   * Marca da senha atual do usuário ativo (resumo do hash), gravada no token:
   * trocar a senha, ou remover e recriar o usuário, muda a marca e invalida os
   * tokens antigos. Null se não existe ou está inativo.
   */
  tokenStamp(username: string): string | null {
    return this.stamps.get(username) ?? null;
  }

  /** Confere usuário e senha; devolve o usuário ou lança 401. */
  async verify(username: string, password: string): Promise<PublicUser> {
    const user = await this.repo.findOneBy({ username });
    if (!user) {
      await argon2.verify(await this.getDummyHash(), password).catch(() => false);
      throw new UnauthorizedException('Usuário ou senha inválidos.');
    }
    const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!ok || !user.active) throw new UnauthorizedException('Usuário ou senha inválidos.');
    return toPublic(user);
  }

  async list(): Promise<PublicUser[]> {
    const users = await this.repo.find({ order: { username: 'ASC' } });
    return users.map(toPublic);
  }

  async create(input: { username: string; password: string; role: Role }): Promise<PublicUser> {
    if (await this.repo.existsBy({ username: input.username })) {
      throw new ConflictException(`Usuário "${input.username}" já existe.`);
    }
    const user = await this.repo.save(
      this.repo.create({
        username: input.username,
        role: input.role,
        active: true,
        passwordHash: await argon2.hash(input.password),
      }),
    );
    await this.reload();
    return toPublic(user);
  }

  update(
    id: string,
    changes: { role?: Role; active?: boolean; password?: string },
  ): Promise<PublicUser> {
    return this.serial(() => this.doUpdate(id, changes));
  }

  remove(id: string): Promise<void> {
    return this.serial(() => this.doRemove(id));
  }

  /**
   * Uma alteração por vez: conferir se resta outro admin e gravar são dois
   * passos, e dois pedidos simultâneos (cada um rebaixando um admin
   * diferente) passariam ambos na conferência, deixando o sistema sem admin.
   * Como o cache de perfis, vale para uma instância da API.
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doUpdate(
    id: string,
    changes: { role?: Role; active?: boolean; password?: string },
  ): Promise<PublicUser> {
    const user = await this.find(id);
    const role = changes.role ?? user.role;
    const active = changes.active ?? user.active;
    if (user.role === 'admin' && user.active && (role !== 'admin' || !active)) {
      await this.assertAnotherAdmin(user);
    }
    user.role = role;
    user.active = active;
    if (changes.password !== undefined) user.passwordHash = await argon2.hash(changes.password);
    await this.repo.save(user);
    await this.reload();
    return toPublic(user);
  }

  private async doRemove(id: string): Promise<void> {
    const user = await this.find(id);
    if (user.role === 'admin' && user.active) await this.assertAnotherAdmin(user);
    await this.repo.remove(user);
    await this.reload();
  }

  /**
   * Troca da própria senha, exigindo a atual. Senha atual errada é 403, não
   * 401: o usuário está autenticado, e um 401 faria o painel encerrar a sessão.
   */
  async changePassword(username: string, current: string, next: string): Promise<void> {
    const user = await this.repo.findOneBy({ username });
    const ok = user ? await argon2.verify(user.passwordHash, current).catch(() => false) : false;
    if (!user || !ok) throw new ForbiddenException('Senha atual incorreta.');
    user.passwordHash = await argon2.hash(next);
    await this.repo.save(user);
    await this.reload();
  }

  private async find(id: string): Promise<User> {
    const user = await this.repo.findOneBy({ id });
    if (!user) throw new NotFoundException(`Usuário ${id} não encontrado.`);
    return user;
  }

  /** Nunca deixa o sistema sem um admin ativo. */
  private async assertAnotherAdmin(user: User) {
    const others = await this.repo
      .createQueryBuilder('u')
      .where('u.role = :role AND u.active = true AND u.id <> :id', { role: 'admin', id: user.id })
      .getCount();
    if (others === 0) {
      throw new BadRequestException('Deve restar ao menos um administrador ativo.');
    }
  }

  private async reload() {
    const active = await this.repo.findBy({ active: true });
    this.roles = new Map(active.map((u) => [u.username, u.role]));
    this.stamps = new Map(active.map((u) => [u.username, stampOf(u.passwordHash)]));
  }

  private getDummyHash(): Promise<string> {
    return (this.dummyHash ??= argon2.hash('senha-inexistente'));
  }

  /**
   * Com a tabela vazia e a autenticação ligada, cria o primeiro admin a partir
   * de AUTH_USER/AUTH_PASSWORD (a API não sobe se a senha for curta). Depois
   * disso, essas variáveis não valem mais como credencial e podem sair do
   * .env: os usuários passam a viver só no banco.
   */
  private async seedAdmin() {
    if (!this.config.get('AUTH_ENABLED', { infer: true })) return;
    if ((await this.repo.count()) > 0) return;
    const username = this.config.get('AUTH_USER', { infer: true });
    const password = this.config.get('AUTH_PASSWORD', { infer: true });
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `Não há usuários: defina AUTH_PASSWORD com ao menos ${MIN_PASSWORD_LENGTH} ` +
          'caracteres para criar o primeiro administrador.',
      );
    }
    await this.repo.save(
      this.repo.create({
        username,
        role: 'admin',
        active: true,
        passwordHash: await argon2.hash(password),
      }),
    );
    this.logger.log(
      `Primeiro administrador "${username}" criado a partir de AUTH_USER/AUTH_PASSWORD.`,
    );
  }
}
