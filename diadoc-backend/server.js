import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const DIADOC_API = 'https://diadoc-api.kontur.ru';
const IDENTITY = 'https://identity.kontur.ru';
const PTG_INN = '6449064635';
const PTG_KPP = '644901001';
const PTG_BOX_ID = process.env.DIADOC_BOX_ID || 'b6c02154-477b-455d-a587-50d085c7a032';
const FROM_DATE = process.env.DIADOC_FROM_DATE || '01.01.2023';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://adelsaratov-web.github.io';
const CALLBACK_URL = process.env.DIADOC_REDIRECT_URI || '';
const STATE_SECRET = process.env.STATE_SECRET || '';
const DIADOC_SCOPE = 'openid profile email offline_access Diadoc.PublicAPI';
const secretClient = new SecretManagerServiceClient();
let tokenCache = null;

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: FRONTEND_ORIGIN, methods: ['GET','POST'], allowedHeaders: ['Content-Type','X-Bitrix-Domain','X-Bitrix-Auth'] }));
app.use(express.json({ limit: '1mb' }));

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

async function readSecret(name) {
  const direct = String(process.env[name] || '').trim();
  if (direct) return direct;
  const project = String(process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '').trim();
  if (!project) return '';
  try {
    const [version] = await secretClient.accessSecretVersion({ name: `projects/${project}/secrets/${name}/versions/latest` });
    return version.payload?.data?.toString('utf8').trim() || '';
  } catch (_) {
    return '';
  }
}

async function writeRefreshToken(value) {
  const project = String(process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '').trim();
  const secretName = String(process.env.DIADOC_REFRESH_SECRET || 'DIADOC_REFRESH_TOKEN').trim();
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT is required to persist refresh_token securely');
  const parent = `projects/${project}/secrets/${secretName}`;
  await secretClient.addSecretVersion({ parent, payload: { data: Buffer.from(value, 'utf8') } });
}

async function getClientCredentials() {
  const clientId = await readSecret('DIADOC_CLIENT_ID');
  const clientSecret = await readSecret('DIADOC_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('DIADOC_CLIENT_ID / DIADOC_CLIENT_SECRET are not configured');
  return { clientId, clientSecret };
}

function nowSeconds() { return Math.floor(Date.now() / 1000); }

async function exchangeToken(params) {
  const response = await fetch(`${IDENTITY}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Kontur token endpoint ${response.status}: ${body.error_description || body.error || 'unknown error'}`);
  return body;
}

async function refreshAccessToken() {
  const { clientId, clientSecret } = await getClientCredentials();
  const refreshToken = await readSecret('DIADOC_REFRESH_TOKEN');
  if (!refreshToken) throw new Error('DIADOC_REFRESH_TOKEN is not configured; authorize once via /auth/start');
  const token = await exchangeToken({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });
  tokenCache = {
    accessToken: token.access_token,
    expiresAt: nowSeconds() + Number(token.expires_in || 3600) - 120
  };
  if (token.refresh_token && token.refresh_token !== refreshToken) await writeRefreshToken(token.refresh_token);
  return tokenCache.accessToken;
}

async function getAccessToken() {
  if (tokenCache?.accessToken && tokenCache.expiresAt > nowSeconds()) return tokenCache.accessToken;
  const fixed = await readSecret('DIADOC_ACCESS_TOKEN');
  if (fixed) return fixed;
  return refreshAccessToken();
}

async function diadoc(path, options = {}) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${DIADOC_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: options.accept || 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(new Error(`Diadoc ${response.status}: ${text.slice(0,500)}`), { status: response.status });
  }
  return response;
}

