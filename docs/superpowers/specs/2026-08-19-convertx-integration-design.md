# ConvertX Integration — Design

**Date:** 2026-08-19
**Status:** Approved design, pending implementation plan
**Revision:** 2 (incorporates two adversarial review passes)
**Scope:** Add server-backed file conversion to a personal fork of it-tools, using a forked ConvertX as the backend.

---

## 1. Context

[it-tools](https://github.com/CorentinTh/it-tools) is a pure client-side Vue 3 SPA. All 90 of its
tools are Vue components that run entirely in the browser; the production artifact is a static
`dist/` served by `nginx:stable-alpine`. There is no backend, no HTTP client layer, and no auth
anywhere in the codebase.

[ConvertX](https://github.com/C4illin/ConvertX) is a self-hosted file converter: a Bun + Elysia
server with SQLite, JWT cookie auth, and server-rendered JSX (`@kitajs/html`). It converts files by
shelling out to ~25 native binaries (ffmpeg, LibreOffice, Calibre, ImageMagick, TeXLive, Inkscape,
pandoc, …), which is why its image is `debian:testing-slim` plus several GB of packages.

These architectures do not merge. ConvertX cannot run in a browser, and it-tools has no server to
host it. The integration is therefore a **two-service system**, not a code merge.

### Licensing

it-tools is GPLv3; ConvertX is AGPL-3.0. GPLv3 §13 explicitly permits combining a GPLv3 work with an
AGPLv3 work, but the AGPL network clause then applies to the combination. The combined work is
treated as **AGPL-3.0** for this project.

> This is the author's reading, not verified legal advice. The two codebases remain separately
> licensed works under the AGPL umbrella; `LICENSING.md` must carry both licenses and a written
> offer of source for the combined distribution.

---

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Native Vue tool backed by ConvertX over HTTP** — not an iframe, link-out, monorepo vendoring, or client-side WASM | Matches it-tools UX; WASM covers ~20 formats vs 1000+ |
| D2 | **Fork ConvertX and add an additive JSON API** | ConvertX's business logic is already separated in `src/converters/main.ts`; the API is a new file, not a rewrite |
| D3 | **Single compose stack, same-origin nginx proxy** | Avoids CORS entirely; ConvertX cookies are `sameSite: "strict"` and cannot work cross-origin without fork changes |
| D4 | **MVP = single-file convert + drag/drop, live progress polling, converter capability browser** | Multi-file batch deferred; it is additive and the backend already supports it |
| D5 | **it-tools fork is the umbrella repo; ConvertX fork is a git submodule at `services/convertx`** | Each fork keeps its own `upstream` remote and rebases independently |
| D6 | **`UNAUTHENTICATED_USER_SHARING=true` — stable synthetic user id `0`** | Identity survives cookie loss and container restarts. **See the security consequence below — this is not merely "shared history".** |
| D7 | **API designed to be upstreamable; homelab assumptions kept in a separate file** | Issue #363 requests exactly this API and PR #375 was closed by its own author, not rejected. If upstream merges it, the fork and its rebase treadmill disappear |

### D6 security consequence (explicit)

Under `UNAUTHENTICATED_USER_SHARING=true`, **every job is owned by user `0` and job ids are
sequential integers**. The ownership check `WHERE id = ? AND user_id = ?` — which api.tsx performs
on every route — therefore succeeds for *any* client on *any* job. Concretely:

> **Anyone who can reach the stack can enumerate `/api/v1/jobs/1..N` and download every file anyone
> has ever converted, until the 24-hour sweep removes it.**

This is accepted for a trusted LAN, and is the direct cost of D6's stability guarantee. It must be
stated in the README, not buried. There is also **no rate limiting** anywhere in the stack;
consciously waived on the same trusted-LAN basis. If the deployment ever becomes reachable beyond a
trusted network, D6 must be revisited before anything else.

---

## 3. Verified facts

Confirmed by reading source, not inferred. Implementers should not re-derive these — but see
fact (10)'s standing caveat about drift.

### ConvertX (`main`, tree `f444d84`, fetched 2026-08-19)

1. **`ALLOW_UNAUTHENTICATED` does not affect the `auth` macro.** The macro in `src/pages/user.tsx`
   returns 401 unless a valid JWT cookie is present. The flag is read only by `GET /`
   (`src/pages/root.tsx`), which mints a synthetic identity, sets the `auth` cookie, inserts a
   `jobs` row, and sets the `jobId` cookie. **An API client that never issues `GET /` is
   unauthenticated and gets 401 everywhere.**
2. **`GET /` re-mints identity on every request** — it does not check for an existing valid cookie.
   Under `UNAUTHENTICATED_USER_SHARING=true` the id is always `0`, so re-minting is harmless;
   otherwise it is `randomInt(2^24, ~2^48)` and every prior job becomes unreachable.
3. **Synthetic users have no `users` row.** `root.tsx` deliberately skips the existence check for
   ids ≥ 2^24.
4. **SQLite foreign keys are NOT enforced.** `db.ts` executes only `PRAGMA journal_mode = WAL`
   (:50); SQLite defaults `foreign_keys` **off**. The `FOREIGN KEY (user_id) REFERENCES users(id)`
   on `jobs` (:30) is therefore inert. **This is the only reason fact (3) works** — inserting a job
   for a nonexistent user 0 succeeds. An implementer who "hardens" the pragmas breaks
   unauthenticated mode entirely with a constraint error.
5. **Cookies are `Secure` unless `HTTP_ALLOWED=true`** (`secure: !HTTP_ALLOWED` in `user.tsx` and
   `root.tsx`; default false). Over plain HTTP the browser discards them silently.
6. **`JWT_SECRET` defaults to a per-process `randomUUID()`** — a container restart invalidates all
   sessions. Auth cookie `maxAge` is 7 days on login (`user.tsx:230,355`) and 24 hours for the
   unauthenticated mint in `root.tsx`.
7. **The upstream `auth` macro's 401 body is `{ success: false, message: "Unauthorized" }`**
   (`user.tsx:48-49,55-56`). The API's error envelope must match this shape — see §5.
8. **`POST /upload` and `POST /convert` signal errors with `302 → /`.** `fetch()` follows redirects,
   so a JSON client receives HTTP 200 containing ConvertX's homepage HTML. (Narrower than it looks:
   `results.tsx` 404s and `download.tsx` redirects to `/results` — but the two routes this design
   would otherwise have reused are both 302-to-root.)
9. **`POST /upload` binds to the `jobId` cookie**, not a parameter — two concurrent tabs clobber
   each other's job binding.
10. **`POST /convert` fires `handleConvert()` without awaiting it** and sets `jobs.status` to
    `'completed'` in `.then()`. `mainConverter` never rejects, so **a job in which every file failed
    still reads `'completed'`.** Note the completed-update is *not* unconditional: the
    `query.run()` inside `handleConvert` can throw, rejecting the wrapper, aborting `Promise.all`,
    and leaving the job `'pending'` with no row — see fact (14).
11. **`file_names` rows are inserted only when a file finishes** (success or failure). There is no
    in-progress row and no per-file percentage. Progress is `count(file_names) / jobs.num_files`.
12. **Conversion status strings are a closed failure set — by convention, not by contract.**
    `mainConverter` returns `"Done"` (`main.ts:249`), or a converter-supplied string (`:246`), or
    one of exactly two failures: `"File type not supported"` (`:234`) and `"Failed, check logs"`
    (`:255`). All 20 converters' failure paths `reject()`, so they funnel into "Failed, check logs".
    Real stderr goes to `console.error` inside the container only.
    **Caveats:** the only non-`"Done"` successes on current main are ffmpeg's
    `"Done: resized to 256x256"` and msgconvert's `resolve(targetPath)` (a file path rendered as a
    status). `vcf.ts` returns `"Done"` after writing an **empty** CSV for unparseable input — "Done"
    is not proof of useful output. Nothing upstream enforces the closed set: no type, no test. A
    future converter that catches its own error and *returns* a message would be misclassified as
    success. **Re-verify this set at every rebase**; §8 pins it as an integration-test tripwire.
