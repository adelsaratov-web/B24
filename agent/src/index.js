import express from 'express';
import { Firestore } from '@google-cloud/firestore';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 8080);
const BITRIX_WEBHOOK_BASE = String(process.env.BITRIX_WEBHOOK_BASE || '').replace(/\/$/, '');
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '');
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-5-mini');
const AGENT_TOKEN = String(process.env.AGENT_TOKEN || '');
const ALLOWED_DIALOGS = new Set(String(process.env.ALLOWED_DIALOGS || 'chat9869').split(',').map(v => v.trim()).filter(Boolean));
const DIRECTOR_DIALOG_ID = String(process.env.DIRECTOR_DIALOG_ID || '1');
const BOT_SIGNATURE = '\n\n— Автоматизированный помощник Аделя Эдгаровича';
const firestore = new Firestore();

function requireConfig() {
  const missing = [];
  if (!BITRIX_WEBHOOK_BASE) missing.push('BITRIX_WEBHOOK_BASE');
  if (!OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!AGENT_TOKEN) missing.push('AGENT_TOKEN');
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

async function bitrix(method, params = {}) {
  const response = await fetch(`${BITRIX_WEBHOOK_BASE}/${method}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(`Bitrix ${method}: ${data.error_description || data.error || response.status}`);
  return data.result;
}

async function openaiResponse(input) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: OPENAI_MODEL, input, max_output_tokens: 800 })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`OpenAI: ${data?.error?.message || response.status}`);
  return data.output_text || data.output?.flatMap(x => x.content || []).map(x => x.text || '').join('\n') || '';
}

function classifyRisk(text) {
  const value = text.toLowerCase();
  const emergency = ['запах газа','утечк','авари','взрыв','пожар','травм','несчастн','полици','прокуратур','суд','персональн','хищен'];
  const approval = ['зарплат','увол','принять на работу','договор','тариф','оплатить','расход','перевести деньги','признать долг','удалить'];
  if (emergency.some(word => value.includes(word))) return 'D';
  if (approval.some(word => value.includes(word))) return 'C';
  return 'A';
}

function promptFor(message, risk) {
  return `Ты — автоматизированный помощник руководителя группы компаний transgaz64 в Bitrix24.\n\nПравила:\n- отвечай по-русски, деловым и понятным языком;\n- не изображай личное участие директора;\n- не утверждай финансовые, кадровые, юридические или аварийные решения;\n- для ошибки интерфейса запроси номер сделки/объекта, действие, ожидаемый и фактический результат, скриншот;\n- не сообщай, что задача выполнена, если это не подтверждено данными;\n- не повторяй уже заданные вопросы;\n- ответ не длиннее 900 знаков.\n\nУровень риска: ${risk}.\nСообщение сотрудника: ${message}`;
}

function cursorRef(dialogId) {
  return firestore.collection('bitrix_agent_cursors').doc(dialogId);
}

async function getCursor(dialogId) {
  const snap = await cursorRef(dialogId).get();
  return snap.exists ? Number(snap.data()?.lastMessageId || 0) : null;
}

async function setCursor(dialogId, messageId) {
  await cursorRef(dialogId).set({ lastMessageId: Number(messageId), updatedAt: new Date().toISOString() }, { merge: true });
}

async function markProcessed(dialogId, messageId, record) {
  await firestore.collection('bitrix_agent_messages').doc(`${dialogId}_${messageId}`).set({
    ...record,
    dialogId,
    messageId: String(messageId),
    processedAt: new Date().toISOString()
  });
}

async function escalate(dialogId, message, risk) {
  const body = `Требуется личное решение руководителя.\n\nИсточник: ${dialogId}\nУровень риска: ${risk}\nСообщение: ${message}\n\nАвтоматический ответ сотруднику не направлен.`;
  await bitrix('im.message.add', { DIALOG_ID: DIRECTOR_DIALOG_ID, MESSAGE: body + BOT_SIGNATURE });
}

async function processDialog(dialogId) {
  const result = await bitrix('im.dialog.messages.get', { DIALOG_ID: dialogId, LIMIT: 30 });
  const messages = Array.isArray(result?.messages) ? result.messages : Array.isArray(result) ? result : [];
  const normalized = messages
    .map(item => ({
      id: Number(item.id || item.ID || 0),
      authorId: String(item.author_id || item.AUTHOR_ID || ''),
      text: String(item.text || item.MESSAGE || '').trim()
    }))
    .filter(item => item.id > 0)
    .sort((a, b) => a.id - b.id);

  if (!normalized.length) return { processed: 0, state: 'empty' };

  const latestId = normalized.at(-1).id;
  const cursor = await getCursor(dialogId);

  if (cursor === null) {
    await setCursor(dialogId, latestId);
    return { processed: 0, state: 'initialized', cursor: latestId };
  }

  const candidate = normalized.find(item => item.id > cursor && item.authorId !== '1' && item.text);
  if (!candidate) {
    if (latestId > cursor) await setCursor(dialogId, latestId);
    return { processed: 0, state: 'no_new_employee_message', cursor: latestId };
  }

  const risk = classifyRisk(candidate.text);
  if (risk === 'C' || risk === 'D') {
    await escalate(dialogId, candidate.text, risk);
    await markProcessed(dialogId, candidate.id, { authorId: candidate.authorId, text: candidate.text, risk, action: 'escalated' });
  } else {
    const answer = await openaiResponse(promptFor(candidate.text, risk));
    if (!answer.trim()) throw new Error('Model returned an empty answer');
    await bitrix('im.message.add', { DIALOG_ID: dialogId, MESSAGE: answer.trim() + BOT_SIGNATURE });
    await markProcessed(dialogId, candidate.id, { authorId: candidate.authorId, text: candidate.text, risk, action: 'answered', answer: answer.trim() });
  }

  await setCursor(dialogId, candidate.id);
  return { processed: 1, state: risk === 'C' || risk === 'D' ? 'escalated' : 'answered', messageId: candidate.id };
}

function authorized(req) {
  const supplied = req.get('x-agent-token') || req.query.token || '';
  return AGENT_TOKEN && supplied === AGENT_TOKEN;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'transgaz64-bitrix-virtual-director' }));

app.post('/poll', async (req, res) => {
  try {
    requireConfig();
    if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const report = {};
    for (const dialogId of ALLOWED_DIALOGS) report[dialogId] = await processDialog(dialogId);
    res.json({ ok: true, report });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Listening on ${PORT}`));
