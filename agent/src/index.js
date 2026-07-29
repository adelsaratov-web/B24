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
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      max_output_tokens: 800
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`OpenAI: ${data?.error?.message || response.status}`);
  return data.output_text || data.output?.flatMap(x => x.content || []).map(x => x.text || '').join('\n') || '';
}

function classifyRisk(text) {
  const value = text.toLowerCase();
  const emergency = ['запах газа','утечк','авари','взрыв','пожар','травм','несчастн','полици','прокуратур','суд','персональн', 'хищен'];
  const approval = ['зарплат','увол','принять на работу','договор','тариф','оплатить','расход','перевести деньги','признать долг','удалить'];
  if (emergency.some(word => value.includes(word))) return 'D';
  if (approval.some(word => value.includes(word))) return 'C';
  return 'A';
}

function promptFor(message, risk) {
  return `Ты — автоматизированный помощник руководителя группы компаний transgaz64 в Bitrix24.\n\nПравила:\n- отвечай по-русски, деловым и понятным языком;\n- не изображай личное участие директора;\n- не утверждай финансовые, кадровые, юридические или аварийные решения;\n- для ошибки интерфейса запроси номер сделки/объекта, действие, ожидаемый и фактический результат, скриншот;\n- не сообщай, что задача выполнена, если это не подтверждено данными;\n- ответ не длиннее 1200 знаков.\n\nУровень риска: ${risk}.\nСообщение сотрудника: ${message}`;
}

async function wasProcessed(dialogId, messageId) {
  const ref = firestore.collection('bitrix_agent_messages').doc(`${dialogId}_${messageId}`);
  const snap = await ref.get();
  return snap.exists;
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
  let processed = 0;

  for (const item of messages.slice().reverse()) {
    const id = item.id || item.ID;
    const authorId = String(item.author_id || item.AUTHOR_ID || '');
    const text = String(item.text || item.MESSAGE || '').trim();
    if (!id || !text || authorId === '1' || await wasProcessed(dialogId, id)) continue;

    const risk = classifyRisk(text);
    if (risk === 'C' || risk === 'D') {
      await escalate(dialogId, text, risk);
      await markProcessed(dialogId, id, { authorId, text, risk, action: 'escalated' });
      processed += 1;
      continue;
    }

    const answer = await openaiResponse(promptFor(text, risk));
    if (!answer.trim()) throw new Error('Model returned an empty answer');
    await bitrix('im.message.add', { DIALOG_ID: dialogId, MESSAGE: answer.trim() + BOT_SIGNATURE });
    await markProcessed(dialogId, id, { authorId, text, risk, action: 'answered', answer: answer.trim() });
    processed += 1;
  }
  return processed;
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
    res.json({ ok: true, processed: report });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Listening on ${PORT}`));