13. **`finished_files` and `files_detailed` on the `Jobs` class are NOT columns — they are computed
    view-model fields**, populated at read time by `history.tsx:27-28`
    (`job.finished_files = files.length; job.files_detailed = files;`) and rendered at :176/:205.
    Do not remove them when preparing the upstream PR. **This is the pattern
    `GET /api/v1/jobs/:id` should mirror.**
14. **If the Bun process dies mid-job, `jobs.status` stays `'pending'` forever.** Nothing
    server-side ever transitions it.
15. **File type detection is extension-only.** `fileName.split(".").pop()`, then
    `normalizeFiletype()`. Consequences: `.tar.gz` → `gz`; no extension → `""` →
    `getPossibleTargets("")` → `{}` (empty, no error); the literal extension `unknown` → `m4a`.
16. **`handleConvert()`'s last parameter is typed `Cookie<string | undefined>`**, not a string. It
    touches exactly one member — `.value`, twice (the guard and `query.run()`). A minimal fake
    object is therefore sufficient; see §5.
17. **`AUTO_DELETE_EVERY_N_HOURS` (default 24) deletes by `date_created` and runs at startup.**
18. **Post-conversion cleanup of uploads is commented out** (`convert.tsx`:
    `// rmSync(userUploadsDir, …)`), so every uploaded original persists until the sweep.
