# ClipMentor web

This app provides the business workflow for ClipMentor. Its upload, blueprint review, and two-ending preview use the ClipMentor backend in the parent checkout.

Use Node 24 for local development and tests. Install the web dependencies with `npm ci` from this directory, then run:

```sh
npm run dev
```

Open `http://127.0.0.1:5174/` for the task workspace. The backend must already be listening on loopback. The dev proxy uses port 5199 unless `CLIPMENTOR_BACKEND_PORT` is set. Use `CLIPMENTOR_PROJECT_ID=your-saved-project-id npm run dev` to pin the frontend to an existing project. Use `?demo=1` for the demonstration.

The Vite development proxy serves ClipMentor's business API only on loopback. The app installs no editor, model, or media runtime. The workspace admits up to five running tasks per backend process and data profile. The two versions of a task share one slot. Waiting for human review releases it. The list polls lightweight metadata every five seconds and the server reuses matching list reads for 2.5 seconds. The download page reads each version's eligibility and requests a small JPEG from the saved preview. The backend creates one thumbnail at a time and reuses it while the render is unchanged.

## Production API

Build the frontend with the same-origin path exposed by the authenticated ClipMentor gateway:

```sh
CLIPMENTOR_PUBLIC_API_BASE_PATH=/api/clipmentor npm run build
```

Serve `dist/` at the web origin. Route `<path>/intake` and `<path>/production` through the gateway before the static HTML fallback. The gateway authenticates the session and resolves an authorized project on the server. Respond with HTTP 401 or 403 for expired sessions or denied access. Keep login redirects and HTML fallback pages outside the API, including media and downloads. Preserve upstream status, `X-ClipMentor-Board-Identity`, content type, content disposition, content security policy and byte-range headers. Send `Cache-Control: no-store` for project API responses.

Where the gateway uses the existing editor upstream, map intake to `material-intake` and production to `production-task` with the gateway-resolved project ID. Default the production view to `panel`. Limit reads to the panel views `panel`, `panel_board`, `panel_video`, `panel_download`, `panel_draft_download`, `panel_reference` and `panel_attachment`, and allow production writes only through `panel`. Forward the panel query fields and the Range header as applicable. Keep the editor endpoints private. Enforce write permissions and validate the browser Origin on writes at the gateway before forwarding them to the loopback editor.

After those checks, construct the upstream Host and Origin from the private editor address and send `Sec-Fetch-Site: same-origin`. The editor checks its own Origin even on production reads. Reload the business page when changing the selected project so the browser reloads the project receipt and panel together.

The path is public build-time configuration. Use a leading slash followed by path segments with letters, digits, hyphens or underscores. Full URLs, empty segments and query strings cause a build error. Project IDs and credentials belong on the gateway. An unset or empty path builds the demo and `?demo=1` remains an explicit demo override. `npm run preview` serves the static files locally and requires a same-origin gateway to exercise the live API configuration.

For a workspace deployment, set `CLIPMENTOR_PUBLIC_WORKSPACE=1` alongside the API base path. Route `<path>/tasks` to the authorized workspace list and creation service. Scope both the list and individual requests to the signed-in account. Check each requested `projectId`, including video, attachments and download routes. For the trusted loopback service, `/tasks` maps to `task-workspace`. Enable `panel_poster` for saved-preview thumbnails, `panel_draft_download` for separately named unreviewed copies and `panel_material` for bound product images and CTA posters. Keep formal final media on `panel_download`. The five-slot admission is local to a backend process. Multiple worker processes would require a shared admission state before exposing a common workspace.

## Tests

Run `npm test` for the type check, build, state rules, and browser regressions. Install the pinned Chromium once with `npx playwright install chromium`. `npm run test:integration` also uses the parent checkout's installed packages and FFmpeg. It runs the real HTTP handlers against temporary data with a deterministic worker and reviewer. The browser tests use an isolated UI and fixture port.

From the parent checkout, run `npx tsx server/clipmentor/task-workspace.verify.ts` to exercise concurrent admission, quota release and task creation against isolated local storage.