async function verifyBitrix(req, res, next) {
  try {
    const domain = String(req.get('X-Bitrix-Domain') || '').trim().toLowerCase();
    const auth = String(req.get('X-Bitrix-Auth') || '').trim();
    if (!domain.endsWith('.bitrix24.ru') || !auth) return res.status(401).json({ error: 'Bitrix session required' });
    const profileUrl = `https://${domain}/rest/profile.json?auth=${encodeURIComponent(auth)}`;
    const check = await fetch(profileUrl, { headers: { Accept: 'application/json' } });
    const payload = await check.json().catch(() => ({}));
    if (!check.ok || payload.error || !payload.result?.ID) return res.status(401).json({ error: 'Invalid Bitrix session' });
    req.bitrix = { domain, user: payload.result };
    next();
  } catch (error) {
    res.status(401).json({ error: 'Bitrix verification failed' });
  }
}

function signedState(payload) {
  const secret = required('STATE_SECRET');
  return jwt.sign(payload, secret, { expiresIn: '10m', issuer: 'ptg-b24-diadoc' });
}

function verifyState(value) {
  return jwt.verify(value, required('STATE_SECRET'), { issuer: 'ptg-b24-diadoc' });
}

app.get('/healthz', (_, res) => res.json({ ok: true, service: 'ptg-diadoc-readonly', boxId: PTG_BOX_ID, from: FROM_DATE }));