19. **`GET /healthcheck` is `auth: false`** and returns `{ status: "ok" }`. **It lives at
    `/healthcheck`, NOT under any `/api` prefix** — see §5, which adds an aliased route.
20. **The upstream UI polls `GET /progress/:jobId` every 1000 ms** (`public/results.js:9,18`).
    Adopt the same interval.
21. **`POST /conversions` is unauthenticated; `GET /converters` is `auth: true`**
    (`chooseConverter.tsx`, `listConverters.tsx:72`). Other unauthenticated routes exist
    (`/healthcheck`, `/setup`, `/login`, `/register`, static assets) — the point is only that the
    two capability routes differ in policy, and §5 preserves that difference.
22. **The container runs `bun run dist/src/index.js` — the bundled build.** A route file that is
    added but never imported by `index.tsx` silently vanishes from the image.
23. **`GET /archive/:jobId` builds its tar synchronously during the request.** (Batch-only;
    deferred.)

### it-tools (`main`, commit `d505845`)

24. **`vite.config.ts` uses `VitePWA({ strategies: 'generateSW' })` with no workbox overrides.**
    `vite-plugin-pwa@0.16.0` defaults `navigateFallback: 'index.html'` (`src/options.ts:82`),
    producing a `NavigationRoute` matching all same-origin navigations. **Navigation-initiated
    downloads would be answered with the SPA shell**, and only for visitors who already have the
    service worker installed. `src/main.ts:17` registers the SW **unconditionally**, which also
    affects e2e — see §8.
25. **`nginx.conf` is the stock 10-line SPA config** — no `client_max_body_size`, so nginx's 1 MB
    default applies to proxied uploads. ConvertX itself sets
    `maxRequestBodySize: Number.MAX_SAFE_INTEGER`.
26. **`src/config.ts` uses `figue` over `import.meta.env`** — all `VITE_*` values are baked at build
    time. The it-tools Dockerfile has no `ARG`/`ENV` plumbing for them.
27. **`toolsByCategory` in `src/tools/index.ts` is a module-scope array** — filtering it is possible
    but build-time only.
28. **`tools.store.ts` resolves names via `t('tools.<path>.title', tool.name)`** — the raw name is
    the fallback, so English requires no locale edits. Search is `fuse.js@^6.6.2` over `keywords`.
29. **`pnpm build` runs `vue-tsc --noEmit && vite build`.** Strictness is inherited from
    `@vue/tsconfig`; `tsconfig.app.json` never sets `strict` itself, so changing the base package
    would silently relax it.
30. **The e2e workflow builds, runs `vite preview` (:5050), and shards Playwright 3 ways** — and
    each shard runs **three browser projects** (chromium, firefox, webkit). Test discovery is
    `testDir: './src'`, `testMatch: /\.e2e\.(spec\.)?ts$/`.

---

## 4. Architecture

```
┌─ browser ─────────────────────────────────────────┐
│  it-tools SPA  ──fetch──►  /api/v1/*              │
└───────────────────────────────────────────────────┘
                              │  (same origin)
┌─ it-tools container ────────▼─────────────────────┐
│  nginx  ·  /        → static dist/                │
│           /api/v1/  → proxy_pass convertx:3000    │
└───────────────────────────────────────────────────┘
                              │  (docker network only)
┌─ convertx container ────────▼─────────────────────┐
│  Bun + Elysia  ·  api.tsx  ·  apiSession.tsx      │
│  SQLite  ·  ~25 native converter binaries         │
│  NO published ports                               │
└───────────────────────────────────────────────────┘
```

