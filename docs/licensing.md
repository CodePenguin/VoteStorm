# Licensing

VoteStorm can run with no license at all. A license is a signed token, issued by whoever operates your VoteStorm server, that sets how long Storms last and how large they can be. VoteStorm does not mint, sell or phone home for licenses: it only checks signatures against the issuers and keys you configure, so any issuer can be used.

## What a license controls

Every limit lives in the license, including the anonymous tier's (see [The anonymous tier](#the-anonymous-tier)). Nothing is hardcoded in the code that enforces them.

| Claim | Meaning | If absent |
|---|---|---|
| `sub` | Stable id of the licensee. Required. Storms are counted per `sub`. | License rejected |
| `name` | Display name shown on the License page. | None shown |
| `stormInactivityHours` | A Storm is deleted after this many hours without activity. | The anonymous default (24) |
| `maxQuestionsPerStorm` | Clouds a Storm may hold. | Unlimited |
| `maxAudiencePerStorm` | Distinct devices that may vote in a Storm. | Unlimited |
| `maxActiveStorms` | Storms that may exist at once for this license: the Storms it created that have not been deleted or expired (closed Storms still count until they expire or are deleted). For the anonymous license this caps anonymous Storms across the whole server. | Unlimited |
| `exp` | When the license stops being accepted. Standard JWT claim. | Never expires |

Limits must be positive whole numbers; anything else is ignored (treated as unlimited, or as the default for inactivity).

## How limits are applied

- **Storms keep their license.** When a Storm is created (or when its presenter next loads it carrying a valid license), the license is stored on the Storm. The audience never presents a license, so a Storm's limits keep applying to them.
- **Expiry** counts presenter actions and audience votes as activity. Merely viewing a page is not activity. A lapsed Storm is removed when anyone next opens it, and by a sweep whenever a Storm is created.
- **Audience size** counts distinct devices that have voted in the Storm. Devices already counted can keep voting and changing answers.
- **Clouds** cannot be added past the limit. Existing clouds can still be edited, reordered and deleted.
- **Active Storms** are counted per license, by the license that created each Storm (the `sub`, or `anonymous` for the anonymous license). Going over the limit stops new Storms being created until one is deleted or expires; a license cannot use up another's allowance, and presenting a different license on a Storm does not move it between allowances.
- **An invalid or expired presented license** stops a new Storm from being created, with a message that points to the License page. On an existing Storm it is ignored, so a presenter is never locked out mid-event; the Storm simply keeps the license it was created under.
- A license that later expires does not shorten Storms that already exist. They run out their inactivity window.

## The anonymous tier

Everyone who has no license of their own runs under the anonymous tier, and the anonymous tier is itself just a license: signed and validated exactly like any other (same issuers, keys and claim names), and given to the server in `ANONYMOUS_LICENSE_JWT`. Issue it with the script:

```sh
npm run license -- mint --anonymous --issuer https://licenses.example.com --hours 24 --max-questions 50 --max-audience 500 --max-storms 100
```

The script prints the line to add to the server environment. It is minted to last ten years by default. Its `maxActiveStorms` is a cap on how many anonymous Storms can exist at once on the whole server (`--max-storms`), a useful guard against the public tier filling your database.

**It is part of the setup, everywhere.** There is no built-in default and no fallback, locally or hosted: minting your keys and the anonymous license is how a VoteStorm server is set up. If `ANONYMOUS_LICENSE_JWT` is missing, invalid or expired, creating a Storm (and the license status check) fails with a "not configured correctly" error, and the reason is written to the server log. That is a configuration error to fix, not a state to run in. Storms that already exist keep working.

## Server configuration

