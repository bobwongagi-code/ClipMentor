# ClipMentor web

This app provides the business workflow for ClipMentor. Its upload, blueprint review, and two-ending preview use the ClipMentor backend in the parent checkout.

Use Node 24 for local development and tests. Install the web dependencies with `npm ci` from this directory, then run:

```sh
CLIPMENTOR_PROJECT_ID=your-saved-project-id npm run dev
```

Replace the placeholder with the existing project ID. Open `http://127.0.0.1:5174/`. The backend must already be listening on loopback. The dev proxy uses port 5199 unless `CLIPMENTOR_BACKEND_PORT` is set. Opening a saved project reads its existing upload receipt and production state. The demo is available without a project ID or with `?demo=1`.

The Vite development proxy serves the two ClipMentor business API routes only on loopback. Static builds currently serve the demo. A hosted production app needs its own authenticated API connection. The app installs no editor, model, or media runtime.

## Tests

Run `npm test` for the type check, build, state rules, and browser regressions. Install the pinned Chromium once with `npx playwright install chromium`. `npm run test:integration` also uses the parent checkout's installed packages and FFmpeg. It runs the real HTTP handlers against temporary data with a deterministic worker and reviewer. The browser tests use an isolated UI and fixture port.
