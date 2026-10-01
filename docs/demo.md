# Run the product tour

The tour uses the actual web client and REST API with fictional projects, synthetic costs and illustrative test logs. It opens without entering an API key and rejects all HTTP methods except GET and HEAD. It is bound to `127.0.0.1` and intended for local exploration, screenshots and demonstrations.

## Prepare a separate database

From the repository root, after starting the development database:

```sh
docker compose up -d --wait
docker compose exec db psql -U aitracker -d postgres -c 'create database aitracker_demo'
cd server
npm ci
DATABASE_URL=postgres://aitracker:aitracker@127.0.0.1:5433/aitracker_demo \
  DATA_DIR=data/demo node scripts/seed-demo.ts /tmp/ai-tracker-demo.keys.local
```

The seeder refuses a database whose name does not end in `_demo`, and refuses one that already has accounts. If the database already exists and is seeded, skip the create and seed commands. Keys are written to the specified local file; do not commit or publish it.

## Open the tour

```sh
DEMO_DATABASE_URL=postgres://aitracker:aitracker@127.0.0.1:5433/aitracker_demo \
  DEMO_DATA_DIR=data/demo npm run demo
```

Open [the board](http://127.0.0.1:4602/?lang=en#/board), [a result awaiting review](http://127.0.0.1:4602/?lang=en#/tasks/4), or [analytics](http://127.0.0.1:4602/?lang=en#/analytics).

Buttons that change data remain visible so you can inspect the real interface. Clicking them produces a read-only message. Run a normal instance if you want to try creating and editing tasks. Stop the tour with Ctrl-C; its temporary session is revoked on shutdown.

This mode is not a public multi-user demo service. It automatically grants read access to its seeded database, so do not point it at confidential data or expose it through a public proxy.

## Media

- `assets/board.jpg`: actual board with the sample team.
- `assets/review.jpg`: task result and discussion.
- `assets/analytics.jpg`: synthetic time and cost analytics.
- `assets/tour.gif`: a slideshow of those real screens, rather than a video recording.
