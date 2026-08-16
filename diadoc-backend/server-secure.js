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
const BITRIX_PORTAL = String(process.env.BITRIX_PORTAL || 'transgaz64.bitrix24.ru').toLowerCase();
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://adelsaratov-web.github.io';
const FRONTEND_RETURN_URL = `${FRONTEND_ORIGIN}/B24/diadoc.html`;
const CALLBACK_URL = process.env.DIADOC_REDIRECT_URI || '';
const DIADOC_SCOPE = 'openid profile email offline_access Diadoc.PublicAPI';
const secretClient = new SecretManagerServiceClient();
const organizationCache = new Map();
let tokenCache = null;

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: FRONTEND_ORIGIN,
  methods: ['GET'],
  allowedHeaders: ['X-Bitrix-Domain', 'X-Bitrix-Auth']
}));
app.use(express.json({ limit: '256kb' }));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

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
    const [version] = await secretClient.accessSecretVersion({
      name: `projects/${project}/secrets/${name}/versions/latest`
    });
    return version.payload?.data?.toString('utf8').trim() || '';
  } catch (_) {
    return '';
  }
}

async function writeRefreshToken(value) {
  const project = String(process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '').trim();
  const secretName = String(process.env.DIADOC_REFRESH_SECRET || 'DIADOC_REFRESH_TOKEN').trim();
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT is required to persist refresh_token');
  await secretClient.addSecretVersion({
    parent: `projects/${project}/secrets/${secretName}`,
    payload: { data: Buffer.from(value, 'utf8') }
  });
}

async function getClientCredentials() {
  const clientId = await readSecret('DIADOC_CLIENT_ID');
  const clientSecret = await readSecret('DIADOC_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('DIADOC_CLIENT_ID / DIADOC_CLIENT_SECRET are not configured');
  }
  return { clientId, clientSecret };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function exchangeToken(params) {
  const response = await fetch(`${IDENTITY}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Kontur token endpoint ${response.status}: ${body.error_description || body.error || 'unknown error'}`);
  }
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
  if (token.refresh_token && token.refresh_token !== refreshToken) {
    await writeRefreshToken(token.refresh_token);
  }
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
    throw Object.assign(new Error(`Diadoc ${response.status}: ${text.slice(0, 500)}`), { status: response.status });
  }
  return response;
}

async function verifyBitrix(req, res, next) {
  try {
    const domain = String(req.get('X-Bitrix-Domain') || '').trim().toLowerCase();
    const auth = String(req.get('X-Bitrix-Auth') || '').trim();
    if (domain !== BITRIX_PORTAL || !auth) {
      return res.status(401).json({ error: 'transgaz64 Bitrix24 session required' });
    }
    const profileUrl = `https://${BITRIX_PORTAL}/rest/profile.json?auth=${encodeURIComponent(auth)}`;
    const check = await fetch(profileUrl, { headers: { Accept: 'application/json' } });
    const payload = await check.json().catch(() => ({}));
    if (!check.ok || payload.error || !payload.result?.ID) {
      return res.status(401).json({ error: 'Invalid Bitrix24 session' });
    }
    req.bitrix = { domain: BITRIX_PORTAL, user: payload.result };
    next();
  } catch (_) {
    res.status(401).json({ error: 'Bitrix24 verification failed' });
  }
}

function signedState(payload) {
  return jwt.sign(payload, required('STATE_SECRET'), {
    expiresIn: '10m',
    issuer: 'ptg-b24-diadoc'
  });
}

function verifyState(value) {
  return jwt.verify(value, required('STATE_SECRET'), { issuer: 'ptg-b24-diadoc' });
}

function safeReturnTo(value) {
  try {
    const url = new URL(String(value || FRONTEND_RETURN_URL));
    if (url.origin !== FRONTEND_ORIGIN || url.pathname !== '/B24/diadoc.html') return FRONTEND_RETURN_URL;
    return FRONTEND_RETURN_URL;
  } catch (_) {
    return FRONTEND_RETURN_URL;
  }
}

function toDiadocDate(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : fallback;
}

