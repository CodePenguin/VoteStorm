# VoteStorm

Self-hosted live polling and audience interaction.

VoteStorm is an open-source, self-hosted platform for interactive presentations, meetings, classrooms, and group activities.

Create a live activity, share a short join code, and let your audience participate from their own devices. Results can be displayed and updated in real time as people respond.

VoteStorm is designed to give organizations and individuals control over their own audience-interaction infrastructure rather than requiring a proprietary hosted polling service.

## What it does today

- **Presenter** creates a room, adds questions, and runs the session from one page. Edit mode is for setup; Present mode keeps only what you need while presenting.
- **Audience** joins from any device with one link or QR code. Votes are anonymous, and people can change their answer while a question is live.
- **Question types:** single choice, multiple answers, and rating scales. A question can have a correct answer that is revealed on demand.
- **Live results** on a big-screen page: animated bars or a donut chart, a join screen with a live connected count, and the option to hide results until everyone has answered.
- **Slides:** each question has its own results link that can be embedded in a slide deck. Opening it makes that question live (a closed room is never reopened).
- **Closed rooms** show every question with its final results as a swipeable view.

Polling is the core activity. The product is intended to grow into broader audience interaction (quizzes, Q&A, word clouds, reactions, and so on), but those are not implemented yet.

## Getting started

Requirements: Node.js 20 or newer.

```sh
npm install
cp .env.example .env   # then fill in the values below
npm run dev            # Netlify dev server with the Vite app and functions
```

Configuration is by environment variables. Locally they come from `.env`; when hosting, set them in your host (see [Hosting](#hosting)).

| Variable | Required | Purpose |
|---|---|---|
| `ABLY_API_KEY` | Yes | Real-time updates. A server-side secret: browsers never see it, they get short-lived tokens limited to one room's channel. The key needs the **Publish**, **Subscribe** and **Presence** capabilities (Presence powers the "people connected" count). |
| `TURSO_DATABASE_URL` | In production | libSQL database URL, such as `libsql://votestorm-yourname.turso.io`. If unset, a local SQLite file at `data/local-dev.db` is used. That is for development only: serverless functions have no persistent disk. |
| `TURSO_AUTH_TOKEN` | With a remote database | Auth token for the libSQL database. |
| `ALLOWED_LICENSE_ISSUERS` | For licensing | Comma-separated issuer URLs whose license tokens you trust. Without it, any license token is refused; people with no license run as the anonymous tier. |
| `LICENSE_JWKS_JSON` | Optional | Inline public keys for the issuer. If unset, keys are discovered from the issuer (OIDC). |
| `LICENSE_CLAIM_NAMESPACE` | Optional | Prefix for license claim names, for issuers such as Auth0 that require one. |
| `LICENSE_AUDIENCE` | Optional | If set, a license's `aud` must match. |
| `ANONYMOUS_LICENSE_JSON` | Optional | Limits for the anonymous tier. Default: rooms expire after 24 hours of inactivity, nothing else limited. |

The license variables are all optional; see [docs/licensing.md](docs/licensing.md) for what they do and how to issue licenses. The database tables are created automatically on first use.

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

3. **Netlify:** create a site from the repository, then add the variables under *Site configuration, Environment variables* (or with `netlify env:set NAME value`). At minimum set `ABLY_API_KEY`, `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, and add the license variables if you use licensing. Mark them as secrets. Netlify needs Node.js 20 or newer (set `NODE_VERSION=20` if your site defaults to something older).
4. **Deploy.** Environment variable changes only take effect on the next deploy, so redeploy after changing any of them.

Never commit `.env` or your keys. Without `TURSO_DATABASE_URL` a hosted deployment would try to use a local file that does not persist between function runs, so rooms would disappear.

## Licensing

VoteStorm runs without a license. By default a room expires after 24 hours of inactivity. A signed license token, from any issuer you choose to trust, can raise that and set limits on questions, audience size and rooms. The anonymous defaults are configurable too. See [docs/licensing.md](docs/licensing.md).

## How it is built

A Vue 3 + TypeScript + Vite single-page app, with serverless functions (`netlify/functions`) for the API, libSQL for storage, and Ably for real-time updates. Rooms are controlled by secret keys, with no accounts required; rooms expire after a period of inactivity.

## License

VoteStorm is licensed under the GNU General Public License v3.0 only. See [COPYING](COPYING).

Copyright David Lambert ([Code Penguin](https://codepenguin.com)).
