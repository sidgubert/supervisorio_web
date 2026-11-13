import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Usuários e perfis (viewer, operator, engineer, admin). A senha é guardada
 * só como hash argon2. O primeiro admin é criado na subida da API a partir de
 * AUTH_USER/AUTH_PASSWORD, quando a tabela está vazia.
 */
export class CreateUsers1791417600008 implements MigrationInterface {
  name = 'CreateUsers1791417600008';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username      TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL
          CONSTRAINT chk_users_role CHECK (role IN ('viewer', 'operator', 'engineer', 'admin')),
        active        BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_users_username UNIQUE (username)
      )
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS users`);
  }
}