ConvertX publishes **no ports** and nginx proxies only `/api/v1/`, so ConvertX's HTML UI is not
reachable from a browser. This is **surface reduction, not a structural guarantee**: any container
on the compose network (including it-tools itself) or anyone with Docker host access can still
`curl convertx:3000/`. It matters less than it appears — under D6 the identity is always `0`, so
re-minting per fact (2) is harmless anyway. The real benefit is preventing LAN users from driving
the HTML UI against shared jobs.

### Repository layout

```
it-tools/                              origin=fork, upstream=CorentinTh/it-tools
├── src/tools/file-converter/
│   ├── index.ts
│   ├── file-converter.vue
│   ├── useConvertX.ts
│   ├── convertx.service.ts
│   └── file-converter.e2e.spec.ts
├── src/config.ts                      + VITE_CONVERTX_URL in the figue schema
├── services/convertx/                 submodule → fork, upstream=C4illin/ConvertX
│   └── src/pages/{api,apiSession}.tsx
├── compose.yaml
├── nginx.conf                         + one location block
├── vite.config.ts                     + navigateFallbackDenylist
├── playwright.config.ts               + serviceWorkers: 'block'
├── Dockerfile                         + ARG and ENV VITE_CONVERTX_URL
└── LICENSING.md
```

**Submodule pin policy.** The `json-api` branch is force-pushed freely on rebase. Each
rebased-and-verified state is **tagged** (`json-api-YYYY-MM-DD`), and the umbrella repo pins the
tag's commit. Tags are never rewritten, so the recorded submodule SHA never dangles.

---

## 5. ConvertX fork: the JSON API

Two new files plus two added lines in `src/index.tsx` (`.use(api).use(apiSession)`). Fact (22): the
`.use()` calls are not optional wiring — without the import the files are absent from the image.

- **`src/pages/api.tsx`** — upstreamable. Every route uses the existing `auth` macro. No schema
  changes. Respects `WEBROOT`.
- **`src/pages/apiSession.tsx`** — fork-only. All unauthenticated-mode assumptions live here so
  upstream can drop this file without touching the API.

### Contract

| Method | Route | Auth | Body | Returns |
|---|---|---|---|---|
| GET | `/api/v1/healthcheck` | no | — | `{ status: "ok" }` |
| POST | `/api/v1/session` | no | — | `{ userId }` |
| GET | `/api/v1/converters` | **yes** | — | `{ [converter]: string[] }` |
| POST | `/api/v1/targets` | no | `{ fileType }` | `{ [converter]: string[] }` |
| POST | `/api/v1/jobs` | yes | — | `{ jobId }` |
| POST | `/api/v1/jobs/:id/files` | yes | multipart, field `file` | `{ files: [{ name }] }` |
| POST | `/api/v1/jobs/:id/convert` | yes | `{ target, converter, fileNames }` | `{ accepted: true }` |
| GET | `/api/v1/jobs/:id` | yes | — | `{ status, numFiles, files: [{ fileName, outputFileName, status }] }` |
| GET | `/api/v1/jobs/:id/files/:name` | yes | — | binary |

`GET /api/v1/healthcheck` is an alias of upstream's `/healthcheck` (fact 19). It exists because
nginx proxies only `/api/v1/` — a probe to an unproxied path falls through to
`try_files … /index.html` and returns **200 with the SPA shell**, i.e. a false "healthy" in exactly
the situation the probe exists to detect.

Auth policy mirrors upstream exactly (fact 21) rather than inventing a new one:
`POST /api/v1/targets` open, `GET /api/v1/converters` authenticated.

`GET /api/v1/jobs/:id`'s `status` field is **informational only** — mirrored from `jobs.status` for
debugging. Completion is `files.length === numFiles`; per fact (10) `status` lies about success.

### Error envelope

```ts
{ success: false, message: string }
```

Chosen to match the upstream `auth` macro's existing 401 body verbatim (fact 7), so the macro's own
responses are already conformant and api.tsx stays purely additive. Every route returns this shape
with a truthful status code. **No redirects** — that is the specific defect in fact (8).

