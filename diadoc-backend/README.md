# PTG Bitrix24 ↔ Диадок (READ ONLY, phase 1)

Backend for the existing `adelsaratov-web/B24` local Bitrix24 application.

## Security model

- no Diadoc secrets are stored in GitHub Pages or browser code;
- the browser sends its current Bitrix24 session to this backend;
- the backend verifies the Bitrix session via `profile` before returning Diadoc data;
- Diadoc uses OpenID Connect Authorization Code Flow with `offline_access`;
- the refresh token is persisted in Google Secret Manager;
- phase 1 implements only reading/listing/downloading;
- there are no API routes for Send, PostMessage, signing, rejection, revocation, deletion or counteragent invitations.

## Required secrets

Create these secrets outside Git and grant the Cloud Run service account `Secret Manager Secret Accessor`:

- `DIADOC_CLIENT_ID`
- `DIADOC_CLIENT_SECRET`
- `DIADOC_REFRESH_TOKEN` — create an empty secret shell first; the first OIDC callback adds a version.
- `STATE_SECRET` may be supplied as an environment variable or Secret Manager can be wired separately. It must be a long random value.

The code also accepts `DIADOC_ACCESS_TOKEN` temporarily for diagnostics, but production should use a refresh token.

## Required environment variables

- `DIADOC_REDIRECT_URI=https://<backend>/auth/callback`
- `FRONTEND_ORIGIN=https://adelsaratov-web.github.io`
- `DIADOC_BOX_ID=b6c02154-477b-455d-a587-50d085c7a032`
- `DIADOC_FROM_DATE=01.01.2023`
- `STATE_SECRET=<random secret>`
- `DIADOC_REFRESH_SECRET=DIADOC_REFRESH_TOKEN`

## OIDC settings in Kontur Integrator Cabinet

Token flow: **Authorization Code Flow**.

Redirect URI must exactly match `DIADOC_REDIRECT_URI`.

Scopes requested by the backend:

`openid profile email offline_access Diadoc.PublicAPI`

After deploy, open:

`https://<backend>/auth/start?returnTo=https%3A%2F%2Fadelsaratov-web.github.io%2FB24%2Fdiadoc.html`

Complete Kontur/Diadoc authentication. If certificate login is enabled in your Kontur account, the inserted Rutoken/qualified certificate can be used in that browser login. The private key stays on the token.

## Frontend connection

Set in `../diadoc-config.js`:

```js
window.PTG_DIADOC_BACKEND = 'https://<backend>';
```

No secret values are placed in that file.

## Current data scope

- organization: ООО «ПТГ», INN `6449064635`, KPP `644901001`;
- box: `b6c02154-477b-455d-a587-50d085c7a032`;
- document period: `01.01.2023` through current date;
- incoming and outgoing documents;
- full pagination using `AfterIndexKey`;
- entity content is downloaded only by explicit user action.

## Phase 2 (not implemented yet)

After READ ONLY acceptance:

1. link documents to Bitrix CRM companies by INN/KPP;
2. link documents to transport deals by contract/period;
3. normalize gas acceptance acts into the economic register;
4. add scheduled incremental sync;
5. only after separate approval: design signing workflow with Rutoken/qualified signature. Do not place signing keys or PINs in cloud storage.
