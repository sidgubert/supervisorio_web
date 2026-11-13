import { initAccount } from './account.js';
import { refreshAlarmHistory, initAlarmHistory } from './alarms-history.js';
import {
  apiFetch,
  authStatus,
  can,
  clearSession,
  getUser,
  requireAuth,
  setRole,
  withToken,
} from './auth.js';
import { initConfig } from './config.js';
import {
  handleAlarm,
  handleSample,
  initDashboard,
  setTagConfig,
  tagsInAlarm,
} from './dashboard.js';
import { initMetrics, stopMetricsRefresh } from './metrics.js';
import { goTo } from './navigation.js';
import { initSynoptic, setSynopticAlarms, updateSynoptic } from './synoptic.js';
import { ROLE_LABEL } from './util.js';

const connDot = document.getElementById('conn-dot');
const connLabel = document.getElementById('conn-label');
let currentView = 'dashboard';
let authEnabled = false;
let me = null;

function setConnection(on, label) {
  connDot.classList.toggle('conn-dot--on', on);
  connDot.classList.toggle('conn-dot--off', !on);
  connLabel.textContent = label;
}

function showView(name) {
  currentView = name;
  document.querySelectorAll('.view').forEach((el) => {
    el.hidden = el.id !== `view-${name}`;
    el.classList.toggle('view--active', el.id === `view-${name}`);
  });
  document.querySelectorAll('.nav__link').forEach((a) => {
    a.classList.toggle('nav__link--active', a.dataset.view === name);
  });
  if (name === 'alarms') void refreshAlarmHistory();
  if (name === 'config') void initConfig();
  if (name === 'account') void initAccount(me);
  if (name === 'synoptic') void initSynoptic(tagsInAlarm());
  if (name === 'metrics') initMetrics();
  else stopMetricsRefresh();
}

/** Telas que dependem do perfil ou do login; as demais são de todos. */
function allowed(name) {
  if (name === 'config') return can('engineer');
  if (name === 'account') return authEnabled;
  return true;
}

function route() {
  const name = location.hash.replace('#', '') || 'dashboard';
  showView(document.getElementById(`view-${name}`) && allowed(name) ? name : 'dashboard');
}

/** Esconde o que o perfil não pode usar (a API recusaria com 403). */
function applyPermissions() {
  document.querySelector('.nav__link[data-view="config"]').hidden = !can('engineer');
  document.querySelector('.nav__link[data-view="account"]').hidden = !authEnabled;
  document.getElementById('synoptic-edit').hidden = !can('engineer');
}

/**
 * Tempo real por SSE (/api/dashboard/stream). O navegador reconecta sozinho;
 * se a conexão cair por token expirado, a consulta a /api/auth/me leva ao login.
 */
function connectStream() {
  const es = new EventSource(withToken('/api/dashboard/stream'));
  es.onopen = () => setConnection(true, 'Tempo real conectado');
  es.onerror = () => {
    setConnection(false, 'Reconectando…');
    void apiFetch('/api/auth/me').catch(() => undefined);
  };
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'sample') {
      handleSample(msg);
      updateSynoptic(msg);
    } else if (msg.type === 'alarm') {
      handleAlarm(msg.alarm);
      setSynopticAlarms(tagsInAlarm());
      if (currentView === 'alarms') void refreshAlarmHistory();
    }
  };
}

async function bootstrap() {
  const enabled = await requireAuth();
  authEnabled = enabled;
  // O perfil vem da API, não do navegador: vale o que estiver cadastrado agora.
  me = await apiFetch('/api/auth/me')
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  setRole(me?.role);
  applyPermissions();
  if (enabled) {
    document.getElementById('user-label').textContent = me?.username ?? getUser() ?? '';
    const roleLabel = document.getElementById('role-label');
    roleLabel.textContent = ROLE_LABEL[me?.role] ?? '';
    roleLabel.hidden = !roleLabel.textContent;
    const logout = document.getElementById('logout-btn');
    logout.hidden = false;
    logout.onclick = () => {
      clearSession();
      goTo('/login.html');
    };
  }

  document.querySelectorAll('.nav__link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = a.dataset.view;
    });
  });
  window.addEventListener('hashchange', route);

  // Configuração salva: atualiza unidades/descrições e o sinótico.
  window.addEventListener('talos:tags-changed', async () => {
    const res = await apiFetch('/api/dashboard/alarms');
    if (res.ok) setTagConfig((await res.json()).tags);
    if (currentView === 'synoptic') await initSynoptic(tagsInAlarm());
  });

  initAlarmHistory();
  await initDashboard();
  route();
  connectStream();
}

/** Concluída quando o dashboard está pronto (os testes esperam por ela). */
export const ready = authStatus().then(bootstrap);