### Rules

- **`jobId` is a path parameter, never a cookie** — resolves fact (9). Every route re-checks
  ownership (`WHERE id = ? AND user_id = ?`) exactly as `upload.tsx` does. Note that under D6 this
  check is not a security boundary (see §2).
- **`POST /api/v1/session` reuses a valid `auth` cookie and mints only when absent or invalid** —
  the opposite of fact (2). Under D6 the minted id is always `0`. When `ALLOW_UNAUTHENTICATED` is
  false it returns 401 and mints nothing.
- **`POST /api/v1/jobs` must read the new id from `run()`'s `lastInsertRowid`.** Do **not** copy
  `root.tsx`'s `INSERT` + `SELECT … ORDER BY id DESC` — under a single shared user id that is a
  live race between concurrent job creations.
- **Jobs are single-use.** One `POST /api/v1/jobs` per conversion. A second convert on the same job
  overwrites `num_files` while `file_names` keeps accumulating, permanently breaking the completion
  check.
- **`POST /api/v1/jobs/:id/files` returns the stored (sanitized) names**, and the client must echo
  exactly those into `/convert`'s `fileNames`. The server sanitizes with `sanitize-filename` on both
  upload and convert; sending the local name instead desynchronizes them.
- **`GET /api/v1/jobs/:id`** assembles its `files` array using the `history.tsx:27-28` pattern
  (fact 13).
- **`handleConvert()` is called with `{ value: jobId } as unknown as Cookie<string | undefined>`.**
  Verified sufficient — it touches only `.value` (fact 16). Deliberate: it keeps the patch purely
  additive and conflict-free. Correcting that signature to accept a string belongs in the upstream
  PR, not in the fork.

---

## 6. it-tools: the tool

Registered unconditionally in `src/tools/index.ts` under **Converter**, with keywords covering
common formats (`mp4`, `docx`, `epub`, `heic`, `svg`, `webp`, `pdf`, …) so the Fuse.js search finds
it by format name (fact 28). English strings rely on `t(key, fallback)`; locale files are not edited
for the MVP.

Unconditional registration is deliberate. Build-time `VITE_*` values (fact 26) cannot express
runtime availability, so the tool always appears and probes on mount. This keeps the fork building
and deploying as a plain static site, and keeps `vue-tsc` and e2e deterministic.

### Call sequence (happy path)

```
mount
  → GET  /api/v1/healthcheck          must parse JSON; 200 that isn't {"status":"ok"}
                                       (e.g. the SPA shell) ⟹ unreachable, as is 502
  → POST /api/v1/session              REQUIRED before any authenticated route
  → GET  /api/v1/converters           capability browser data (authenticated)
user drops file
  → POST /api/v1/targets              { fileType } from the extension
user picks target
  → POST /api/v1/jobs                 → { jobId }
  → POST /api/v1/jobs/:id/files       multipart, field `file` → stored names
  → POST /api/v1/jobs/:id/convert     { target, converter, fileNames: <stored names> }
  → GET  /api/v1/jobs/:id             poll every 1000 ms
done
  → GET  /api/v1/jobs/:id/files/:name encodeURIComponent the :name segment
```

**`POST /api/v1/session` on mount is mandatory** — every authenticated route 401s without it
(fact 1), including the capability browser. On any subsequent 401 the client re-calls `/session`
**once** and retries the failed request **once**; a second failure surfaces as an error. Session
expiry is harmless under D6 (the id is always `0`), but the retry path must exist.

`encodeURIComponent()` on the download `:name` segment is required — upstream fixed exactly this
encoding bug in PR #587.

### Progress semantics

```
done      ⟺ files.length === numFiles          (never trust jobs.status — fact 10)
failed    ⟺ status ∈ { "Failed, check logs", "File type not supported" }
succeeded ⟺ any other status, including "Done" and converter-supplied messages
expired   ⟺ 404 after a prior success (fact 17) — reported as expiry, not error
```

Poll interval **1000 ms**, matching upstream (fact 20).

**Stall handling.** For a single-file job there are zero rows until it completes (fact 11), so
"stalled" and "slow TeX/LibreOffice conversion" are observationally identical. The client therefore
uses a **10-minute soft timeout** that surfaces a *"still waiting — keep waiting?"* affordance and
continues polling if the user agrees. It must not hard-fail a job that may simply be slow.

