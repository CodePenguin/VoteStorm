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

Configuration (environment variables):

| Variable | Purpose |
|---|---|
| `ABLY_API_KEY` | Real-time updates. The key needs the Publish, Subscribe and Presence capabilities. |
| `TURSO_DATABASE_URL` | libSQL database URL. Omit it to use a local SQLite file at `data/local-dev.db`. |
| `TURSO_AUTH_TOKEN` | Auth token for a remote libSQL database. |
| `ALLOWED_LICENSE_ISSUERS` and related | Optional. Trusted license issuers; see [Licensing](docs/licensing.md). |

Other commands:

```sh
npm test          # server and component tests
npm run type-check
npm run build     # production build into dist/
```

## Licensing

VoteStorm runs without a license. By default a room expires after 24 hours of inactivity. A signed license token, from any issuer you choose to trust, can raise that and set limits on questions, audience size and rooms. The anonymous defaults are configurable too. See [docs/licensing.md](docs/licensing.md).

## How it is built

A Vue 3 + TypeScript + Vite single-page app, with serverless functions (`netlify/functions`) for the API, libSQL for storage, and Ably for real-time updates. Rooms are controlled by secret keys, with no accounts required; rooms expire after a period of inactivity.

## License

VoteStorm is licensed under the GNU General Public License v3.0 only. See [COPYING](COPYING).

Copyright David Lambert ([Code Penguin](https://codepenguin.com)).
