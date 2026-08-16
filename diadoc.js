(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const BACKEND = String(window.PTG_DIADOC_BACKEND || '').replace(/\/$/, '');
  const S = { domain:'', auth:'', connected:false, setup:null };

  document.addEventListener('DOMContentLoaded', () => {
    $('toInput').value = new Date().toISOString().slice(0,10);
    $('loadBtn').addEventListener('click', loadDocuments);
    $('connectBtn').addEventListener('click', connectDiadoc);
    $('saveCredentialsBtn').addEventListener('click', saveCredentials);
    $('rows').addEventListener('click', event => {
      const button = event.target.closest('[data-download]');
      if (button) downloadOriginal(button.dataset.messageId, button.dataset.entityId, button.dataset.filename);
    });

    if (!BACKEND) {
      $('configPanel').classList.remove('is-hidden');
      setStatus('Backend не настроен', 'err');
      return;
    }
    if (!window.BX24?.init) {
      setStatus('Откройте внутри Bitrix24', 'err');
      return;
    }

    BX24.init(async () => {
      S.domain = BX24.getDomain?.() || 'transgaz64.bitrix24.ru';
      const auth = BX24.getAuth?.() || {};
      S.auth = auth.access_token || auth.AUTH_ID || auth.auth_id || '';
      if (!S.auth) {
        setStatus('Нет Bitrix-сессии', 'err');
        return;
      }
      if (new URLSearchParams(location.search).get('diadoc') === 'connected') {
        history.replaceState(null, '', location.pathname);
      }
      await bootstrap();
    });
  });

  function headers(extra = {}) {
    return { 'X-Bitrix-Domain': S.domain, 'X-Bitrix-Auth': S.auth, ...extra };
  }

  async function request(path, options = {}) {
    const response = await fetch(`${BACKEND}${path}`, {
      ...options,
      headers: headers({ ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), {status:response.status, body});
    return body;
  }

  async function bootstrap() {
    setStatus('Проверка облачного контура…');
    $('setupPanel').classList.add('is-hidden');
    $('authPanel').classList.add('is-hidden');
    $('loadBtn').disabled = true;
    try {
      S.setup = await request('/api/setup/status');
      $('callbackInfo').textContent = S.setup.callbackUrl ? `Redirect URI: ${S.setup.callbackUrl}` : '';
      if (!S.setup.clientConfigured) {
        $('setupPanel').classList.remove('is-hidden');
        setStatus('Нужно настроить ключи', 'err');
        $('summary').textContent = 'Ожидается client_id и client_secret.';
        return;
      }
      if (!S.setup.authorized) {
        $('authPanel').classList.remove('is-hidden');
        setStatus('Нужна авторизация');
        $('summary').textContent = 'Ключи сохранены. Осталось подтвердить доступ к Диадоку.';
        return;
      }
      await checkDiadocStatus();
    } catch (error) {
      setStatus('Backend недоступен', 'err');
      $('summary').textContent = error.message;
    }
  }

  async function saveCredentials() {
    const clientId = $('clientIdInput').value.trim();
    const clientSecret = $('clientSecretInput').value.trim();
    if (!clientId || !clientSecret) {
      $('summary').textContent = 'Заполните client_id и client_secret.';
      return;
    }
    $('saveCredentialsBtn').disabled = true;
    try {
      const body = await request('/api/setup', { method:'POST', body:JSON.stringify({clientId,clientSecret}) });
      $('clientSecretInput').value = '';
      $('clientIdInput').value = '';
      $('callbackInfo').textContent = body.callbackUrl ? `Redirect URI: ${body.callbackUrl}` : '';
      await bootstrap();
    } catch (error) {
      $('summary').textContent = 'Не удалось сохранить ключи: ' + error.message;
    } finally {
      $('saveCredentialsBtn').disabled = false;
    }
  }

  async function connectDiadoc() {
    $('connectBtn').disabled = true;
    try {
      const body = await request('/api/auth-url');
      if (!body.url) throw new Error('Backend не вернул URL авторизации');
      location.href = body.url;
    } catch (error) {
      $('summary').textContent = 'Не удалось начать авторизацию: ' + error.message;
      $('connectBtn').disabled = false;
    }
  }

  async function checkDiadocStatus() {
    try {
      const body = await request('/api/diadoc/status');
      if (!body.connected) throw new Error('Сертификат/пользователь Диадока не имеет доступа к ящику ПТГ');
      S.connected = true;
      $('setupPanel').classList.add('is-hidden');
      $('authPanel').classList.add('is-hidden');
      $('loadBtn').disabled = false;
      setStatus('Диадок подключён', 'ok');
      await loadDocuments();
    } catch (error) {
      S.connected = false;
      $('authPanel').classList.remove('is-hidden');
      setStatus('Нужна авторизация', 'err');
      $('summary').textContent = error.message;
    }
  }

  async function loadDocuments() {
    if (!S.connected) return;
    $('loadBtn').disabled = true;
    $('summary').textContent = 'Читаем документы Диадока…';
    try {
      const params = new URLSearchParams({
        from:$('fromInput').value || '2023-01-01',
        to:$('toInput').value || new Date().toISOString().slice(0,10),
        direction:$('directionInput').value || 'all',
        q:$('queryInput').value.trim()
      });
      const body = await request(`/api/diadoc/documents?${params}`);
      renderDocuments(body.documents || []);
      $('summary').textContent = `Документов: ${body.count}. Период ${body.from} — ${body.to}.`;
    } catch (error) {
      $('summary').textContent = 'Ошибка: ' + error.message;
      renderDocuments([]);
    } finally {
      $('loadBtn').disabled = !S.connected;
    }
  }

  function renderDocuments(docs) {
    $('empty').classList.toggle('is-hidden', docs.length > 0);
    $('rows').innerHTML = docs.map(doc => {
      const direction = doc.category === 'Incoming' ? ['Вход.', 'in'] : ['Исход.', 'out'];
      const amount = doc.total == null ? '—' : new Intl.NumberFormat('ru-RU', {style:'currency',currency:doc.currency || 'RUB'}).format(doc.total);
      const filename = doc.filename || doc.title || `diadoc_${doc.entityId}`;
      return `<tr>
        <td><span class="dir ${direction[1]}">${direction[0]}</span></td>
        <td>${esc(doc.date || '—')}</td><td>${esc(doc.number || '—')}</td>
        <td>${esc(doc.counteragent || doc.counteragentBoxId || '—')}</td><td>${esc(doc.counteragentInn || '—')}</td>
        <td>${esc(doc.type || doc.title || '—')}</td><td>${esc(doc.status || '—')}</td><td>${esc(amount)}</td>
        <td><button class="btn btn-secondary" type="button" data-download="1" data-message-id="${esc(doc.messageId)}" data-entity-id="${esc(doc.entityId)}" data-filename="${esc(filename)}">Оригинал</button></td>
      </tr>`;
    }).join('');
  }

  async function downloadOriginal(messageId, entityId, filename) {
    try {
      const response = await fetch(`${BACKEND}/api/diadoc/document/${encodeURIComponent(messageId)}/${encodeURIComponent(entityId)}/content`, {headers:headers()});
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const blob=await response.blob();
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url; a.download=safeName(filename || `diadoc_${entityId}`); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url),30000);
    } catch (error) {
      alert('Не удалось скачать документ: ' + error.message);
    }
  }

  function setStatus(text,kind='') {
    $('statusBadge').textContent=text;
    $('statusBadge').className='badge' + (kind ? ' ' + kind : '');
  }
  function esc(value) { return String(value ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
  function safeName(value) { return String(value || 'document').replace(/[\\/:*?"<>|]+/g,'_').slice(0,180); }
})();