### States handled

| State | Behavior |
|---|---|
| Backend unreachable | Designed empty state naming the configured URL |
| Backend up, `ALLOW_UNAUTHENTICATED=false` | `/session` 401s → "this backend requires a ConvertX account; not supported in the MVP" — distinguishable from unreachable only because the health probe succeeded |
| No/unknown extension | Manual format picker — `getPossibleTargets("")` returns `{}` silently (fact 15) |
| Zero targets for type | Explain, and link to the capability panel |
| Conversion failed | Surface the status string verbatim, plus "details are in the ConvertX container log" (fact 12) |
| Stalled | Soft timeout with a keep-waiting affordance |
| Expired | "Converted files are kept ~24 hours" |

### Implementation notes

- **Downloads use `fetch()` + `Blob` + `URL.createObjectURL`**, never `window.location` or
  `window.open`. Subresource fetches bypass the service worker's `NavigationRoute` entirely
  (fact 24). `navigateFallbackDenylist: [/^\/api\//]` in `vite.config.ts` is the second layer.
  Already-installed service workers keep the old behavior until the new one activates.
- **Drag/drop uses the repo's own `c-file-upload`** (`src/ui/c-file-upload/c-file-upload.vue`),
  which already implements drop-zone handling and emits `fileUpload`/`filesUpload`. It is the
  established it-tools pattern (see `base64-file-converter.vue`); do not hand-roll a dropzone or
  reach for naive-ui's `n-upload`.
- **`convertx.service.ts` establishes it-tools' first HTTP layer**: typed responses,
  `AbortController` timeouts, the `{ success, message }` envelope, and the 401-retry policy above.
- **The capability browser is a secondary panel inside this tool**, not a second tool card, and is
  fed by `GET /api/v1/converters`. It doubles as the answer to "why does my file have no targets?"
- `VITE_CONVERTX_URL` (default `/api/v1`) is added to the figue schema in `src/config.ts`.

---

## 7. Deployment

### `nginx.conf`

```nginx
location / { try_files $uri $uri/ /index.html; }

location /api/v1/ {
    proxy_pass http://convertx:3000;
    proxy_set_header Host $host;
    client_max_body_size 2g;        # 1 MB default would 413 every real upload (fact 25)
    proxy_request_buffering off;    # stream uploads rather than spooling first
}
```

One location block only — moving downloads under `/api/v1/jobs/:id/files/:name` removed the need to
proxy `/download` and `/archive`.

Timeouts are deliberately **not** raised. No MVP route holds a response near nginx's 60 s default:
`/convert` returns immediately (fact 10), downloads stream, and `proxy_read/send_timeout` measure
gaps between reads, not totals. Raising them becomes necessary only if `/archive` is un-deferred
(fact 23).

**Operational note:** `proxy_pass http://convertx:3000` makes nginx resolve the hostname **at
startup** — if the convertx container is absent, nginx exits with "host not found in upstream".
`depends_on` covers a normal `compose up`; partial-stack starts and crash-loops will take nginx down
with it.

### `compose.yaml`

```yaml
services:
  it-tools:
    build: .
    ports: ["8080:80"]
    depends_on: [convertx]
    restart: unless-stopped

  convertx:
    build: ./services/convertx
    # no ports: — reachable only via nginx (see §4: surface reduction, not a guarantee)
    environment:
      - ALLOW_UNAUTHENTICATED=true
      - UNAUTHENTICATED_USER_SHARING=true
      - HTTP_ALLOWED=true
      - JWT_SECRET=${JWT_SECRET:?set JWT_SECRET in .env}
      - AUTO_DELETE_EVERY_N_HOURS=24
    volumes: ["./data:/app/data"]
    restart: unless-stopped
```

`HTTP_ALLOWED=true` is required by fact (5), not optional. `JWT_SECRET` comes from an uncommitted
`.env`; `:?` fails the stack loudly rather than silently regenerating per restart (fact 6).

**Disk growth.** Uploaded originals are never deleted post-conversion (fact 18), so with
`client_max_body_size 2g` under one shared id, both originals and outputs accumulate until the
≤24 h sweep. Accepted and documented rather than patched — uncommenting upstream's `rmSync` would
add rebase friction for a homelab-scale problem.

