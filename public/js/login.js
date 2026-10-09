import { authStatus, setSession } from './auth.js';
import { goTo } from './navigation.js';
import { apiError } from './util.js';

const form = document.getElementById('login-form');
const err = document.getElementById('err');

/** Com a autenticação desligada não há o que fazer aqui: vai direto ao dashboard. */
async function initLogin() {
  const { enabled } = await authStatus();
  if (!enabled) {
    goTo('/');
    return;
  }
  form.addEventListener('submit', submit);
}

async function submit(e) {
  e.preventDefault();
  err.hidden = true;
  const body = {
    username: document.getElementById('user').value,
    password: document.getElementById('pass').value,
  };
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // 401: credenciais; 429: muitas tentativas (a mensagem diz quanto esperar).
      err.textContent = res.status === 401 ? 'Usuário ou senha inválidos.' : await apiError(res);
      err.hidden = false;
      return;
    }
    const data = await res.json();
    setSession(data.token, data.user.username);
    goTo('/');
  } catch {
    err.textContent = 'Sem conexão com o servidor.';
    err.hidden = false;
  }
}

/** Concluída quando a página está pronta (os testes esperam por ela). */
export const ready = initLogin();