app.get('/auth/start', async (req, res) => {
  try {
    const { clientId } = await getClientCredentials();
    const redirectUri = CALLBACK_URL || required('DIADOC_REDIRECT_URI');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const state = signedState({ nonce, returnTo: String(req.query.returnTo || `${FRONTEND_ORIGIN}/B24/diadoc.html`) });
    const url = new URL(`${IDENTITY}/connect/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('scope', DIADOC_SCOPE);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  } catch (error) {
    res.status(500).send(`Diadoc authorization configuration error: ${error.message}`);
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    const state = verifyState(String(req.query.state || ''));
    const code = String(req.query.code || '');
    if (!code) throw new Error('Authorization code is missing');
    const { clientId, clientSecret } = await getClientCredentials();
    const redirectUri = CALLBACK_URL || required('DIADOC_REDIRECT_URI');
    const token = await exchangeToken({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri
    });
    if (!token.refresh_token) throw new Error('Kontur did not return refresh_token; check offline_access scope');
    await writeRefreshToken(token.refresh_token);
    tokenCache = { accessToken: token.access_token, expiresAt: nowSeconds() + Number(token.expires_in || 3600) - 120 };
    const returnTo = /^https:\/\//i.test(state.returnTo || '') ? state.returnTo : `${FRONTEND_ORIGIN}/B24/diadoc.html`;
    const out = new URL(returnTo);
    out.searchParams.set('diadoc', 'connected');
    res.redirect(out.toString());
  } catch (error) {
    res.status(400).send(`Diadoc authorization failed: ${error.message}`);
  }
});

app.get('/api/diadoc/status', verifyBitrix, async (_req, res) => {
  try {
    const response = await diadoc('/GetMyOrganizations?autoRegister=false');
    const payload = await response.json();
    const organizations = Array.isArray(payload.Organizations) ? payload.Organizations : [];
    const ptg = organizations.find(org => String(org.Inn || '') === PTG_INN && (!PTG_KPP || String(org.Kpp || '') === PTG_KPP)) || organizations.find(org => String(org.BoxId || '').toLowerCase().includes(PTG_BOX_ID.toLowerCase()));
    res.json({ connected: Boolean(ptg), ptg: ptg ? { name: ptg.FullName || ptg.ShortName, inn: ptg.Inn, kpp: ptg.Kpp, boxId: PTG_BOX_ID } : null });
  } catch (error) {
    const needsAuth = /REFRESH_TOKEN|401|Unauthorized/i.test(error.message);
    res.status(needsAuth ? 401 : 502).json({ connected: false, needsAuth, error: error.message });
  }
});

function toDiadocDate(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : fallback;
}

async function getDocumentsPage(category, fromDate, toDate, afterIndexKey = '') {
  const body = {
    DocumentCategory: category,
    FromDocumentDate: fromDate,
    ToDocumentDate: toDate,
    SortDirection: 'Descending',
    Count: '100'
  };
  if (afterIndexKey) body.AfterIndexKey = afterIndexKey;
  const response = await diadoc(`/V4/GetDocuments?boxId=${encodeURIComponent(PTG_BOX_ID)}`, { method: 'POST', body: JSON.stringify(body) });
  return response.json();
}

function compactDocument(doc, category) {
  const id = doc.MessageId && doc.EntityId ? `${doc.MessageId}:${doc.EntityId}` : '';
  const counteragent = category === 'Incoming' ? (doc.SenderName || doc.CounteragentName || '') : (doc.RecipientName || doc.CounteragentName || '');
  return {
    id,
    messageId: doc.MessageId,
    entityId: doc.EntityId,
    indexKey: doc.IndexKey,
    category,
    type: doc.DocumentTypeNamedId || doc.DocumentType || '',
    title: doc.FileName || doc.DocumentTypeNamedId || doc.DocumentType || 'Документ',
    number: doc.DocumentNumber || '',
    date: doc.DocumentDate || '',
    counteragent,
    counteragentInn: category === 'Incoming' ? (doc.SenderInn || '') : (doc.RecipientInn || ''),
    counteragentKpp: category === 'Incoming' ? (doc.SenderKpp || '') : (doc.RecipientKpp || ''),
    total: doc.Total ? Number(doc.Total) / 100 : null,
    currency: doc.Currency || 'RUB',
    status: doc.DocflowStatus?.PrimaryStatus?.StatusText || doc.DocflowStatus?.PrimaryStatus?.StatusType || doc.Status || '',
    isRead: doc.IsRead,
    creationTimestamp: doc.CreationTimestamp || '',
    raw: doc
  };
}

app.get('/api/diadoc/documents', verifyBitrix, async (req, res) => {
  try {
    const today = new Date();
    const defaultTo = `${String(today.getDate()).padStart(2,'0')}.${String(today.getMonth()+1).padStart(2,'0')}.${today.getFullYear()}`;
    const fromDate = toDiadocDate(req.query.from, FROM_DATE);
    const toDate = toDiadocDate(req.query.to, defaultTo);
    const direction = String(req.query.direction || 'all').toLowerCase();
    const categories = direction === 'incoming' ? ['Incoming'] : direction === 'outgoing' ? ['Outgoing'] : ['Incoming','Outgoing'];
    const maxPages = Math.min(Math.max(Number(req.query.maxPages || 20), 1), 100);
    const docs = [];
    let truncated = false;
    for (const category of categories) {
      let after = '';
      for (let page = 0; page < maxPages; page++) {
        const payload = await getDocumentsPage(category, fromDate, toDate, after);
        const pageDocs = Array.isArray(payload.Documents) ? payload.Documents : [];
        docs.push(...pageDocs.map(doc => compactDocument(doc, category)));
        if (pageDocs.length < 100) break;
        const next = pageDocs.at(-1)?.IndexKey;
        if (!next || next === after) break;
        after = next;
        if (page === maxPages - 1) truncated = true;
      }
    }
    const q = String(req.query.q || '').trim().toLowerCase();
    const filtered = q ? docs.filter(doc => [doc.title, doc.number, doc.date, doc.counteragent, doc.counteragentInn, doc.type, doc.status].join(' ').toLowerCase().includes(q)) : docs;
    res.json({ from: fromDate, to: toDate, count: filtered.length, truncated, documents: filtered });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});

app.get('/api/diadoc/document/:messageId/:entityId/content', verifyBitrix, async (req, res) => {
  try {
    const messageId = encodeURIComponent(req.params.messageId);
    const entityId = encodeURIComponent(req.params.entityId);
    const response = await diadoc(`/V4/GetEntityContent?boxId=${encodeURIComponent(PTG_BOX_ID)}&messageId=${messageId}&entityId=${entityId}`, { accept: '*/*' });
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const disposition = response.headers.get('content-disposition');
    res.setHeader('Content-Type', contentType);
    if (disposition) res.setHeader('Content-Disposition', disposition);
    const data = Buffer.from(await response.arrayBuffer());
    res.send(data);
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`ptg-diadoc-readonly listening on ${PORT}`));