| Variable | Purpose |
|---|---|
| `ALLOWED_LICENSE_ISSUERS` | **Required.** Comma-separated issuer URLs you trust. A token's `iss` must match one **exactly** (including any trailing slash). Without this, every license, including the anonymous one, is refused. |
| `LICENSE_JWKS_JSON` | Optional inline public keys (`{"keys":[...]}`). If set, no network calls are made. If not set, keys are fetched through OIDC discovery (`<issuer>/.well-known/openid-configuration`), which gives automatic key rotation. |
| `LICENSE_CLAIM_NAMESPACE` | Optional prefix for the claim names above. Auth0, for example, only allows custom claims under a URL you own. Un-prefixed claims are still read as a fallback. |
| `LICENSE_AUDIENCE` | Optional. If set, the token's `aud` must match. |
| `ANONYMOUS_LICENSE_JWT` | **Required.** The license that everyone without one of their own runs under; see [The anonymous tier](#the-anonymous-tier). |

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
  --days 365 --hours 168 --max-questions 40 --max-audience 500 --max-storms 3 \
  --app-url https://votestorm.example.com
```

Leave out any limit to leave it unlimited. With `--app-url` the script also prints an activation link to send to the licensee.

#### Keeping the private key in 1Password (or another secret store)

The key does not have to live in a file. After `setup`, store the contents of `votestorm-license-key.json` in 1Password (a secure note or document) and delete the file. `mint` can then load the key without writing it to disk, in any of these ways:

```sh
# Read it through the 1Password CLI
npm run license -- mint --key op://Private/VoteStorm-license-key/notesPlain --issuer ... --sub acme

# Or pipe it in
op read op://Private/VoteStorm-license-key/notesPlain | npm run license -- mint --key - --issuer ... --sub acme

# Or let `op run` put it in the environment (VOTESTORM_LICENSE_KEY holds the JWK JSON)
op run --env-file=.op.env -- npm run license -- mint --issuer ... --sub acme
```

An explicit `--key` always wins over `VOTESTORM_LICENSE_KEY`. The value must be the private JWK that `setup` writes (it contains `"d"`); anything else is refused. Adjust the `op://` path to wherever you saved it.

### Option 2: any OIDC-style provider

Use an identity provider that can sign JWTs with ES256 or RS256 and add custom claims (Keycloak, Authentik, Auth0, Okta, and so on). Set `ALLOWED_LICENSE_ISSUERS` to its issuer URL and leave `LICENSE_JWKS_JSON` empty so keys are discovered. Add the claims in the table above to the tokens it issues, using a namespace if the provider requires one (and set `LICENSE_CLAIM_NAMESPACE` to match).

### Option 3: Auth0 (one worked example)

1. Create an **API** (Applications, then APIs). Its identifier is the audience, for example `https://licenses.example.com`. Set `LICENSE_AUDIENCE` to it. Set the API's token lifetime to the license term, within Auth0's limits.
2. Create a **Machine to Machine application** for each licensee and authorize it for that API. Put the licensee's values in the application's metadata: `licenseName`, `stormInactivityHours`, `maxQuestionsPerStorm`, `maxAudiencePerStorm`, `maxActiveStorms`.
3. Add an **Action** to the Machine to Machine flow that copies the metadata into namespaced claims:

   ```javascript
   exports.onExecuteCredentialsExchange = async (event, api) => {
     const ns = 'https://votestorm.example.com/'; // must equal LICENSE_CLAIM_NAMESPACE
     const meta = event.client.metadata;
     api.accessToken.setCustomClaim(ns + 'name', meta.licenseName ?? event.client.name);
     for (const key of ['stormInactivityHours', 'maxQuestionsPerStorm', 'maxAudiencePerStorm', 'maxActiveStorms']) {
       if (meta[key] !== undefined) api.accessToken.setCustomClaim(ns + key, parseInt(meta[key], 10));
     }
   };
   ```

4. Configure the server: `ALLOWED_LICENSE_ISSUERS=https://YOUR-TENANT.us.auth0.com/` (with the trailing slash), `LICENSE_CLAIM_NAMESPACE=https://votestorm.example.com/`, `LICENSE_AUDIENCE=https://licenses.example.com`.
5. Request an access token for the application with the client-credentials grant. That access token is the license.

The `sub` Auth0 puts in a client-credentials token identifies the application, which is what Storms are counted against.

## Who created a Storm

Every Storm records which license created it, permanently: `created_by_license_id` (the license's `sub`; `anonymous` for Storms made under the anonymous tier) and `created_by_license_name`. This stays fixed even if someone later presents a different license on the Storm, which only changes the limits the Storm runs under (`license_id` and `license_json`). To see who is using your server:

```sql
SELECT created_by_license_id, created_by_license_name, COUNT(*) AS storms, MAX(created_at) AS latest
FROM storms GROUP BY created_by_license_id ORDER BY storms DESC;
```

## Activating a license

Send the licensee either of:

- The token itself, to paste on the **License** page (`/license`, linked from the page footer).
- A link of the form `https://your-server/#licenseJwt=<token>`. Opening it activates the license, removes the token from the address bar, and shows the License page.

The token is checked by the server before it is kept, then stored in the browser and sent only with presenter requests, not audience requests. The License page shows the current plan, its limits and the expiry, and lets the presenter remove or replace the license. The presenter's Control tab shows the license a Storm is running under.

## Checking a token

```sh
curl -H "Authorization: Bearer <token>" https://your-server/.netlify/functions/license-status
```

returns the tier, name, expiry and limits, or a 401 with the reason.
