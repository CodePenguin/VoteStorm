# VoteStorm

Self-hosted live polling and audience interaction.

VoteStorm is an open-source, self-hosted platform for interactive presentations, meetings, classrooms, and group activities.

Create a live activity, share a short join code, and let your audience participate from their own devices. Results can be displayed and updated in real time as people respond.

VoteStorm is designed to give organizations and individuals control over their own audience-interaction infrastructure rather than requiring a proprietary hosted polling service.

## What it does today

- **Presenter** creates a Storm, adds questions, and runs the session from one page. Edit mode is for setup; Present mode keeps only what you need while presenting.
- **Audience** joins from any device with one link or QR code. Votes are anonymous, and people can change their answer while a question is live.
- **Question types:** single choice, multiple answers, and rating scales. A question can have a correct answer that is revealed on demand.
- **Live results** on a big-screen page: a bar chart or a donut chart, both updating as votes arrive, a join screen with a live connected count, a background colour you can match to your slides, and the option to hide results until everyone has answered. Presenters can lock voting or run a countdown timer on the live question, and duplicate a Storm to reuse its questions.
- **Slides:** each question has its own results link that can be embedded in a slide deck. Opening it makes that question live (a closed Storm is never reopened).
- **Closed Storms** show every question with its final results as a swipeable view.

Polling is the core activity. The product is intended to grow into broader audience interaction (quizzes, Q&A, word clouds, reactions, and so on), but those are not implemented yet.

## Getting started

Requirements: Node.js 20 or newer.

```sh
npm install
cp .env.example .env     # then fill in ABLY_API_KEY (see the table below)
```