function boxGuidFromId(value) {
  const raw = String(value || '').trim();
  const direct = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (direct) return direct[0].toLowerCase();
  const hex = (raw.split('@')[0] || '').replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 32) return '';
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`.toLowerCase();
}

function metadataMap(doc) {
  const out = new Map();
  for (const item of Array.isArray(doc.Metadata) ? doc.Metadata : []) {
    if (item?.Key) out.set(String(item.Key), String(item.Value ?? ''));
  }
  return out;
}

function currencyCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === '643' || raw === '810' || raw === 'RUR') return 'RUB';
  return /^[A-Z]{3}$/.test(raw) ? raw : 'RUB';
}

function legacyTotal(doc) {
  const candidates = [
    doc.UniversalTransferDocumentMetadata?.Total,
    doc.UniversalTransferDocumentRevisionMetadata?.Total,
    doc.AcceptanceCertificateMetadata?.Total,
    doc.XmlAcceptanceCertificateMetadata?.Total,
    doc.InvoiceMetadata?.Total,
    doc.InvoiceRevisionMetadata?.Total,
    doc.Torg12Metadata?.Total,
    doc.XmlTorg12Metadata?.Total,
    doc.ReconciliationActMetadata?.Total,
    doc.ContractMetadata?.Total,
    doc.ProformaInvoiceMetadata?.Total
  ];
  return candidates.find(value => value !== undefined && value !== null && value !== '') ?? null;
}

async function resolveCounteragent(boxId) {
  const guid = boxGuidFromId(boxId);
  if (!guid) return { boxId: String(boxId || ''), boxGuid: '', name: '', inn: '', kpp: '' };
  if (organizationCache.has(guid)) return organizationCache.get(guid);
  const promise = (async () => {
    try {
      const response = await diadoc(`/GetOrganization?boxId=${encodeURIComponent(guid)}`);
      const org = await response.json();
      return {
        boxId: String(boxId || ''),
        boxGuid: guid,
        name: org.FullName || org.ShortName || '',
        inn: String(org.Inn || ''),
        kpp: String(org.Kpp || '')
      };
    } catch (_) {
      return { boxId: String(boxId || ''), boxGuid: guid, name: '', inn: '', kpp: '' };
    }
  })();
  organizationCache.set(guid, promise);
  return promise;
}

function compactDocument(doc, category) {
  const meta = metadataMap(doc);
  const totalRaw = meta.get('TotalSum') ?? legacyTotal(doc);
  const total = totalRaw === null || totalRaw === '' ? null : Number(String(totalRaw).replace(',', '.'));
  return {
    id: doc.MessageId && doc.EntityId ? `${doc.MessageId}:${doc.EntityId}` : '',
    messageId: doc.MessageId || '',
    entityId: doc.EntityId || '',
    indexKey: doc.IndexKey || '',
    category,
    counteragentBoxId: doc.CounteragentBoxId || '',
    type: doc.TypeNamedId || String(doc.DocumentType || ''),
    function: doc.Function || '',
    version: doc.Version || '',
    title: doc.Title || doc.FileName || doc.TypeNamedId || 'Документ',
    filename: doc.FileName || '',
    number: meta.get('DocumentNumber') || doc.DocumentNumber || '',
    date: meta.get('DocumentDate') || doc.DocumentDate || '',
    total: Number.isFinite(total) ? total : null,
    vat: meta.get('TotalVat') || '',
    currency: currencyCode(meta.get('CurrencyCode') || doc.InvoiceMetadata?.Currency || doc.UniversalTransferDocumentMetadata?.Currency),
    status: doc.DocflowStatus?.PrimaryStatus?.StatusText || doc.DocflowStatus?.PrimaryStatus?.StatusNamedId || '',
    secondaryStatus: doc.DocflowStatus?.SecondaryStatus?.StatusText || '',
    isRead: Boolean(doc.IsRead),
    isDeleted: Boolean(doc.IsDeleted),
    isTest: Boolean(doc.IsTest),
    creationTimestamp: doc.CreationTimestamp || ''
  };
}

async function enrichCounteragents(docs) {
  const unique = [...new Set(docs.map(doc => doc.counteragentBoxId).filter(Boolean))];
  const resolved = new Map();
  const concurrency = 8;
  for (let i = 0; i < unique.length; i += concurrency) {
    const slice = unique.slice(i, i + concurrency);
    const values = await Promise.all(slice.map(resolveCounteragent));
    values.forEach((value, index) => resolved.set(slice[index], value));
  }
  return docs.map(doc => {
    const org = resolved.get(doc.counteragentBoxId) || {};
    return {
      ...doc,
      counteragent: org.name || '',
      counteragentInn: org.inn || '',
      counteragentKpp: org.kpp || '',
      counteragentBoxGuid: org.boxGuid || boxGuidFromId(doc.counteragentBoxId)
    };
  });
}

async function getDocumentsPage(category, fromDate, toDate, afterIndexKey = '') {
  const body = {
    DocumentCategory: category,
    FromDocumentDate: fromDate,
    ToDocumentDate: toDate,
    SortDirection: 'Descending',
    Count: 100
  };
  if (afterIndexKey) body.AfterIndexKey = afterIndexKey;
  const response = await diadoc(`/V4/GetDocuments?boxId=${encodeURIComponent(PTG_BOX_ID)}`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return response.json();
}

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    service: 'ptg-diadoc-readonly',
    mode: 'READ_ONLY',
    portal: BITRIX_PORTAL,
    boxId: PTG_BOX_ID,
    from: FROM_DATE
  });
});

app.get('/auth/start', async (req, res) => {
  try {
    const { clientId } = await getClientCredentials();
    const redirectUri = CALLBACK_URL || required('DIADOC_REDIRECT_URI');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const state = signedState({ nonce, returnTo: safeReturnTo(req.query.returnTo) });
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
    if (!token.refresh_token) {
      throw new Error('Kontur did not return refresh_token; check offline_access scope');
    }
    await writeRefreshToken(token.refresh_token);
    tokenCache = {
      accessToken: token.access_token,
      expiresAt: nowSeconds() + Number(token.expires_in || 3600) - 120
    };
    const out = new URL(safeReturnTo(state.returnTo));
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
    const ptg = organizations.find(org => {
      if (String(org.Inn || '') !== PTG_INN) return false;
      if (PTG_KPP && String(org.Kpp || '') !== PTG_KPP) return false;
      return (Array.isArray(org.Boxes) ? org.Boxes : []).some(box => String(box.BoxIdGuid || '').toLowerCase() === PTG_BOX_ID.toLowerCase());
    });
    res.json({
      connected: Boolean(ptg),
      ptg: ptg ? {
        name: ptg.FullName || ptg.ShortName || '',
        inn: ptg.Inn,
        kpp: ptg.Kpp,
        boxId: PTG_BOX_ID
      } : null
    });
  } catch (error) {
    const needsAuth = /REFRESH_TOKEN|401|Unauthorized/i.test(error.message);
    res.status(needsAuth ? 401 : 502).json({ connected: false, needsAuth, error: error.message });
  }
});

app.get('/api/diadoc/documents', verifyBitrix, async (req, res) => {
  try {
    const today = new Date();
    const defaultTo = `${String(today.getDate()).padStart(2,'0')}.${String(today.getMonth()+1).padStart(2,'0')}.${today.getFullYear()}`;
    const fromDate = toDiadocDate(req.query.from, FROM_DATE);
    const toDate = toDiadocDate(req.query.to, defaultTo);
    const direction = String(req.query.direction || 'all').toLowerCase();
    const categories = direction === 'incoming' ? ['Incoming'] : direction === 'outgoing' ? ['Outgoing'] : ['Incoming','Outgoing'];
    const maxPages = Math.min(Math.max(Number(req.query.maxPages || 100), 1), 100);
    const docs = [];
    let truncated = false;

    for (const category of categories) {
      let after = '';
      let exhausted = false;
      for (let page = 0; page < maxPages; page++) {
        const payload = await getDocumentsPage(category, fromDate, toDate, after);
        const pageDocs = Array.isArray(payload.Documents) ? payload.Documents : [];
        docs.push(...pageDocs.map(doc => compactDocument(doc, category)));
        if (pageDocs.length < 100) {
          exhausted = true;
          break;
        }
        const next = pageDocs.at(-1)?.IndexKey;
        if (!next || next === after) {
          exhausted = true;
          break;
        }
        after = next;
      }
      if (!exhausted) truncated = true;
    }

    const enriched = await enrichCounteragents(docs);
    const q = String(req.query.q || '').trim().toLowerCase();
    const filtered = q ? enriched.filter(doc => [
      doc.title,
      doc.filename,
      doc.number,
      doc.date,
      doc.counteragent,
      doc.counteragentInn,
      doc.counteragentKpp,
      doc.type,
      doc.status
    ].join(' ').toLowerCase().includes(q)) : enriched;

    res.json({
      from: fromDate,
      to: toDate,
      count: filtered.length,
      totalLoaded: enriched.length,
      truncated,
      documents: filtered
    });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});

app.get('/api/diadoc/document/:messageId/:entityId/content', verifyBitrix, async (req, res) => {
  try {
    const response = await diadoc(
      `/V4/GetEntityContent?boxId=${encodeURIComponent(PTG_BOX_ID)}` +
      `&messageId=${encodeURIComponent(req.params.messageId)}` +
      `&entityId=${encodeURIComponent(req.params.entityId)}`,
      { accept: '*/*' }
    );
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    const disposition = response.headers.get('content-disposition');
    if (disposition) res.setHeader('Content-Disposition', disposition);
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`ptg-diadoc-readonly listening on ${PORT}; portal=${BITRIX_PORTAL}; box=${PTG_BOX_ID}`);
});
