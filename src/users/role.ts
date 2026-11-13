/**
 * Perfis, do menor para o maior privilégio:
 *
 * - viewer:   só acompanha (leitura);
 * - operator: viewer + reconhece alarmes;
 * - engineer: operator + cadastra/altera/remove tags;
 * - admin:    engineer + gerencia usuários.
 */
export const ROLES = ['viewer', 'operator', 'engineer', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Um perfil herda tudo que os de nível menor podem fazer. */
export function hasRole(role: Role, required: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(required);
}