Then do the [initial setup](#initial-setup-minting-your-keys) below, which gives you the three license lines that `.env` needs, and run:

```sh
npm run dev              # Netlify dev server with the Vite app and functions
```

## Initial setup: minting your keys

Every VoteStorm server needs its own signing key and a license for anonymous users, before it will create Storms. There is no default and no fallback: this is part of the setup, locally and when hosted. You do it once per server.

1. **Create your signing key.** Choose an issuer name for yourself (a URL that identifies you as the license issuer; nothing has to be hosted there) and run:

   ```sh
   npm run license -- setup --issuer https://licenses.example.com
   ```

   This writes your **private** signing key to `votestorm-license-key.json` (git-ignored; keep it secret and back it up, because you need it to issue any license) and prints two lines:

   ```text
   ALLOWED_LICENSE_ISSUERS=https://licenses.example.com
   LICENSE_JWKS_JSON={"keys":[...]}
   ```

2. **Mint the license for anonymous users.** This sets the limits for everyone who has no license of their own: how long a Storm lasts and how big it can be. Use the same issuer, and leave out any limit you don't want:

   ```sh
   npm run license -- mint --anonymous --issuer https://licenses.example.com --hours 24 --max-questions 50 --max-audience 500 --max-storms 100
   ```

   The limits are hours before a Storm expires, questions per Storm, audience per Storm, and (`--max-storms`) how many anonymous Storms can exist at once on the whole server.

   It prints a third line:

   ```text
   ANONYMOUS_LICENSE_JWT=eyJhbGciOi...
   ```

3. **Give the three lines to the server.** Paste them into `.env` for local use, or add them as environment variables on your host (see [Hosting](#hosting)).

To change the anonymous limits later, mint a new anonymous license the same way, replace `ANONYMOUS_LICENSE_JWT`, and redeploy. To give a customer or colleague different limits, mint an ordinary license with `--sub <their id> --name "..."` instead of `--anonymous` and send them the token (see [docs/licensing.md](docs/licensing.md)); every Storm records which license created it. The private key can be kept in 1Password instead of a file (`--key op://...`, `--key -` or `VOTESTORM_LICENSE_KEY`; see [docs/licensing.md](docs/licensing.md)). If you lose the private key you cannot issue more licenses with it: run `setup` again with `--force` and mint everything again, because licenses signed with the old key stop working.

Configuration is by environment variables. Locally they come from `.env`; when hosting, set them in your host (see [Hosting](#hosting)).

| Variable | Required | Purpose |
|---|---|---|
| `ABLY_API_KEY` | Yes | Real-time updates. A server-side secret: browsers never see it, they get short-lived tokens limited to one Storm's channel. The key needs the **Publish**, **Subscribe** and **Presence** capabilities (Presence powers the "people connected" count). |
| `TURSO_DATABASE_URL` | In production | libSQL database URL, such as `libsql://votestorm-yourname.turso.io`. If unset, a local SQLite file at `data/local-dev.db` is used. That is for development only: serverless functions have no persistent disk. |
| `TURSO_AUTH_TOKEN` | With a remote database | Auth token for the libSQL database. |
| `ALLOWED_LICENSE_ISSUERS` | Yes | Comma-separated issuer URLs whose license tokens you trust. Printed by `npm run license -- setup`. |
| `LICENSE_JWKS_JSON` | Yes, unless your issuer publishes keys | Inline public keys for the issuer, printed by `npm run license -- setup`. If unset, keys are discovered from the issuer (OIDC), for an issuer such as Auth0. |
| `LICENSE_CLAIM_NAMESPACE` | Optional | Prefix for license claim names, for issuers such as Auth0 that require one. |
| `LICENSE_AUDIENCE` | Optional | If set, a license's `aud` must match. |
| `RATE_LIMIT_SCALE` | Optional | Multiplies every rate limit (see below). `2` doubles them, `0` turns rate limiting off. Default `1`. |
| `ANONYMOUS_LICENSE_JWT` | Yes | The license that everyone without one of their own runs under (it sets the anonymous limits). Issue it with `npm run license -- mint --anonymous ...`. Missing, invalid or expired is a configuration error: Storms cannot be created. |

In a hosted deployment the server refuses to start without `TURSO_DATABASE_URL`, so Storms are never silently kept in a throwaway local file.

See [docs/licensing.md](docs/licensing.md) for how licenses work and how to issue them. The database tables are created automatically on first use.

Other commands:

```sh
npm test          # server and component tests
npm run type-check
npm run build     # production build into dist/
```

## Hosting

VoteStorm is a static single-page app plus serverless functions in Netlify Functions format, so Netlify is the supported host. The repository's `netlify.toml` already contains the build settings (`npm run build`, publish directory `dist`, functions in `netlify/functions`) and the routing, so no build configuration is needed.

1. **Ably:** create an app and an API key with the Publish, Subscribe and Presence capabilities. Copy the key.
2. **Database:** create a libSQL database, for example with [Turso](https://turso.tech):

   ```sh
   turso db create votestorm
   turso db show votestorm --url       # TURSO_DATABASE_URL
   turso db tokens create votestorm    # TURSO_AUTH_TOKEN
   ```

3. **Netlify:** create a site from the repository, then add the variables under *Site configuration, Environment variables* (or with `netlify env:set NAME value`). Set `ABLY_API_KEY`, `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, and the license setup: `ALLOWED_LICENSE_ISSUERS`, `LICENSE_JWKS_JSON` and `ANONYMOUS_LICENSE_JWT` (see [docs/licensing.md](docs/licensing.md); `npm run license -- setup` creates the keys). Mark them as secrets. Netlify needs Node.js 20 or newer (set `NODE_VERSION=20` if your site defaults to something older).
4. **Deploy.** Environment variable changes only take effect on the next deploy, so redeploy after changing any of them.

Never commit `.env` or your keys. Without `TURSO_DATABASE_URL` a hosted deployment would try to use a local file that does not persist between function runs, so Storms would disappear.

## Abuse protection

Requests that strangers can send are rate limited per address (a hash of it is stored, never the address itself): creating or duplicating Storms (20 per hour), voting (2,000 per minute per address and 30 per minute per device), adding questions (120 per minute) and real-time tokens (600 per minute). The limits are deliberately generous because a whole audience can share one public address; scale them with `RATE_LIMIT_SCALE`. Question text and options have length limits, and real-time access is only given to Storms that exist.

## Licensing

Every limit comes from a signed license, including the one that anonymous users run under (inactivity expiry, questions per Storm, audience per Storm and active Storms). Licenses can come from any issuer you choose to trust. See [docs/licensing.md](docs/licensing.md).

## How it is built

A Vue 3 + TypeScript + Vite single-page app, with serverless functions (`netlify/functions`) for the API, libSQL for storage, and Ably for real-time updates. Storms are controlled by secret keys, with no accounts required; Storms expire after a period of inactivity.

## License

VoteStorm is licensed under the GNU General Public License v3.0 only. See [COPYING](COPYING).

Copyright David Lambert ([Code Penguin](https://codepenguin.com)).
