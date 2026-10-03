# Licensing

VoteStorm can run with no license at all. A license is a signed token, issued by whoever operates your VoteStorm server, that sets how long rooms last and how large they can be. VoteStorm does not mint, sell or phone home for licenses: it only checks signatures against the issuers and keys you configure, so any issuer can be used.

## What a license controls

Every limit lives in the license, including the anonymous tier's (see [The anonymous tier](#the-anonymous-tier)). Nothing is hardcoded in the code that enforces them.

| Claim | Meaning | If absent |
|---|---|---|
| `sub` | Stable id of the licensee. Required. Rooms are counted per `sub`. | License rejected |
| `name` | Display name shown on the License page. | None shown |
| `roomInactivityHours` | A room is deleted after this many hours without activity. | The anonymous default (24) |
| `maxQuestionsPerRoom` | Questions a room may hold. | Unlimited |
| `maxAudiencePerRoom` | Distinct devices that may vote in a room. | Unlimited |
| `maxActiveRooms` | Rooms one license may have at once. | Unlimited |
| `exp` | When the license stops being accepted. Standard JWT claim. | Never expires |

Limits must be positive whole numbers; anything else is ignored (treated as unlimited, or as the default for inactivity).

## How limits are applied

- **Rooms keep their license.** When a room is created (or when its presenter next loads it carrying a valid license), the license is stored on the room. The audience never presents a license, so a room's limits keep applying to them.
- **Expiry** counts presenter actions and audience votes as activity. Merely viewing a page is not activity. A lapsed room is removed when anyone next opens it, and by a sweep whenever a room is created.
- **Audience size** counts distinct devices that have voted in the room. Devices already counted can keep voting and changing answers.
- **Questions** cannot be added past the limit. Existing questions can still be edited, reordered and deleted.
- **Active rooms** are counted per `sub`. The anonymous tier has no identity, so it has no room limit.
- **An invalid or expired license** stops a new room from being created, with a message that points to the License page. On an existing room it is ignored, so a presenter is never locked out mid-event; the room simply keeps the license it was created under.
- A license that later expires does not shorten rooms that already exist. They run out their inactivity window.

## The anonymous tier

With no license loaded, a room expires after 24 hours of inactivity and has no other limits. Change that for your server with `ANONYMOUS_LICENSE_JSON`, using the same names as the claims:

```sh
ANONYMOUS_LICENSE_JSON={"roomInactivityHours":12,"maxQuestionsPerRoom":10,"maxAudiencePerRoom":50}
```

## Server configuration

| Variable | Purpose |
|---|---|
| `ALLOWED_LICENSE_ISSUERS` | Comma-separated issuer URLs you trust. A token's `iss` must match one **exactly** (including any trailing slash). Without this, every license is refused. |
| `LICENSE_JWKS_JSON` | Optional inline public keys (`{"keys":[...]}`). If set, no network calls are made. If not set, keys are fetched through OIDC discovery (`<issuer>/.well-known/openid-configuration`), which gives automatic key rotation. |
| `LICENSE_CLAIM_NAMESPACE` | Optional prefix for the claim names above. Auth0, for example, only allows custom claims under a URL you own. Un-prefixed claims are still read as a fallback. |
| `LICENSE_AUDIENCE` | Optional. If set, the token's `aud` must match. |
| `ANONYMOUS_LICENSE_JSON` | Optional limits for the anonymous tier. |

Tokens must be signed with ES256 or RS256. Unsigned and symmetric (HS256) tokens are refused.

## Issuing licenses

Pick any one of these.

### Option 1: the bundled script (self-hosted keys)

```sh
npm run license -- setup --issuer https://licenses.example.com
```

This writes a private signing key to `votestorm-license-key.json` (keep it secret and backed up; it is git-ignored) and prints two lines for your server environment: `ALLOWED_LICENSE_ISSUERS` and `LICENSE_JWKS_JSON`. The issuer URL is only an identifier here; nothing needs to be hosted at it.

Then mint a license for each licensee:

```sh
npm run license -- mint --issuer https://licenses.example.com --sub acme --name "Acme Training" \
  --days 365 --hours 168 --max-questions 40 --max-audience 500 --max-rooms 3 \
  --app-url https://votestorm.example.com
```

Leave out any limit to leave it unlimited. With `--app-url` the script also prints an activation link to send to the licensee.

### Option 2: any OIDC-style provider

Use an identity provider that can sign JWTs with ES256 or RS256 and add custom claims (Keycloak, Authentik, Auth0, Okta, and so on). Set `ALLOWED_LICENSE_ISSUERS` to its issuer URL and leave `LICENSE_JWKS_JSON` empty so keys are discovered. Add the claims in the table above to the tokens it issues, using a namespace if the provider requires one (and set `LICENSE_CLAIM_NAMESPACE` to match).

### Option 3: Auth0 (one worked example)

1. Create an **API** (Applications, then APIs). Its identifier is the audience, for example `https://licenses.example.com`. Set `LICENSE_AUDIENCE` to it. Set the API's token lifetime to the license term, within Auth0's limits.
2. Create a **Machine to Machine application** for each licensee and authorize it for that API. Put the licensee's values in the application's metadata: `licenseName`, `roomInactivityHours`, `maxQuestionsPerRoom`, `maxAudiencePerRoom`, `maxActiveRooms`.
3. Add an **Action** to the Machine to Machine flow that copies the metadata into namespaced claims:

   ```javascript
   exports.onExecuteCredentialsExchange = async (event, api) => {
     const ns = 'https://votestorm.example.com/'; // must equal LICENSE_CLAIM_NAMESPACE
     const meta = event.client.metadata;
     api.accessToken.setCustomClaim(ns + 'name', meta.licenseName ?? event.client.name);
     for (const key of ['roomInactivityHours', 'maxQuestionsPerRoom', 'maxAudiencePerRoom', 'maxActiveRooms']) {
       if (meta[key] !== undefined) api.accessToken.setCustomClaim(ns + key, parseInt(meta[key], 10));
     }
   };
   ```

4. Configure the server: `ALLOWED_LICENSE_ISSUERS=https://YOUR-TENANT.us.auth0.com/` (with the trailing slash), `LICENSE_CLAIM_NAMESPACE=https://votestorm.example.com/`, `LICENSE_AUDIENCE=https://licenses.example.com`.
5. Request an access token for the application with the client-credentials grant. That access token is the license.

The `sub` Auth0 puts in a client-credentials token identifies the application, which is what rooms are counted against.

## Activating a license

Send the licensee either of:

- The token itself, to paste on the **License** page (`/license`, linked from the page footer).
- A link of the form `https://your-server/#licenseJwt=<token>`. Opening it activates the license, removes the token from the address bar, and shows the License page.

The token is checked by the server before it is kept, then stored in the browser and sent only with presenter requests, not audience requests. The License page shows the current plan, its limits and the expiry, and lets the presenter remove or replace the license. The presenter's Control tab shows the license a room is running under.

## Checking a token

```sh
curl -H "Authorization: Bearer <token>" https://your-server/.netlify/functions/license-status
```

returns the tier, name, expiry and limits, or a 401 with the reason.