### Build cost

Verified stage graph: `release` = `FROM base` → apt (25 packages) → pipx markitdown → vtracer curl →
**then** `COPY --from=install` and `COPY --from=prerelease`. A src-only rebase re-runs `bun run
build` in `prerelease` plus the final copies while the apt layer stays cached — first build is tens
of minutes and several GB, subsequent rebuilds are minutes.

Caveats: (a) `debian:testing-slim` is a floating tag, so any base re-pull invalidates everything —
and Debian *testing* apt can be transiently broken independent of your changes; (b) the vtracer
layer curls GitHub at build time (pinned 0.6.4, network dependency); (c) do not prune the build
cache; (d) an upstream bun-version bump in `base` invalidates all of it.

`ARG VITE_CONVERTX_URL` **and** a matching `ENV` are added to the it-tools Dockerfile — Vite reads
the value from the environment at `pnpm build`, so `ARG` alone is insufficient. Changing it still
requires an image rebuild (fact 26).

---

## 8. Testing

| Layer | Tool | Covers |
|---|---|---|
| Unit | vitest | `convertx.service.ts`: the closed failure set, `files.length === numFiles`, the `{success,message}` envelope, 401-retry, abort/timeout. `useConvertX.ts`: state transitions |
| Integration | `bun test` in the fork | `api.tsx` against a temp SQLite: ownership checks, session reuse-vs-mint, `lastInsertRowid`, single-use job enforcement, error envelopes — **plus a tripwire asserting the fact-(12) failure set is still exactly two strings** |
| E2E | Playwright | `file-converter.e2e.spec.ts` with `page.route()` mocking `/api/v1/*`: happy path, failure-string path, backend-unreachable state |
| Manual | documented checklist | One real conversion per converter family (ffmpeg / LibreOffice / ImageMagick / pandoc) |

**The failure-set tripwire must live in the fork's integration tests, not it-tools' unit tests** —
only the former runs against real upstream code and can detect drift at rebase time.

**Playwright requires `serviceWorkers: 'block'`.** `src/main.ts:17` registers the SW
unconditionally (fact 24), so the `vite preview` build the e2e suite runs against installs one, and
`page.route()` does not intercept requests mediated by a service worker. Without the block, mocks
work on first load and go flaky after activation. *(This is Playwright's documented limitation, not
something reproduced locally.)* Mocks must also work across all three browser projects (fact 30).

**Upstream CI compatibility:** tests for `apiSession.tsx` must live in a separate spec file that
stays in the fork. `api.tsx`'s tests must not import it, or the upstream PR won't build.

The manual layer is not optional bookkeeping: **nothing in CI exercises the native binaries**, which
are the entire point of the integration.

Coverage target is 80% per project standards, measured on the it-tools side.

---

## 9. Out of scope (MVP)

- Multi-file batch conversion and `/archive` tar download — additive; backend already supports it
- Job history UI
- Real ConvertX accounts / login
- Cross-origin deployment — requires CORS and `SameSite=None` changes in the fork; **not** reachable
  by configuration
- Structured per-file error text — would require a `file_names` schema change and deliberate rebase
  friction
- Rate limiting (see §2)
- Editing the nine `locales/*.yml` files

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Any LAN client can read every converted file (D6) | Accepted for trusted LAN; documented in README; revisit before any wider exposure |
| ConvertX moves weekly; the fork rots | Patch is 2 new files + 2 lines. Tagged rebases. Upstreaming (D7) would eliminate it |
| Fact-(12) failure set drifts upstream | Integration-test tripwire in the fork |
| First image build is long and multi-GB | Layer cache makes subsequent rebuilds cheap; documented |
| `debian:testing` base breaks a rebuild independently of our changes | Known; rebuild from a known-good cache or wait it out |
| nginx exits if convertx is absent at startup | `depends_on`; documented for partial-stack starts |
| Disk growth between sweeps | Documented; `AUTO_DELETE_EVERY_N_HOURS` tunable |
| Backend URL change needs a rebuild | Accepted; `ARG`+`ENV` avoids a source edit |
| `handleConvert` cast breaks on upstream type change | Caught by integration tests at rebase time |
| Legal reading unverified | Stated as such in `LICENSING.md` |

---

## 11. Next step

Implementation plan via the writing-plans skill.
