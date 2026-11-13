import { apiFetch, can } from './auth.js';
import { apiError, esc, fmtDateTime, ROLE_LABEL } from './util.js';

/**
 * Tela "Conta": troca da própria senha (qualquer perfil) e, para o
 * administrador, o cadastro de usuários (/api/users).
 */
const who = document.getElementById('account-who');
const passwordForm = document.getElementById('password-form');
const usersSection = document.getElementById('users-section');
const userForm = document.getElementById('user-form');
const usersMsg = document.getElementById('users-msg');
const usersBody = document.getElementById('users-body');

let me = null;

function say(el, text, kind = '') {
  el.className = `config-msg ${kind}`.trim();
  el.textContent = text;
}

function row(u) {
  const name = esc(u.username);
  // A própria conta não muda de perfil nem sai por aqui: evita o admin se trancar para fora.
  const self = u.username === me?.username;
  const lock = self ? 'disabled title="Peça a outro administrador"' : '';
  const roles = Object.entries(ROLE_LABEL)
    .map(([v, l]) => `<option value="${v}" ${u.role === v ? 'selected' : ''}>${esc(l)}</option>`)
    .join('');
  return `
    <tr data-id="${esc(u.id)}" data-username="${name}" class="${u.active ? '' : 'row--inactive'}">
      <td><code>${name}</code>${self ? ' <span class="muted">(você)</span>' : ''}</td>
      <td><select data-act="role" aria-label="Perfil de ${name}" ${lock}>${roles}</select></td>
      <td>${u.active ? 'Ativo' : 'Inativo'}</td>
      <td>${fmtDateTime(u.createdAt)}</td>
      <td>
        <div class="user-actions">
          <input type="password" aria-label="Nova senha de ${name}" placeholder="Nova senha"
            autocomplete="new-password" />
          <button type="button" class="btn btn--sm" data-act="password">Redefinir senha</button>
          <button type="button" class="btn btn--sm" data-act="active" ${lock}>${
            u.active ? 'Desativar' : 'Ativar'
          }</button>
          <button type="button" class="btn btn--sm" data-act="remove" ${lock}>Remover</button>
        </div>
      </td>
    </tr>`;
}

async function loadUsers() {
  const res = await apiFetch('/api/users');
  if (!res.ok) {
    say(usersMsg, await apiError(res), 'err');
    return;
  }
  usersBody.innerHTML = (await res.json()).map(row).join('');
}

/** Envia a alteração, recarrega a lista (também no erro, para desfazer o que a tela mostrava) e avisa. */
async function send(method, id, payload, done) {
  const res = await apiFetch(`/api/users${id ? `/${encodeURIComponent(id)}` : ''}`, {
    method,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const error = res.ok ? null : await apiError(res);
  await loadUsers();
  say(usersMsg, error ?? done, error ? 'err' : 'ok');
  return res.ok;
}

async function act(el) {
  const tr = el.closest('tr');
  const { id, username } = tr.dataset;
  switch (el.dataset.act) {
    case 'role':
      await send('PATCH', id, { role: el.value }, `Perfil de ${username} alterado.`);
      break;
    case 'active': {
      const active = el.textContent.trim() === 'Ativar';
      await send('PATCH', id, { active }, `${username} ${active ? 'ativado' : 'desativado'}.`);
      break;
    }
    case 'password': {
      const password = tr.querySelector('input[type="password"]').value;
      if (password.length < 8) {
        say(usersMsg, 'A nova senha deve ter ao menos 8 caracteres.', 'err');
        return;
      }
      await send('PATCH', id, { password }, `Senha de ${username} redefinida.`);
      break;
    }
    case 'remove':
      if (!window.confirm(`Remover o usuário "${username}"? Não é possível desfazer.`)) return;
      await send('DELETE', id, undefined, `${username} removido.`);
      break;
  }
}

usersBody.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) void act(btn);
});
usersBody.addEventListener('change', (e) => {
  if (e.target.matches('select[data-act]')) void act(e.target);
});

userForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(userForm).entries());
  const username = String(data.username).trim();
  const ok = await send(
    'POST',
    null,
    { username, password: data.password, role: data.role },
    `Usuário ${username} criado.`,
  );
  if (ok) userForm.reset();
});

passwordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = passwordForm.querySelector('.config-msg');
  const data = Object.fromEntries(new FormData(passwordForm).entries());
  say(msg, 'Salvando…');
  const res = await apiFetch('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify({ current: data.current, password: data.password }),
  });
  if (res.ok) {
    say(msg, 'Senha alterada.', 'ok');
    passwordForm.reset();
  } else {
    say(msg, await apiError(res), 'err');
  }
});

/** Abre a tela para o usuário autenticado ({ username, role }). */
export async function initAccount(user) {
  me = user;
  who.textContent = user ? `${user.username} · ${ROLE_LABEL[user.role] ?? user.role}` : '';
  const admin = Boolean(user) && can('admin');
  usersSection.hidden = !admin;
  if (admin) await loadUsers();
}
