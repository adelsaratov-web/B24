(() => {
  'use strict';

  const CATEGORY_ID = 27;
  const DOCUMENT_TEMPLATE_ID = 329;
  const PORTAL = 'transgaz64.bitrix24.ru';
  const F = {
    objectAddress: 'UF_CRM_1716883559988',
    visitAddress: 'UF_CRM_1776025753966',
    technician: 'UF_CRM_1775823185',
    visitDate: 'UF_CRM_1775823358',
    legacyVisitDate: 'UF_CRM_1713745795472',
    resourcePlanner: 'UF_CRM_1774919236497',
    workType: 'UF_CRM_1775824643',
    nextTo: 'UF_CRM_1775944515',
    masterComment: 'UF_CRM_1775945003',
    technicianComment: 'UF_CRM_VDGO_TECHNICIAN_COMMENT',
    nextContact: 'UF_CRM_1775945348',
    contractNumber: 'UF_CRM_1775944140',
    contractDate: 'UF_CRM_1775944458',
    objectUrl: 'UF_CRM_DEAL_VDGO_OBJECT_URL',
    objectBinding: 'UF_CRM_DEAL_VDGO_OBJECT',
    paidLegacy: 'UF_CRM_6A0741478584C',
    remainingLegacy: 'UF_CRM_6A074147BC5EF',
    paymentStatus: 'UF_CRM_VDGO_PAYMENT_STATUS',
    paymentMethod: 'UF_CRM_VDGO_PAYMENT_METHOD',
    paymentAmount: 'UF_CRM_VDGO_PAYMENT_AMOUNT',
    paymentDate: 'UF_CRM_VDGO_PAYMENT_DATE',
    paymentReference: 'UF_CRM_VDGO_PAYMENT_REFERENCE',
    toCompleted: 'UF_CRM_1775946621'
  };

  const PAYMENT_STATUS = {
    '12337': 'Не оплачено',
    '12339': 'Частично оплачено',
    '12341': 'Оплачено',
    '12343': 'Возврат'
  };
  const PAYMENT_METHOD = {
    '12345': 'Наличные',
    '12347': 'Банковская карта',
    '12349': 'Перевод на расчётный счёт',
    '12351': 'Иное'
  };

  const QUICK_STAGES = {
    callback: ['C27:CALLBACK'],
    noanswer: ['C27:UC_JQUBJU', 'C27:NOANSWER'],
    planned: ['C27:PLANNED_TO'],
    agreed: ['C27:UC_40ONW8'],
    legal: ['C27:LEGAL'],
    manual: ['C27:MANUAL'],
    overdue: ['C27:NEW']
  };

  const S = {
    mode: 'demo',
    domain: PORTAL,
    deals: [],
    contacts: new Map(),
    users: new Map(),
    stages: new Map(),
    selectedId: null,
    history: [],
    quick: 'open',
    searchSeq: 0
  };

  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const nameOf = user => user ? [user.LAST_NAME, user.NAME, user.SECOND_NAME].filter(Boolean).join(' ') : '';
  const phoneOf = contact => contact?.PHONE?.[0]?.VALUE || '';
  const money = value => new Intl.NumberFormat('ru-RU', {style:'currency', currency:'RUB', maximumFractionDigits:2}).format(Number(String(value || 0).split('|')[0]) || 0);
  const dateTime = value => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('ru-RU', {dateStyle:'short', timeStyle:'short'}).format(date);
  };
  const plainAddress = value => {
    if (!value) return '';
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed.address || parsed.VALUE || parsed.value || value;
      } catch (_) { return value; }
    }
    return value.address || value.VALUE || value.value || String(value);
  };
  const addressOf = deal => plainAddress(deal[F.visitAddress]) || plainAddress(deal[F.objectAddress]) || '';
  const visitDateOf = deal => deal[F.visitDate] || deal[F.legacyVisitDate] || '';
  const technicianText = deal => S.users.get(String(deal[F.technician])) || (deal[F.resourcePlanner] && String(deal[F.resourcePlanner]).length ? 'Требуется синхронизация' : 'Не назначен');
  const phoneVariants = value => {
    const digits = String(value || '').replace(/\D/g, '');
    const out = new Set();
    if (!digits) return [];
    out.add(digits); out.add('+' + digits);
    if (digits.length === 10) { out.add('7' + digits); out.add('+7' + digits); out.add('8' + digits); }
    if (digits.length === 11 && digits[0] === '8') { const v = '7' + digits.slice(1); out.add(v); out.add('+' + v); }
    if (digits.length === 11 && digits[0] === '7') { out.add('+' + digits); out.add('8' + digits.slice(1)); }
    return [...out];
  };

  function api(method, params = {}) {
    return new Promise((resolve, reject) => {
      BX24.callMethod(method, params, result => {
        if (result.error()) reject(new Error(result.error_description ? result.error_description() : result.error()));
        else resolve(result.data());
      });
    });
  }

  function all(method, params = {}, max = 500) {
    return new Promise((resolve, reject) => {
      const output = [];
      const next = start => BX24.callMethod(method, {...params, start}, result => {
        if (result.error()) return reject(new Error(result.error_description ? result.error_description() : result.error()));
        output.push(...(result.data() || []));
        if (result.more && result.more() && output.length < max) next(result.next());
        else resolve(output.slice(0, max));
      });
      next(0);
    });
  }

  function allItems(method, params = {}, max = 500) {
    return new Promise((resolve, reject) => {
      const output = [];
      const next = start => BX24.callMethod(method, {...params, start}, result => {
        if (result.error()) return reject(new Error(result.error_description ? result.error_description() : result.error()));
        const data = result.data() || {};
        output.push(...(data.items || []));
        if (result.more && result.more() && output.length < max) next(result.next());
        else resolve(output.slice(0, max));
      });
      next(0);
    });
  }

  const DEAL_FIELDS = [
    'ID','TITLE','CATEGORY_ID','STAGE_ID','CONTACT_ID','ASSIGNED_BY_ID','DATE_CREATE','DATE_MODIFY',
    'OPPORTUNITY','CURRENCY_ID','COMMENTS', ...Object.values(F)
  ];

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    if (window.BX24?.init) {
      BX24.init(() => {
        S.mode = 'bitrix';
        S.domain = BX24.getDomain?.() || PORTAL;
        $('connectionBadge').textContent = 'Подключено к Bitrix24';
        $('connectionBadge').className = 'connection-badge is-online';
        load();
      });
    } else {
      demo();
    }
  });

  function bindEvents() {
    $('refreshBtn').addEventListener('click', load);
    $('searchInput').addEventListener('input', debounce(searchGlobal, 450));
    $('stageFilter').addEventListener('change', render);
    $('managerFilter').addEventListener('change', render);
    $('workTypeFilter').addEventListener('change', render);
    $('newDealBtn').addEventListener('click', () => open(`https://${S.domain}/crm/deal/details/0/?category_id=${CATEGORY_ID}`, '_blank'));
    $('clearFiltersBtn').addEventListener('click', clearFilters);

    document.querySelectorAll('[data-quick-filter]').forEach(button => {
      button.addEventListener('click', () => setQuick(button.dataset.quickFilter));
    });
    $('quickFilters').addEventListener('click', event => {
      const button = event.target.closest('[data-filter]');
      if (button) setQuick(button.dataset.filter);
    });

    $('dealRows').addEventListener('click', event => {
      const row = event.target.closest('[data-id]');
      if (row) selectDeal(row.dataset.id, true);
    });
    $('historyRows').addEventListener('click', event => {
      const item = event.target.closest('[data-history-id]');
      if (!item) return;
      const deal = S.history.find(entry => String(entry.ID) === item.dataset.historyId);
      if (deal) {
        if (!S.deals.some(entry => String(entry.ID) === String(deal.ID))) S.deals.unshift(deal);
        selectDeal(deal.ID, true);
      }
    });

    $('openDealBtn').addEventListener('click', () => {
      const deal = selectedDeal();
      if (deal) open(`https://${S.domain}/crm/deal/details/${deal.ID}/`, '_blank');
    });
    $('callBtn').addEventListener('click', () => {
      const deal = selectedDeal();
      const phone = phoneOf(S.contacts.get(String(deal?.CONTACT_ID)));
      if (phone) location.href = 'tel:' + phone.replace(/[^+\d]/g, '');
      else toast('Телефон не указан', 'error');
    });
    $('callbackBtn').addEventListener('click', () => quickStage('C27:CALLBACK'));
    $('noanswerBtn').addEventListener('click', () => quickStage('C27:UC_JQUBJU'));
    $('completeBtn').addEventListener('click', () => quickStage('C27:WON'));

    $('scheduleBtn').addEventListener('click', openSchedule);
    $('scheduleForm').addEventListener('submit', saveSchedule);
    document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => $('scheduleDialog').close()));

    $('paymentBtn').addEventListener('click', openPayment);
    $('paymentForm').addEventListener('submit', savePayment);
    document.querySelectorAll('.close-payment').forEach(button => button.addEventListener('click', () => $('paymentDialog').close()));

    $('printBtn').addEventListener('click', () => $('printDialog').showModal());
    $('printForm').addEventListener('submit', printPack);
    document.querySelectorAll('.close-print').forEach(button => button.addEventListener('click', () => $('printDialog').close()));
  }

  async function load() {
    if (S.mode !== 'bitrix') return demo();
    $('resultSummary').textContent = 'Загрузка данных…';
    try {
      const [stages, deals, users] = await Promise.all([
        all('crm.status.list', {filter:{ENTITY_ID:'DEAL_STAGE_' + CATEGORY_ID}}, 100),
        all('crm.deal.list', {
          order:{DATE_MODIFY:'DESC'},
          filter:{CATEGORY_ID, '!STAGE_ID':['C27:WON','C27:LOSE']},
          select:DEAL_FIELDS
        }, 250),
        all('user.get', {FILTER:{ACTIVE:'Y'}}, 500)
      ]);
      S.stages = new Map(stages.map(item => [item.STATUS_ID, item.NAME]));
      S.users = new Map(users.map(user => [String(user.ID), nameOf(user)]));
      S.deals = deals;
      await loadContacts(deals.map(deal => deal.CONTACT_ID));
      fillSelects();
      render();
    } catch (error) {
      toast('Ошибка загрузки: ' + error.message, 'error');
    }
  }

  async function loadContacts(ids) {
    const unique = [...new Set(ids.filter(Boolean).map(String))].filter(id => !S.contacts.has(id));
    for (const part of chunks(unique, 50)) {
      const contacts = await all('crm.contact.list', {filter:{'@ID':part}, select:['ID','NAME','LAST_NAME','SECOND_NAME','PHONE']}, 100);
      contacts.forEach(contact => S.contacts.set(String(contact.ID), contact));
    }
  }

  function fillSelects() {
    $('stageFilter').innerHTML = '<option value="">Все стадии</option>' + [...S.stages].map(([id, title]) => `<option value="${esc(id)}">${esc(title)}</option>`).join('');
    const userOptions = [...S.users].filter(([, title]) => title).sort((a,b) => a[1].localeCompare(b[1], 'ru'));
    $('managerFilter').innerHTML = '<option value="">Все ответственные</option>' + userOptions.map(([id, title]) => `<option value="${id}">${esc(title)}</option>`).join('');
    $('technicianSelect').innerHTML = '<option value="">Выберите сотрудника</option>' + userOptions.map(([id, title]) => `<option value="${id}">${esc(title)}</option>`).join('');
  }

  async function searchGlobal() {
    const query = $('searchInput').value.trim();
    if (S.mode !== 'bitrix' || query.length < 2) return render();
    const sequence = ++S.searchSeq;
    const contacts = new Map();
    const deals = new Map();
    $('resultSummary').textContent = 'Поиск по всей CRM…';

    try {
      const tokens = query.split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        for (const field of ['NAME','LAST_NAME','SECOND_NAME']) {
          const found = await all('crm.contact.list', {filter:{['%' + field]:token}, select:['ID','NAME','LAST_NAME','SECOND_NAME','PHONE']}, 100).catch(() => []);
          found.forEach(contact => contacts.set(String(contact.ID), contact));
        }
      }

      const variants = phoneVariants(query);
      if (variants.length && query.replace(/\D/g, '').length >= 5) {
        const duplicates = await api('crm.duplicate.findbycomm', {entity_type:'CONTACT', type:'PHONE', values:variants}).catch(() => ({}));
        for (const id of (duplicates.CONTACT || [])) {
          const contact = await api('crm.contact.get', {id}).catch(() => null);
          if (contact) contacts.set(String(contact.ID), contact);
        }
      }

      const objectIds = new Set();
      const objects = await allItems('crm.item.list', {
        entityTypeId:1104,
        filter:{'%title':query},
        select:['id','title','contactId','ufCrm53Address']
      }, 500).catch(() => []);
      if (/^\d+$/.test(query)) {
        const directObject = await api('crm.item.get', {entityTypeId:1104, id:Number(query)}).catch(() => null);
        if (directObject?.item) objects.push(directObject.item);
      }
      for (const object of objects) {
        objectIds.add(String(object.id));
        if (object.contactId) {
          const contact = await api('crm.contact.get', {id:object.contactId}).catch(() => null);
          if (contact) contacts.set(String(contact.ID), contact);
        }
      }
      if (objectIds.size) {
        for (const part of chunks([...objectIds], 50)) {
          const found = await all('crm.deal.list', {filter:{CATEGORY_ID, ['@' + F.objectBinding]:part}, select:DEAL_FIELDS}, 500).catch(() => []);
          found.forEach(deal => deals.set(String(deal.ID), deal));
        }
      }

      const dealFilters = [
        {CATEGORY_ID, '%TITLE':query},
        {CATEGORY_ID, ['%' + F.objectAddress]:query},
        {CATEGORY_ID, ['%' + F.visitAddress]:query},
        {CATEGORY_ID, ['%' + F.contractNumber]:query}
      ];
      for (const filter of dealFilters) {
        const found = await all('crm.deal.list', {filter, select:DEAL_FIELDS}, 200).catch(() => []);
        found.forEach(deal => deals.set(String(deal.ID), deal));
      }

      if (/^\d+$/.test(query)) {
        const deal = await api('crm.deal.get', {id:query}).catch(() => null);
        if (deal && Number(deal.CATEGORY_ID) === CATEGORY_ID) deals.set(String(deal.ID), deal);
      }

      await loadContacts([...deals.values()].map(deal => deal.CONTACT_ID));
      deals.forEach(deal => {
        const contact = S.contacts.get(String(deal.CONTACT_ID));
        if (contact) contacts.set(String(contact.ID), contact);
      });

      const from = new Date();
      from.setFullYear(from.getFullYear() - 1);
      for (const part of chunks([...contacts.keys()], 50)) {
        const found = await all('crm.deal.list', {
          order:{DATE_CREATE:'DESC'},
          filter:{CATEGORY_ID, '@CONTACT_ID':part, '>=DATE_CREATE':from.toISOString()},
          select:DEAL_FIELDS
        }, 500).catch(() => []);
        found.forEach(deal => deals.set(String(deal.ID), deal));
      }

      if (sequence !== S.searchSeq) return;
      contacts.forEach((contact, id) => S.contacts.set(id, contact));
      S.deals = [...deals.values()].sort((a,b) => new Date(b.DATE_CREATE) - new Date(a.DATE_CREATE));
      S.quick = 'open';
      render();
      $('resultSummary').textContent = `Найдено ${S.deals.length} сделок за 12 месяцев`;
    } catch (error) {
      toast('Ошибка поиска: ' + error.message, 'error');
    }
  }

  function matchesQuick(deal) {
    if (S.quick === 'open') return true;
    if (S.quick === 'today') return isToday(visitDateOf(deal));
    if (S.quick === 'emergency') return String(deal[F.workType]) === '10241';
    const stages = QUICK_STAGES[S.quick];
    return stages ? stages.includes(deal.STAGE_ID) : true;
  }

  function render() {
    const query = $('searchInput').value.trim().toLowerCase();
    const stage = $('stageFilter').value;
    const manager = $('managerFilter').value;
    const workType = $('workTypeFilter').value;

    const visible = S.deals.filter(deal => {
      const contact = S.contacts.get(String(deal.CONTACT_ID));
      const haystack = [deal.ID, deal.TITLE, nameOf(contact), phoneOf(contact), addressOf(deal), deal[F.contractNumber]].join(' ').toLowerCase();
      return matchesQuick(deal)
        && (!query || haystack.includes(query))
        && (!stage || deal.STAGE_ID === stage)
        && (!manager || String(deal.ASSIGNED_BY_ID) === manager)
        && (!workType || String(deal[F.workType]) === workType);
    });

    $('countOpen').textContent = S.deals.length;
    updateKpis();
    updateActiveQuick();
    $('resultSummary').textContent = `Показано ${visible.length} из ${S.deals.length}`;
    $('dealRows').innerHTML = visible.map(deal => {
      const contact = S.contacts.get(String(deal.CONTACT_ID));
      const payment = paymentInfo(deal);
      return `<tr data-id="${deal.ID}" class="${String(deal.ID) === S.selectedId ? 'is-selected' : ''}">
        <td>${deal.ID}</td>
        <td><b>${esc(nameOf(contact) || deal.TITLE)}</b><div class="cell-sub">${esc(deal.TITLE || '')}</div></td>
        <td>${esc(phoneOf(contact) || '—')}</td>
        <td>${esc(addressOf(deal) || '—')}</td>
        <td>${esc(S.stages.get(deal.STAGE_ID) || deal.STAGE_ID)}</td>
        <td>${esc(technicianText(deal))}</td>
        <td>${dateTime(visitDateOf(deal))}</td>
        <td>${money(deal.OPPORTUNITY)}</td>
        <td><span class="payment-pill ${payment.css}">${esc(payment.text)}</span></td>
      </tr>`;
    }).join('');
    $('emptyState').classList.toggle('is-hidden', visible.length > 0);

    if (visible.length && !visible.some(deal => String(deal.ID) === S.selectedId)) selectDeal(visible[0].ID, false);
    if (!visible.length) clearDetail();
  }

  function updateKpis() {
    $('kpiToday').textContent = S.deals.filter(deal => isToday(visitDateOf(deal))).length;
    $('kpiOverdue').textContent = S.deals.filter(deal => deal.STAGE_ID === 'C27:NEW').length;
    $('kpiNoanswer').textContent = S.deals.filter(deal => QUICK_STAGES.noanswer.includes(deal.STAGE_ID)).length;
    $('kpiAgreed').textContent = S.deals.filter(deal => deal.STAGE_ID === 'C27:UC_40ONW8').length;
    $('kpiEmergency').textContent = S.deals.filter(deal => String(deal[F.workType]) === '10241').length;
  }

  function updateActiveQuick() {
    document.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('is-active', button.dataset.filter === S.quick));
    document.querySelectorAll('[data-quick-filter]').forEach(button => button.classList.toggle('is-active', button.dataset.quickFilter === S.quick));
  }

  function setQuick(filter) {
    S.quick = filter || 'open';
    render();
  }

  function clearFilters() {
    $('searchInput').value = '';
    $('stageFilter').value = '';
    $('managerFilter').value = '';
    $('workTypeFilter').value = '';
    S.quick = 'open';
    load();
  }

  async function selectDeal(id, rerender) {
    S.selectedId = String(id);
    if (rerender) render();
    const deal = selectedDeal();
    if (!deal) return clearDetail();
    const contact = S.contacts.get(String(deal.CONTACT_ID));
    const payment = paymentInfo(deal);

    $('detailEmpty').classList.add('is-hidden');
    $('detailContent').classList.remove('is-hidden');
    $('detailClient').textContent = nameOf(contact) || deal.TITLE || '—';
    $('detailPhone').textContent = phoneOf(contact) || '—';
    $('detailAddress').textContent = addressOf(deal) || '—';
    $('detailVisit').textContent = dateTime(visitDateOf(deal));
    $('detailStage').textContent = S.stages.get(deal.STAGE_ID) || deal.STAGE_ID;
    $('detailManager').textContent = S.users.get(String(deal.ASSIGNED_BY_ID)) || '—';
    $('detailTechnician').textContent = technicianText(deal);
    $('detailAmount').textContent = money(deal.OPPORTUNITY);
    $('detailPaymentStatus').textContent = payment.text;
    $('detailPaymentMethod').textContent = PAYMENT_METHOD[String(deal[F.paymentMethod])] || 'Не указан';
    $('detailTechComment').textContent = deal[F.technicianComment] || deal.COMMENTS || '—';
    $('detailMasterComment').textContent = deal[F.masterComment] || '—';
    $('detailNextTo').textContent = dateTime(deal[F.nextTo]);

    $('contactLink').href = deal.CONTACT_ID ? `https://${S.domain}/crm/contact/details/${deal.CONTACT_ID}/` : '#';
    const objectUrl = deal[F.objectUrl] || objectUrlFromBinding(deal[F.objectBinding]);
    $('objectLink').href = objectUrl || '#';
    $('objectLink').classList.toggle('is-disabled', !objectUrl);

    await loadHistory(deal);
  }

  function clearDetail() {
    S.selectedId = null;
    $('detailEmpty').classList.remove('is-hidden');
    $('detailContent').classList.add('is-hidden');
  }

  async function loadHistory(currentDeal) {
    if (S.mode !== 'bitrix' || !currentDeal) return;
    const from = new Date();
    from.setFullYear(from.getFullYear() - 1);
    const found = new Map();
    if (currentDeal.CONTACT_ID) {
      const byContact = await all('crm.deal.list', {
        order:{DATE_CREATE:'DESC'},
        filter:{CATEGORY_ID, CONTACT_ID:currentDeal.CONTACT_ID, '>=DATE_CREATE':from.toISOString()},
        select:DEAL_FIELDS
      }, 500).catch(() => []);
      byContact.forEach(deal => found.set(String(deal.ID), deal));
    }
    const objectId = String(currentDeal[F.objectBinding] || '').match(/\d+/)?.[0];
    if (objectId) {
      const byObject = await all('crm.deal.list', {
        order:{DATE_CREATE:'DESC'},
        filter:{CATEGORY_ID, [F.objectBinding]:objectId, '>=DATE_CREATE':from.toISOString()},
        select:DEAL_FIELDS
      }, 500).catch(() => []);
      byObject.forEach(deal => found.set(String(deal.ID), deal));
    }
    S.history = [...found.values()].sort((a,b) => new Date(b.DATE_CREATE) - new Date(a.DATE_CREATE));
    $('historySummary').textContent = `${S.history.length} сделок за 12 месяцев`;
    $('historyRows').innerHTML = S.history.map(deal => `<button class="history-item" data-history-id="${deal.ID}"><span>#${deal.ID} · ${dateTime(deal.DATE_CREATE)}</span><span>${esc(S.stages.get(deal.STAGE_ID) || deal.STAGE_ID)}</span><b>${money(deal.OPPORTUNITY)}</b></button>`).join('') || '<div class="muted">Нет сделок за 12 месяцев</div>';
  }

  function openSchedule() {
    const deal = selectedDeal();
    if (!deal) return;
    $('technicianSelect').value = deal[F.technician] || '';
    $('visitDateTime').value = toLocalInput(visitDateOf(deal) || new Date(Date.now() + 3600000));
    $('visitAddressInput').value = addressOf(deal);
    $('visitComment').value = deal[F.technicianComment] || deal.COMMENTS || '';
    $('scheduleDialog').showModal();
  }

  async function saveSchedule(event) {
    event.preventDefault();
    const deal = selectedDeal();
    if (!deal) return;
    const fields = {
      STAGE_ID: 'C27:UC_40ONW8',
      [F.technician]: $('technicianSelect').value,
      [F.visitDate]: new Date($('visitDateTime').value).toISOString(),
      [F.visitAddress]: $('visitAddressInput').value,
      [F.technicianComment]: $('visitComment').value
    };
    try {
      await updateDeal(deal.ID, fields);
      $('scheduleDialog').close();
      toast('Выезд назначен. Адрес и комментарий для слесаря сохранены.', 'success');
    } catch (error) {
      toast('Не удалось назначить выезд: ' + error.message, 'error');
    }
  }

  function openPayment() {
    const deal = selectedDeal();
    if (!deal) return;
    $('paymentStatusSelect').value = deal[F.paymentStatus] || '12337';
    $('paymentMethodSelect').value = deal[F.paymentMethod] || '';
    $('paymentAmountInput').value = Number(String(deal[F.paymentAmount] || 0).split('|')[0]) || '';
    $('paymentDateInput').value = deal[F.paymentDate] ? String(deal[F.paymentDate]).slice(0,10) : '';
    $('paymentReferenceInput').value = deal[F.paymentReference] || '';
    $('paymentDialog').showModal();
  }

  async function savePayment(event) {
    event.preventDefault();
    const deal = selectedDeal();
    if (!deal) return;
    const amount = $('paymentAmountInput').value;
    const fields = {
      [F.paymentStatus]: $('paymentStatusSelect').value,
      [F.paymentMethod]: $('paymentMethodSelect').value || null,
      [F.paymentAmount]: amount ? `${amount}|RUB` : null,
      [F.paymentDate]: $('paymentDateInput').value || null,
      [F.paymentReference]: $('paymentReferenceInput').value || null
    };
    try {
      await updateDeal(deal.ID, fields);
      $('paymentDialog').close();
      toast('Сведения об оплате сохранены', 'success');
    } catch (error) {
      toast('Не удалось сохранить оплату: ' + error.message, 'error');
    }
  }

  function paymentInfo(deal) {
    const explicit = String(deal[F.paymentStatus] || '');
    if (PAYMENT_STATUS[explicit]) {
      const css = explicit === '12341' ? 'is-paid' : explicit === '12339' ? 'is-partial' : explicit === '12337' ? 'is-unpaid' : 'is-unknown';
      return {text: PAYMENT_STATUS[explicit], css};
    }
    const total = Number(String(deal.OPPORTUNITY || 0).split('|')[0]) || 0;
    const paid = Number(String(deal[F.paymentAmount] || deal[F.paidLegacy] || 0).split('|')[0]) || 0;
    const remaining = Number(String(deal[F.remainingLegacy] || 0).split('|')[0]) || 0;
    if (paid > 0 && ((total && paid >= total) || remaining === 0)) return {text:'Оплачено', css:'is-paid'};
    if (paid > 0) return {text:'Частично оплачено', css:'is-partial'};
    return {text:'Нет данных', css:'is-unknown'};
  }

  async function updateDeal(id, fields) {
    if (S.mode === 'bitrix') await api('crm.deal.update', {id, fields});
    const deal = selectedDeal();
    if (deal) Object.assign(deal, fields);
    const historyDeal = S.history.find(item => String(item.ID) === String(id));
    if (historyDeal) Object.assign(historyDeal, fields);
    render();
    selectDeal(id, false);
  }

  function quickStage(stage) {
    const deal = selectedDeal();
    if (!deal) return;
    updateDeal(deal.ID, {STAGE_ID:stage}).then(() => toast('Стадия обновлена', 'success')).catch(error => toast(error.message, 'error'));
  }

  async function printPack(event) {
    event.preventDefault();
    const deal = selectedDeal();
    if (!deal) return;
    $('printDialog').close();
    if (S.mode !== 'bitrix') {
      toast('Штатный комплект формируется только внутри Bitrix24', 'error');
      return;
    }

    const preview = open('', '_blank');
    if (preview) {
      preview.document.write('<meta charset="utf-8"><title>Формирование комплекта</title><body style="font:16px Arial;padding:30px">Формируем штатный комплект документов Bitrix24…</body>');
      preview.document.close();
    }

    try {
      const value = `DEAL_${deal.ID}`;
      const listResult = await api('documentgenerator.document.list', {filter:{value}, order:{id:'DESC'}}).catch(() => ({documents:[]}));
      const documents = Array.isArray(listResult?.documents) ? listResult.documents : [];
      const latest = documents
        .filter(document => String(document.templateId) === String(DOCUMENT_TEMPLATE_ID))
        .sort((a,b) => Number(b.id) - Number(a.id))[0];
      const force = Boolean($('forceRegenerateCheck')?.checked);
      const dealModified = new Date(deal.DATE_MODIFY || deal.DATE_CREATE || 0).getTime();
      const documentModified = latest ? new Date(latest.updateTime || latest.createTime || 0).getTime() : 0;

      let document = latest;
      if (!document || force || documentModified < dealModified) {
        const values = await buildDocumentValues(deal);
        const created = await api('documentgenerator.document.add', {
          templateId: DOCUMENT_TEMPLATE_ID,
          provider: 'bitrix\\documentgenerator\\dataprovider\\rest',
          value,
          values
        });
        document = created?.document;
      }
      if (!document?.id) throw new Error('Bitrix24 не вернул ID сформированного документа');

      const pdfUrl = `https://${S.domain}/bitrix/services/main/ajax.php?action=documentgenerator.api.document.getpdf&SITE_ID=s1&id=${document.id}`;
      if (preview) preview.location.href = pdfUrl;
      else open(pdfUrl, '_blank');
      toast(`Комплект ${document.number || document.id} открыт из Bitrix24`, 'success');
    } catch (error) {
      if (preview && !preview.closed) preview.close();
      const message = String(error.message || error);
      if (/scope|access|permission|доступ/i.test(message)) {
        toast('Для печати добавьте приложению право «Генератор документов (documentgenerator)»', 'error');
      } else {
        toast('Не удалось сформировать комплект: ' + message, 'error');
      }
    }
  }

  async function buildDocumentValues(deal) {
    const contact = S.contacts.get(String(deal.CONTACT_ID)) || (deal.CONTACT_ID ? await api('crm.contact.get', {id:deal.CONTACT_ID}).catch(() => null) : null);
    const objectId = objectIdOf(deal);
    const objectResult = objectId ? await api('crm.item.get', {entityTypeId:1104, id:Number(objectId)}).catch(() => null) : null;
    const object = objectResult?.item || {};
    const equipment = equipmentFromObject(object);
    const contractDateRaw = object.ufCrm53ContractDate || deal[F.contractDate] || '';
    const amount = Number(String(deal.OPPORTUNITY || 0).split('|')[0]) || 0;
    const clientName = nameOf(contact) || deal.TITLE || '________________';
    const address = addressOf(deal) || object.ufCrm53Address || object.title || '________________';
    const technician = S.users.get(String(deal[F.technician])) || '________________';
    const completed = String(deal[F.toCompleted]) === '10359' || deal.STAGE_ID === 'C27:WON';

    return {
      CONTRACT_NUMBER: deal[F.contractNumber] || object.ufCrm53ContractNum || '________________',
      CONTRACT_DATE: formatDateOnly(contractDateRaw) || '________________',
      CLIENT_NAME: clientName,
      CLIENT_ADDRESS: address,
      CLIENT_PHONE: phoneOf(contact) || object.ufCrm53Phone || '________________',
      OBJECT_ADDRESS: address,
      SERVICE_PRICE: amount.toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2}),
      SERVICE_PRICE_WORDS: rublesInWords(amount),
      VAT_NOTE: 'НДС не облагается в связи с применением упрощённой системы налогообложения',
      EQUIPMENT_NUMBERS: equipment.map((_, index) => String(index + 1)).join('\n'),
      EQUIPMENT_TYPES: equipment.join('\n'),
      EQUIPMENT_BRAND_MODELS: equipment.map(() => '—').join('\n'),
      EQUIPMENT_QTYS: equipment.map(() => '1').join('\n'),
      EQUIPMENT_YEARS: equipment.map(() => '—').join('\n'),
      EQUIPMENT_SUMMARY: equipment.join('; '),
      SERVICE_PERIOD_START: formatDateOnly(contractDateRaw) || '________________',
      SERVICE_PERIOD_END: formatDateOnly(addYears(contractDateRaw, 1)) || '________________',
      MASTER_NAME: technician,
      VISIT_DATE: formatDateOnly(visitDateOf(deal)) || '________________',
      WORK_RESULT: completed ? 'ТО выполнено' : '________________',
      REPAIR_REQUIRED: '________________',
      MASTER_COMMENT: deal[F.masterComment] || deal[F.technicianComment] || '________________'
    };
  }

  function objectIdOf(deal) {
    const sources = [deal[F.objectBinding], deal[F.objectUrl]];
    for (const source of sources) {
      const text = Array.isArray(source) ? String(source[0] || '') : String(source || '');
      const match = text.match(/(\d+)/);
      if (match) return match[1];
    }
    return String(deal.TITLE || '').match(/объект\s*#?(\d+)/i)?.[1] || '';
  }

  function equipmentFromObject(object) {
    const mapping = [
      ['ufCrm53HasStove', 'Газовая плита'],
      ['ufCrm53HasBoiler', 'Газовый котёл'],
      ['ufCrm53HasWaterHeater', 'Газовая колонка'],
      ['ufCrm53HasInhousePipe', 'Внутридомовой газопровод'],
      ['ufCrm53HasOutdoorPipe', 'Наружный газопровод'],
      ['ufCrm53HasMeter', 'Счётчик газа'],
      ['ufCrm53HasGasAlarm', 'Сигнализатор загазованности'],
      ['ufCrm53HasChimney', 'Дымоход'],
      ['ufCrm53HasVent', 'Вентиляционный канал'],
      ['ufCrm53HasOtherEquip', 'Иное газовое оборудование']
    ];
    const items = mapping.filter(([field]) => String(object[field] || '').toUpperCase() === 'Y').map(([, title]) => title);
    return items.length ? items : ['Состав оборудования не заполнен в объекте ВДГО'];
  }

  function formatDateOnly(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('ru-RU', {day:'2-digit', month:'2-digit', year:'numeric'}).format(date);
  }

  function addYears(value, years) {
    if (!value) return null;
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    date.setFullYear(date.getFullYear() + years);
    return date;
  }

  function rublesInWords(value) {
    const amount = Math.round((Number(value) || 0) * 100);
    const rubles = Math.floor(amount / 100);
    const kopeks = amount % 100;
    return `${integerToWordsRu(rubles)} ${pluralRu(rubles, ['рубль','рубля','рублей'])} ${String(kopeks).padStart(2, '0')} ${pluralRu(kopeks, ['копейка','копейки','копеек'])}`;
  }

  function integerToWordsRu(value) {
    let number = Math.max(0, Math.floor(Number(value) || 0));
    if (number === 0) return 'ноль';
    const groups = [
      [1000000000, ['миллиард','миллиарда','миллиардов'], false],
      [1000000, ['миллион','миллиона','миллионов'], false],
      [1000, ['тысяча','тысячи','тысяч'], true],
      [1, null, false]
    ];
    const result = [];
    for (const [size, forms, feminine] of groups) {
      const part = Math.floor(number / size);
      if (!part) continue;
      result.push(...tripletWords(part, feminine));
      if (forms) result.push(pluralRu(part, forms));
      number %= size;
    }
    return result.join(' ');
  }

  function tripletWords(number, feminine) {
    const hundreds = ['', 'сто','двести','триста','четыреста','пятьсот','шестьсот','семьсот','восемьсот','девятьсот'];
    const tens = ['', '', 'двадцать','тридцать','сорок','пятьдесят','шестьдесят','семьдесят','восемьдесят','девяносто'];
    const teens = ['десять','одиннадцать','двенадцать','тринадцать','четырнадцать','пятнадцать','шестнадцать','семнадцать','восемнадцать','девятнадцать'];
    const units = feminine ? ['', 'одна','две','три','четыре','пять','шесть','семь','восемь','девять'] : ['', 'один','два','три','четыре','пять','шесть','семь','восемь','девять'];
    const result = [];
    const h = Math.floor(number / 100) % 10;
    const t = Math.floor(number / 10) % 10;
    const u = number % 10;
    if (h) result.push(hundreds[h]);
    if (t === 1) result.push(teens[u]);
    else {
      if (t) result.push(tens[t]);
      if (u) result.push(units[u]);
    }
    return result;
  }

  function pluralRu(number, forms) {
    const n = Math.abs(Number(number)) % 100;
    const n1 = n % 10;
    if (n > 10 && n < 20) return forms[2];
    if (n1 === 1) return forms[0];
    if (n1 >= 2 && n1 <= 4) return forms[1];
    return forms[2];
  }

  function selectedDeal() {
    return S.deals.find(deal => String(deal.ID) === S.selectedId) || S.history.find(deal => String(deal.ID) === S.selectedId);
  }

  function objectUrlFromBinding(value) {
    if (!value) return '';
    const text = Array.isArray(value) ? String(value[0] || '') : String(value);
    const match = text.match(/(\d+)/);
    return match ? `https://${S.domain}/crm/type/1104/details/${match[1]}/` : '';
  }

  function isToday(value) {
    if (!value) return false;
    const date = new Date(value);
    const today = new Date();
    return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  }

  function toLocalInput(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0,16);
  }

  function toast(text, kind) {
    const element = $('toast');
    element.textContent = text;
    element.className = 'toast' + (kind ? ' is-' + kind : '');
    setTimeout(() => element.classList.add('is-hidden'), 4000);
  }

  function debounce(fn, wait) {
    let timer;
    return () => { clearTimeout(timer); timer = setTimeout(fn, wait); };
  }

  function chunks(array, size) {
    const output = [];
    for (let i = 0; i < array.length; i += size) output.push(array.slice(i, i + size));
    return output;
  }

  function demo() {
    S.mode = 'demo';
    $('connectionBadge').textContent = 'Демо: откройте внутри Bitrix24 для живых данных';
    $('connectionBadge').className = 'connection-badge is-demo';
    S.stages = new Map([['C27:NEW','Просрочено ТО'],['C27:UC_40ONW8','Выезд согласован']]);
    S.users = new Map([['31','Петров Алексей Андреевич'],['29','Иванов Дмитрий Александрович']]);
    S.contacts.set('1',{ID:'1',NAME:'Ольга',LAST_NAME:'Свиридова',PHONE:[{VALUE:'+7 927 624-55-32'}]});
    S.deals = [{ID:29623,TITLE:'ВДГО: объект #13101',STAGE_ID:'C27:NEW',CONTACT_ID:'1',ASSIGNED_BY_ID:'33',[F.visitAddress]:'посёлок Пробуждение, переулок Школьный, 1А',[F.visitDate]:new Date(Date.now()+86400000).toISOString(),[F.technician]:'31',[F.technicianComment]:'Позвонить за 30 минут до приезда',OPPORTUNITY:2125}];
    fillSelects();
    render();
  }
})();