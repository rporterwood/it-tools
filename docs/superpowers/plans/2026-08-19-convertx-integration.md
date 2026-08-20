# ConvertX Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native it-tools "File Converter" tool that converts files through a forked ConvertX backend running alongside it in a Docker Compose stack.

**Architecture:** Two services behind one nginx. nginx serves the it-tools static SPA at `/` and reverse-proxies `/api/v1/` to a ConvertX container that publishes no ports. The ConvertX fork gains a purely additive JSON API (`api.tsx`, upstreamable) plus a fork-only unauthenticated session bootstrap (`apiSession.tsx`). The Vue tool talks to that API over same-origin `fetch`, so cookies work without CORS.

**Tech Stack:** Vue 3 + Vite + pnpm + naive-ui + UnoCSS (it-tools); Bun + Elysia + SQLite + `@kitajs/html` (ConvertX); vitest, Playwright, `bun test`; Docker Compose + nginx.

**Spec:** `docs/superpowers/specs/2026-08-19-convertx-integration-design.md`

## Global Constraints

- Every ConvertX API change must be **additive**: two new files (`src/pages/api.tsx`, `src/pages/apiSession.tsx`) plus exactly two added lines in `src/index.tsx`. No edits to existing route files, no schema changes.
- **Do not add `PRAGMA foreign_keys = ON`.** FK enforcement being off is the only reason synthetic user `0` works (spec fact 4).
- Error envelope is exactly `{ success: false, message: string }` — matches upstream's existing 401 body (spec fact 7).
- Completion is `files.length === numFiles`. **Never** branch on `jobs.status` (spec fact 10).
- The failure set is exactly `"Failed, check logs"` and `"File type not supported"`. Everything else is success (spec fact 12).
- Poll interval: **1000 ms**. Stall soft-timeout: **10 minutes**, with a keep-waiting affordance — never a hard fail.
- `HTTP_ALLOWED=true` and `UNAUTHENTICATED_USER_SHARING=true` are required in compose, not optional (spec facts 5, D6).
- Route files must be imported by `index.tsx` or they vanish from the bundled image (spec fact 22).
- it-tools auto-imports `vue`, `vue-router`, `@vueuse/core`, `vue-i18n` — do not write those imports.
- Playwright `testIdAttribute` is `data-test-id`.
- it-tools commits use conventional-commit prefixes. Commit messages longer than one line go through `git commit -F <file>`, never a heredoc.

---

### Task 1: Fork remotes and ConvertX submodule

**Files:**
- Create: `.gitmodules` (via `git submodule add`)
- Create: `services/convertx/` (submodule)

**Interfaces:**
- Consumes: nothing
- Produces: a working `services/convertx` checkout on branch `json-api`, with `upstream` pointing at `C4illin/ConvertX`

- [ ] **Step 1: Point this repo's remotes at your fork**

Create the fork on GitHub first (`gh repo fork CorentinTh/it-tools --remote=false` or via the web UI), then:

```bash
git remote rename origin upstream
git remote add origin git@github.com:YOURNAME/it-tools.git
git remote -v
```

Expected: `upstream` → `CorentinTh/it-tools`, `origin` → your fork.

- [ ] **Step 2: Fork ConvertX and add it as a submodule**

```bash
gh repo fork C4illin/ConvertX --clone=false
git submodule add git@github.com:YOURNAME/ConvertX.git services/convertx
cd services/convertx
git remote add upstream https://github.com/C4illin/ConvertX.git
git fetch upstream
git checkout -b json-api upstream/main
cd ../..
```

- [ ] **Step 3: Verify the submodule builds before you change anything**

```bash
cd services/convertx && bun install && bun run lint:tsc && cd ../..
```

Expected: PASS. If this fails, the fork is broken before your patch — fix that first, otherwise you will misattribute the failure to your own code later.

- [ ] **Step 4: Commit**

```bash
git add .gitmodules services/convertx
git commit -m "chore: add ConvertX fork as services/convertx submodule"
```

---

### Task 2: ConvertX API — session bootstrap and healthcheck alias

This is the foundation: every other authenticated route is unreachable without it (spec fact 1).

**Files:**
- Create: `services/convertx/src/pages/api.tsx`
- Create: `services/convertx/src/pages/apiSession.tsx`
- Modify: `services/convertx/src/index.tsx` (add two `.use()` calls)
- Test: `services/convertx/tests/api/session.test.ts`

**Interfaces:**
- Consumes: `userService` (exports the `auth` macro and `jwt`), `ALLOW_UNAUTHENTICATED` / `UNAUTHENTICATED_USER_SHARING` from `../helpers/env`, `db` from `../db/db`
- Produces: `export const api` and `export const apiSession`, both `Elysia` instances; routes `GET /api/v1/healthcheck` and `POST /api/v1/session`

- [ ] **Step 1: Write the failing test**

Create `services/convertx/tests/api/session.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { api } from "../../src/pages/api";
import { apiSession } from "../../src/pages/apiSession";

const app = api.use(apiSession);

describe("GET /api/v1/healthcheck", () => {
  it("returns ok without auth", async () => {
    const res = await app.handle(new Request("http://localhost/api/v1/healthcheck"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /api/v1/session", () => {
  it("mints a session and returns userId 0 when sharing is enabled", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/session", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 0 });
    expect(res.headers.get("set-cookie")).toContain("auth=");
  });

  it("reuses an existing valid auth cookie instead of re-minting", async () => {
    const first = await app.handle(
      new Request("http://localhost/api/v1/session", { method: "POST" }),
    );
    const cookie = first.headers.get("set-cookie")!.split(";")[0];

    const second = await app.handle(
      new Request("http://localhost/api/v1/session", {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ userId: 0 });
    expect(second.headers.get("set-cookie")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/convertx && JWT_SECRET=test-secret bun test tests/api/session.test.ts
```

Expected: FAIL — cannot resolve `../../src/pages/api`.

- [ ] **Step 3: Create `api.tsx` with the healthcheck alias**

`services/convertx/src/pages/api.tsx`:

```tsx
import { Elysia } from "elysia";
import { userService } from "./user";

export const api = new Elysia({ prefix: "/api/v1" })
  .use(userService)
  .get("/healthcheck", () => ({ status: "ok" }), { auth: false });
```

The alias exists because nginx proxies only `/api/v1/`; a probe to the unproxied `/healthcheck` would fall through to the SPA and return 200 with HTML — a false "healthy" (spec §5).

- [ ] **Step 4: Create `apiSession.tsx`**

`services/convertx/src/pages/apiSession.tsx`:

```tsx
import { randomInt } from "node:crypto";
import { Elysia } from "elysia";
import { ALLOW_UNAUTHENTICATED, HTTP_ALLOWED, UNAUTHENTICATED_USER_SHARING } from "../helpers/env";
import { userService } from "./user";

/**
 * Fork-only. Every unauthenticated-mode assumption lives here so that
 * api.tsx stays upstreamable. Upstream can delete this file untouched.
 */
export const apiSession = new Elysia({ prefix: "/api/v1" }).use(userService).post(
  "/session",
  async ({ jwt, cookie: { auth }, set }) => {
    if (auth?.value) {
      const existing = await jwt.verify(auth.value);
      if (existing) {
        return { userId: Number(existing.id) };
      }
    }

    if (!ALLOW_UNAUTHENTICATED) {
      set.status = 401;
      return { success: false, message: "Unauthorized" };
    }

    // Mirrors root.tsx:38 exactly. Two things matter and both are load-bearing:
    // (1) randomInt is a CSPRNG — this id IS the authorization identity scoping every job,
    //     so Math.random() would make it guessable;
    // (2) the range starts at 2**24 because ids BELOW that are upstream's real-account space
    //     (see the guard at root.tsx:65). Generating into [0, 2**24) inverts the convention
    //     and shrinks the space enough for birthday collisions at a few thousand users.
    const userId = UNAUTHENTICATED_USER_SHARING
      ? 0
      : randomInt(2 ** 24, Math.min(2 ** 48 + 2 ** 24 - 1, Number.MAX_SAFE_INTEGER));
    const token = await jwt.sign({ id: String(userId) });

    auth.set({
      value: token,
      httpOnly: true,
      secure: !HTTP_ALLOWED,
      sameSite: "strict",
      maxAge: 60 * 60 * 24,
      path: "/",
    });

    return { userId };
  },
  { auth: false },
);
```

Note the reuse-before-mint order — the opposite of `root.tsx`, which re-mints unconditionally (spec fact 2).

- [ ] **Step 5: Wire both into `index.tsx`**

In `services/convertx/src/index.tsx`, add the imports alongside the existing page imports and two `.use()` calls in the chain (next to `.use(healthcheck)`):

```tsx
import { api } from "./pages/api";
import { apiSession } from "./pages/apiSession";
// ...
  .use(api)
  .use(apiSession)
```

Without these the files are absent from the bundled image entirely (spec fact 22).

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd services/convertx && JWT_SECRET=test-secret bun test tests/api/session.test.ts && bun run lint:tsc
```

Expected: 3 pass, typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd services/convertx
git add src/pages/api.tsx src/pages/apiSession.tsx src/index.tsx tests/api/session.test.ts
git commit -m "feat(api): add JSON API healthcheck and session bootstrap"
```

> **Upstream-portability rule.** `tests/api/session.test.ts` is the *only* test file allowed to
> import `apiSession`, because that file stays in the fork forever. Every other API test must obtain
> its auth cookie from the helper built in Task 3 — if `api.tsx`'s tests import `apiSession`, the
> upstream PR cannot build (spec §8).

---

### Task 3: ConvertX API — capability routes

**Files:**
- Modify: `services/convertx/src/pages/api.tsx`
- Test: `services/convertx/tests/api/capabilities.test.ts`

**Interfaces:**
- Consumes: `getAllTargets()`, `getPossibleTargets(fileType)` from `../converters/main`
- Produces: `GET /api/v1/converters` (auth), `POST /api/v1/targets` (no auth)
- Produces: `authCookie(): Promise<string>` from `tests/api/helpers/auth.ts` — used by Tasks 4, 5, 6

- [ ] **Step 1: Write the auth helper**

`services/convertx/tests/api/helpers/auth.ts`. This signs a JWT directly rather than calling
`/api/v1/session`, which is what keeps every `api.tsx` test free of any `apiSession` import.

```ts
import { jwt } from "@elysiajs/jwt";
import { Elysia } from "elysia";

const signer = new Elysia()
  .use(jwt({ name: "jwt", secret: process.env.JWT_SECRET as string }))
  .get("/sign", ({ jwt }) => jwt.sign({ id: "0" }));

export async function authCookie(): Promise<string> {
  const res = await signer.handle(new Request("http://localhost/sign"));
  return `auth=${await res.text()}`;
}
```

`JWT_SECRET` must be set for the helper and the app under test to agree — otherwise `userService`
falls back to a per-process `randomUUID()` (spec fact 6) and every token fails verification. All
test commands below therefore set it explicitly.

- [ ] **Step 2: Write the failing test**

`services/convertx/tests/api/capabilities.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { api } from "../../src/pages/api";
import { authCookie } from "./helpers/auth";

const app = api;

describe("POST /api/v1/targets", () => {
  it("returns converters for png without auth", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/targets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileType: "png" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string[]>;
    expect(Object.keys(body).length).toBeGreaterThan(0);
  });

  it("returns an empty object for an unknown type rather than erroring", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/targets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileType: "" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});

describe("GET /api/v1/converters", () => {
  it("401s without a session", async () => {
    const res = await app.handle(new Request("http://localhost/api/v1/converters"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, message: "Unauthorized" });
  });

  it("lists all converters with a session", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/converters", {
        headers: { cookie: await authCookie() },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string[]>;
    expect(body.ffmpeg).toBeDefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd services/convertx && JWT_SECRET=test-secret bun test tests/api/capabilities.test.ts
```

Expected: FAIL — 404 on both routes.

- [ ] **Step 4: Add the routes to `api.tsx`**

Extend the chain in `services/convertx/src/pages/api.tsx`:

```tsx
import { Elysia, t } from "elysia";
import { getAllTargets, getPossibleTargets } from "../converters/main";
import { userService } from "./user";

export const api = new Elysia({ prefix: "/api/v1" })
  .use(userService)
  .get("/healthcheck", () => ({ status: "ok" }), { auth: false })
  .get("/converters", () => getAllTargets(), { auth: true })
  .post("/targets", ({ body }) => getPossibleTargets(body.fileType), {
    body: t.Object({ fileType: t.String() }),
    auth: false,
  });
```

Auth policy mirrors upstream exactly — `/conversions` is open, `/converters` is not (spec fact 21). Do not "fix" this asymmetry; matching upstream is what keeps the PR mergeable.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd services/convertx && JWT_SECRET=test-secret bun test tests/api/capabilities.test.ts
```

Expected: 4 pass.

- [ ] **Step 6: Commit**

```bash
cd services/convertx
git add src/pages/api.tsx tests/api/helpers/auth.ts tests/api/capabilities.test.ts
git commit -m "feat(api): add converter capability routes"
```

---

### Task 4: ConvertX API — job creation and file upload

**Files:**
- Modify: `services/convertx/src/pages/api.tsx`
- Test: `services/convertx/tests/api/jobs.test.ts`

**Interfaces:**
- Consumes: `db`, `uploadsDir` from `..`, `sanitize` from `sanitize-filename`
- Produces: `POST /api/v1/jobs` → `{ jobId: number }`; `POST /api/v1/jobs/:id/files` → `{ files: [{ name: string }] }`

- [ ] **Step 1: Write the failing test**

`services/convertx/tests/api/jobs.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { api } from "../../src/pages/api";
import { authCookie } from "./helpers/auth";

const app = api;

describe("POST /api/v1/jobs", () => {
  it("401s without a session", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/jobs", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns a numeric jobId", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/jobs", {
        method: "POST",
        headers: { cookie: await authCookie() },
      }),
    );
    expect(res.status).toBe(200);
    const { jobId } = (await res.json()) as { jobId: number };
    expect(typeof jobId).toBe("number");
  });

  it("returns distinct ids for concurrent creates", async () => {
    const cookie = await authCookie();
    const [a, b] = await Promise.all([
      app.handle(new Request("http://localhost/api/v1/jobs", { method: "POST", headers: { cookie } })),
      app.handle(new Request("http://localhost/api/v1/jobs", { method: "POST", headers: { cookie } })),
    ]);
    const idA = ((await a.json()) as { jobId: number }).jobId;
    const idB = ((await b.json()) as { jobId: number }).jobId;
    expect(idA).not.toBe(idB);
  });
});

describe("POST /api/v1/jobs/:id/files", () => {
  it("stores an uploaded file and returns its sanitized name", async () => {
    const cookie = await authCookie();
    const created = await app.handle(
      new Request("http://localhost/api/v1/jobs", { method: "POST", headers: { cookie } }),
    );
    const { jobId } = (await created.json()) as { jobId: number };

    const form = new FormData();
    form.append("file", new File(["hello"], "../evil name.txt", { type: "text/plain" }));

    const res = await app.handle(
      new Request(`http://localhost/api/v1/jobs/${jobId}/files`, {
        method: "POST",
        headers: { cookie },
        body: form,
      }),
    );
    expect(res.status).toBe(200);
    const { files } = (await res.json()) as { files: { name: string }[] };
    expect(files).toHaveLength(1);
    expect(files[0]!.name).not.toContain("..");
    expect(files[0]!.name).not.toContain("/");
  });

  it("404s for a job the caller does not own", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/jobs/999999/files", {
        method: "POST",
        headers: { cookie: await authCookie() },
        body: new FormData(),
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, message: "Job not found" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/convertx && JWT_SECRET=test-secret bun test tests/api/jobs.test.ts
```

Expected: FAIL — 404 on the job routes.

- [ ] **Step 3: Add the routes to `api.tsx`**

Add these imports and chain links:

```tsx
import { mkdir } from "node:fs/promises";
import sanitize from "sanitize-filename";
import { uploadsDir } from "..";
import db from "../db/db";
import { Jobs } from "../db/types";

// ... appended to the existing chain:
  .post(
    "/jobs",
    ({ user }) => {
      const result = db
        .query("INSERT INTO jobs (user_id, date_created, status, num_files) VALUES (?1, ?2, 'pending', 0)")
        .run(user.id, new Date().toISOString());

      return { jobId: Number(result.lastInsertRowid) };
    },
    { auth: true },
  )
  .post(
    "/jobs/:id/files",
    async ({ params, body, user, set }) => {
      const job = db
        .query("SELECT * FROM jobs WHERE id = ? AND user_id = ?")
        .as(Jobs)
        .get(params.id, user.id);

      if (!job) {
        set.status = 404;
        return { success: false, message: "Job not found" };
      }

      const dir = `${uploadsDir}${user.id}/${params.id}/`;
      await mkdir(dir, { recursive: true });

      const incoming = Array.isArray(body.file) ? body.file : [body.file];
      const names: { name: string }[] = [];

      for (const file of incoming) {
        const name = sanitize(file.name);
        await Bun.write(`${dir}${name}`, file);
        names.push({ name });
      }

      return { files: names };
    },
    { body: t.Object({ file: t.Files() }), auth: true },
  )
```

**Critical:** use `result.lastInsertRowid`. Do **not** copy `root.tsx`'s `INSERT` + `SELECT … ORDER BY id DESC` — under the single shared user id of D6 that is a live race.

**Do not claim the concurrency test guards this — it does not.** Verified: patching the racy pattern in and running the suite five times passes 6/6 every time. `Promise.all` around two `app.handle()` calls only interleaves at genuine `await` points, and both SQLite calls are synchronous, so JS run-to-completion semantics prevent the `INSERT`/`SELECT` pairs from ever interleaving inside one Bun process. Genuine coverage would need a multi-process or multi-connection load test, which is not worth the complexity here. Use a **source-level tripwire** instead (same shape as Task 5's failure-set test): assert `api.tsx` contains `lastInsertRowid` and does not contain `ORDER BY id DESC`. That is honest about being a lint-style guard rather than a behavioural one.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd services/convertx && JWT_SECRET=test-secret bun test tests/api/jobs.test.ts
```

Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
cd services/convertx
git add src/pages/api.tsx tests/api/jobs.test.ts
git commit -m "feat(api): add job creation and file upload routes"
```

---

### Task 5: ConvertX API — convert, status, and the failure-set tripwire

**Files:**
- Modify: `services/convertx/src/pages/api.tsx`
- Test: `services/convertx/tests/api/convert.test.ts`
- Test: `services/convertx/tests/api/failure-set.test.ts`

**Interfaces:**
- Consumes: `handleConvert()` from `../converters/main`, `outputDir` from `..`, `Filename` from `../db/types`
- Produces: `POST /api/v1/jobs/:id/convert` → `{ accepted: true }`; `GET /api/v1/jobs/:id` → `{ status, numFiles, files: [{ fileName, outputFileName, status }] }`

- [ ] **Step 1: Write the failing status test**

`services/convertx/tests/api/convert.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { api } from "../../src/pages/api";
import { authCookie as session } from "./helpers/auth";

const app = api;

async function newJob(cookie: string): Promise<number> {
  const res = await app.handle(
    new Request("http://localhost/api/v1/jobs", { method: "POST", headers: { cookie } }),
  );
  return ((await res.json()) as { jobId: number }).jobId;
}

describe("GET /api/v1/jobs/:id", () => {
  it("reports a fresh job as zero-of-zero with an empty file list", async () => {
    const cookie = await session();
    const jobId = await newJob(cookie);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/jobs/${jobId}`, { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { numFiles: number; files: unknown[] };
    expect(body.numFiles).toBe(0);
    expect(body.files).toEqual([]);
  });

  it("404s for an unknown job", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/jobs/999999", { headers: { cookie: await session() } }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/jobs/:id/convert", () => {
  it("rejects a target containing path separators", async () => {
    const cookie = await session();
    const jobId = await newJob(cookie);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/jobs/${jobId}/convert`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ target: "../etc", converter: "ffmpeg", fileNames: ["a.png"] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, message: "Invalid target" });
  });

  it("rejects an empty file list", async () => {
    const cookie = await session();
    const jobId = await newJob(cookie);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/jobs/${jobId}/convert`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ target: "jpg", converter: "ffmpeg", fileNames: [] }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Write the failure-set tripwire**

`services/convertx/tests/api/failure-set.test.ts`. This is a **rebase alarm**, not a feature test — if upstream adds a converter that returns an error string instead of rejecting, the client's "everything else is success" rule silently misclassifies it (spec fact 12).

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("conversion status failure set", () => {
  it("still contains exactly the two known failure strings", () => {
    const source = readFileSync("src/converters/main.ts", "utf8");
    const failures = [...source.matchAll(/return "([^"]*(?:Failed|not supported)[^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(failures.sort()).toEqual(["Failed, check logs", "File type not supported"]);
  });
});
```

If this fails after a rebase, **stop** and re-read `mainConverter` before touching anything else — the client's success/failure classification depends on it.

- [ ] **Step 3: Run both tests to verify they fail**

```bash
cd services/convertx && JWT_SECRET=test-secret bun test tests/api/convert.test.ts tests/api/failure-set.test.ts
```

Expected: convert tests FAIL (404); failure-set test PASSES immediately — that is correct, it is a regression alarm with nothing to implement.

- [ ] **Step 4: Add the routes to `api.tsx`**

```tsx
import type { Cookie } from "elysia";
import { handleConvert } from "../converters/main";
import { normalizeFiletype } from "../helpers/normalizeFiletype";
import { outputDir } from "..";
import { Filename } from "../db/types";

// ... appended to the existing chain:
  .get(
    "/jobs/:id",
    ({ params, user, set }) => {
      const job = db
        .query("SELECT * FROM jobs WHERE id = ? AND user_id = ?")
        .as(Jobs)
        .get(params.id, user.id);

      if (!job) {
        set.status = 404;
        return { success: false, message: "Job not found" };
      }

      // Same read-time assembly history.tsx uses (spec fact 13).
      const rows = db
        .query("SELECT * FROM file_names WHERE job_id = ?")
        .as(Filename)
        .all(job.id);

      return {
        // Informational only. Completion is files.length === numFiles.
        status: job.status,
        numFiles: job.num_files,
        files: rows.map((r) => ({
          fileName: r.file_name,
          outputFileName: r.output_file_name,
          status: r.status,
        })),
      };
    },
    { auth: true },
  )
  .post(
    "/jobs/:id/convert",
    async ({ params, body, user, set }) => {
      const job = db
        .query("SELECT * FROM jobs WHERE id = ? AND user_id = ?")
        .as(Jobs)
        .get(params.id, user.id);

      if (!job) {
        set.status = 404;
        return { success: false, message: "Job not found" };
      }

      // Single-use claim, done ATOMICALLY. Do NOT read num_files here and write it
      // later: the `await mkdir(...)` below is a real yield point, so a plain
      // check-then-write lets two concurrent converts both pass the check, both fire
      // handleConvert, and both append to file_names — corrupting the very
      // files.length === numFiles invariant this guard exists to protect.
      // `.changes === 0` means someone else claimed it first (or it already ran).
      const claimed = db
        .query(
          "UPDATE jobs SET num_files = ?1, status = 'pending' WHERE id = ?2 AND num_files = 0",
        )
        .run(body.fileNames.length, params.id);

      if (claimed.changes === 0) {
        set.status = 409;
        return { success: false, message: "Job already used" };
      }

      const target = normalizeFiletype(body.target);
      if (!target || target.includes("/") || target.includes("\\") || target.includes("..")) {
        set.status = 400;
        return { success: false, message: "Invalid target" };
      }

      if (body.fileNames.length === 0) {
        set.status = 400;
        return { success: false, message: "No files to convert" };
      }

      const fileNames = body.fileNames.map((n) => sanitize(n));
      const userUploadsDir = `${uploadsDir}${user.id}/${params.id}/`;
      const userOutputDir = `${outputDir}${user.id}/${params.id}/`;

      // Everything from here until handleConvert is fired runs with the job ALREADY
      // claimed, so any throw in between strands it: num_files is set, no .then()/
      // .catch() will ever run, and the 409 guard blocks reuse. mkdir genuinely can
      // throw (disk full, permissions, ENOTDIR) — verified by placing a plain file
      // where the output directory belongs. Catch it and write the same terminal
      // state the conversion failure path uses, so a stranded job is discoverable
      // rather than silently pending forever.
      try {
        await mkdir(userOutputDir, { recursive: true });
      }
      catch (error) {
        console.error("Failed to create the output directory:", error);
        db.query("UPDATE jobs SET status = 'failed' WHERE id = ?1").run(params.id);
        set.status = 500;
        return { success: false, message: "Could not start conversion" };
      }

      db.query("UPDATE jobs SET num_files = ?1, status = 'pending' WHERE id = ?2").run(
        fileNames.length,
        params.id,
      );

      // handleConvert takes an Elysia Cookie but touches only `.value` (spec fact 16).
      const jobIdCookie = { value: String(params.id) } as unknown as Cookie<string | undefined>;

      handleConvert(
        fileNames,
        userUploadsDir,
        userOutputDir,
        target,
        body.converter,
        jobIdCookie,
      )
        .then(() => {
          db.query("UPDATE jobs SET status = 'completed' WHERE id = ?1").run(params.id);
        })
        .catch((error) => {
          console.error("Error in conversion process:", error);
          // Write a TERMINAL state. Without this the job sits at 'pending' forever:
          // nothing server-side ever transitions it, and because jobs are single-use
          // the client can neither discover the failure nor retry — it would poll
          // until its stall timeout and report "still working" about a job that is
          // already dead. Upstream convert.tsx has the same fire-and-forget shape but
          // no single-use guard, so a stuck job there is merely resubmitted; our guard
          // is what turns it into a permanent wedge, so our .catch() must close it.
          db.query("UPDATE jobs SET status = 'failed' WHERE id = ?1").run(params.id);
        });

      return { accepted: true };
    },
    {
      body: t.Object({
        target: t.String(),
        converter: t.String(),
        fileNames: t.Array(t.String()),
      }),
      auth: true,
    },
  )
```

The `job.num_files > 0` guard enforces single-use jobs — a second convert would corrupt the completion check permanently (spec §5).

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd services/convertx && JWT_SECRET=test-secret bun test tests/api/ && bun run lint:tsc
```

Expected: all pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd services/convertx
git add src/pages/api.tsx tests/api/convert.test.ts tests/api/failure-set.test.ts
git commit -m "feat(api): add convert and job status routes"
```

---

### Task 6: ConvertX API — download route

**Files:**
- Modify: `services/convertx/src/pages/api.tsx`
- Test: `services/convertx/tests/api/download.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/jobs/:id/files/:name` → binary body

- [ ] **Step 1: Write the failing test**

`services/convertx/tests/api/download.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { api } from "../../src/pages/api";
import { authCookie as session } from "./helpers/auth";

const app = api;

describe("GET /api/v1/jobs/:id/files/:name", () => {
  it("404s for a file that does not exist", async () => {
    const cookie = await session();
    const created = await app.handle(
      new Request("http://localhost/api/v1/jobs", { method: "POST", headers: { cookie } }),
    );
    const { jobId } = (await created.json()) as { jobId: number };

    const res = await app.handle(
      new Request(`http://localhost/api/v1/jobs/${jobId}/files/nope.png`, {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(404);
    // Asserting the envelope, not just the status: a missing route ALSO returns 404,
    // so a status-only assertion would pass before the route exists and give a false RED.
    expect(await res.json()).toEqual({ success: false, message: "File not found" });
  });

  it("refuses a traversal attempt in the file name", async () => {
    const cookie = await session();
    const created = await app.handle(
      new Request("http://localhost/api/v1/jobs", { method: "POST", headers: { cookie } }),
    );
    const { jobId } = (await created.json()) as { jobId: number };

    const res = await app.handle(
      new Request(`http://localhost/api/v1/jobs/${jobId}/files/${encodeURIComponent("../../etc/passwd")}`, {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, message: "File not found" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd services/convertx && JWT_SECRET=test-secret bun test tests/api/download.test.ts
```

Expected: FAIL — the route does not exist, so Elysia's default 404 body does not match the envelope.

- [ ] **Step 3: Add the route to `api.tsx`**

```tsx
  .get(
    "/jobs/:id/files/:name",
    async ({ params, user, set }) => {
      const job = db
        .query("SELECT * FROM jobs WHERE id = ? AND user_id = ?")
        .as(Jobs)
        .get(params.id, user.id);

      if (!job) {
        set.status = 404;
        return { success: false, message: "Job not found" };
      }

      const name = sanitize(params.name);
      const file = Bun.file(`${outputDir}${user.id}/${params.id}/${name}`);

      if (!(await file.exists())) {
        set.status = 404;
        return { success: false, message: "File not found" };
      }

      // Bun infers Content-Type from the file; it does NOT set a disposition, so a
      // browser navigating here directly would render text/images/PDFs inline.
      //
      // The raw name CANNOT go in the basic `filename` parameter: HTTP header values
      // are Latin-1, `sanitize-filename` does not strip non-ASCII, and a Cyrillic or
      // CJK name therefore throws an uncaught TypeError inside Elysia's response
      // mapping — surfacing as a 500 with Bun's raw HTML crash page (stack trace and
      // absolute local paths), not the JSON envelope. Use RFC 5987/6266: an ASCII
      // fallback plus the extended parameter, which is ASCII by construction.
      const asciiFallback = name.replace(/[^\x20-\x7E]/g, '_');
      set.headers['content-disposition']
        = `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;

      return file;
    },
    { auth: true },
  )
```

`sanitize()` collapses any traversal attempt to a harmless name, so the lookup misses and 404s.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd services/convertx && JWT_SECRET=test-secret bun test tests/api/ && bun run lint:tsc && bun run lint:eslint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd services/convertx
git add src/pages/api.tsx tests/api/download.test.ts
git commit -m "feat(api): add converted file download route"
```

- [ ] **Step 6: Record the submodule pointer in the umbrella repo**

```bash
cd services/convertx && git tag json-api-$(date +%Y-%m-%d) && cd ../..
git add services/convertx
git commit -m "chore: pin convertx submodule to json-api build"
```

---

### Task 7: it-tools — config and the HTTP service layer

**Files:**
- Modify: `src/config.ts`
- Create: `src/tools/file-converter/convertx.service.ts`
- Test: `src/tools/file-converter/convertx.service.test.ts`

**Interfaces:**
- Consumes: `config` from `@/config`
- Produces:
  - `type ConvertXError = { success: false; message: string }`
  - `type JobStatus = { status: string; numFiles: number; files: { fileName: string; outputFileName: string; status: string }[] }`
  - `createSession(): Promise<number>`
  - `checkHealth(): Promise<boolean>`
  - `getConverters(): Promise<Record<string, string[]>>`
  - `getTargets(fileType: string): Promise<Record<string, string[]>>`
  - `createJob(): Promise<number>`
  - `uploadFile(jobId: number, file: File): Promise<string[]>`
  - `startConvert(jobId: number, target: string, converter: string, fileNames: string[]): Promise<void>`
  - `getJob(jobId: number): Promise<JobStatus>`
  - `downloadFile(jobId: number, name: string): Promise<Blob>`
  - `isFailureStatus(status: string): boolean`

- [ ] **Step 1: Add the config entry**

In `src/config.ts`, add inside the `app` block:

```ts
    convertxUrl: {
      doc: 'Base URL of the ConvertX JSON API',
      format: 'string',
      default: '/api/v1',
      env: 'VITE_CONVERTX_URL',
    },
```

- [ ] **Step 2: Write the failing test**

`src/tools/file-converter/convertx.service.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { getTargets, isFailureStatus, uploadFile } from './convertx.service';

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('isFailureStatus', () => {
  it('treats the two known failure strings as failures', () => {
    expect(isFailureStatus('Failed, check logs')).toBe(true);
    expect(isFailureStatus('File type not supported')).toBe(true);
  });

  it('treats every other status as success', () => {
    expect(isFailureStatus('Done')).toBe(false);
    expect(isFailureStatus('Done: resized to 256x256')).toBe(false);
    expect(isFailureStatus('/app/data/output/1/1/x.eml')).toBe(false);
  });
});

describe('getTargets', () => {
  it('returns the parsed body', async () => {
    vi.stubGlobal('fetch', mockFetch({ ffmpeg: ['jpg', 'webp'] }));
    await expect(getTargets('png')).resolves.toEqual({ ffmpeg: ['jpg', 'webp'] });
  });

  it('throws the envelope message on an error response', async () => {
    vi.stubGlobal('fetch', mockFetch({ success: false, message: 'Unauthorized' }, 401));
    await expect(getTargets('png')).rejects.toThrow('Unauthorized');
  });
});

describe('uploadFile', () => {
  it('returns the server-side stored names, not the local one', async () => {
    vi.stubGlobal('fetch', mockFetch({ files: [{ name: 'safe.txt' }] }));
    const file = new File(['x'], '../evil.txt', { type: 'text/plain' });
    await expect(uploadFile(1, file)).resolves.toEqual(['safe.txt']);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm vitest run src/tools/file-converter/convertx.service.test.ts
```

Expected: FAIL — cannot resolve `./convertx.service`.

- [ ] **Step 4: Write the service**

`src/tools/file-converter/convertx.service.ts`:

```ts
import { config } from '@/config';

const BASE = config.app.convertxUrl;

const FAILURE_STATUSES = ['Failed, check logs', 'File type not supported'];

// Timeouts are per-call, not global — one value cannot serve all of these.
// The health probe must fail FAST: it runs on mount and gates the tool's
// "backend not reachable" state, so a long wait means a spinner where an
// error belongs. JSON calls are small and quick; 30s is generous.
// Uploads and downloads are bandwidth-bound and legitimately slow for large
// media (nginx allows 2GB), so they get NO client timeout — bounding them
// here would cancel healthy transfers. nginx and the browser already bound
// those.
const HEALTH_TIMEOUT_MS = 5_000;
const JSON_TIMEOUT_MS = 30_000;

function withTimeout(ms: number | null, init: RequestInit): { init: RequestInit, cancel: () => void } {
  if (ms === null) {
    return { init, cancel: () => {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  return {
    init: { ...init, signal: controller.signal },
    cancel: () => clearTimeout(timer),
  };
}

export interface JobStatus {
  status: string
  numFiles: number
  files: { fileName: string, outputFileName: string, status: string }[]
}

export function isFailureStatus(status: string): boolean {
  return FAILURE_STATUSES.includes(status);
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { ...init, credentials: 'same-origin' });

  // 401 = cookie present but invalid/expired. 422 = NO cookie at all: upstream's `auth`
  // macro binds `cookie: "session"`, whose schema declares `auth` as a REQUIRED string, so
  // a cookie-less request fails Elysia's schema validation before resolve() ever runs.
  // Both mean "no usable session", and both must trigger a re-bootstrap — retrying only on
  // 401 leaves a user who cleared their cookies stuck on a hard error.
  if ((response.status === 401 || response.status === 422) && retry) {
    await createSession();
    return request<T>(path, init, false);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(body?.message ?? `Request failed with status ${response.status}`);
  }

  return await response.json() as T;
}

export async function createSession(): Promise<number> {
  const response = await fetch(`${BASE}/session`, { method: 'POST', credentials: 'same-origin' });

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(body?.message ?? 'Could not start a session');
  }

  const { userId } = await response.json() as { userId: number };
  return userId;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/healthcheck`, { credentials: 'same-origin' });
    if (!response.ok) {
      return false;
    }
    // A 200 carrying the SPA shell means the request was never proxied.
    const body = await response.json().catch(() => null) as { status?: string } | null;
    return body?.status === 'ok';
  }
  catch {
    return false;
  }
}

export async function getConverters(): Promise<Record<string, string[]>> {
  return await request<Record<string, string[]>>('/converters');
}

export async function getTargets(fileType: string): Promise<Record<string, string[]>> {
  return await request<Record<string, string[]>>('/targets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileType }),
  });
}

export async function createJob(): Promise<number> {
  const { jobId } = await request<{ jobId: number }>('/jobs', { method: 'POST' });
  return jobId;
}

export async function uploadFile(jobId: number, file: File): Promise<string[]> {
  const form = new FormData();
  form.append('file', file);

  const { files } = await request<{ files: { name: string }[] }>(
    `/jobs/${jobId}/files`,
    { method: 'POST', body: form },
  );

  return files.map(({ name }) => name);
}

export async function startConvert(
  jobId: number,
  target: string,
  converter: string,
  fileNames: string[],
): Promise<void> {
  await request(`/jobs/${jobId}/convert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target, converter, fileNames }),
  });
}

export async function getJob(jobId: number): Promise<JobStatus> {
  return await request<JobStatus>(`/jobs/${jobId}`);
}

export async function downloadFile(jobId: number, name: string): Promise<Blob> {
  const response = await fetch(
    `${BASE}/jobs/${jobId}/files/${encodeURIComponent(name)}`,
    { credentials: 'same-origin' },
  );

  if (!response.ok) {
    throw new Error(response.status === 404 ? 'expired' : 'Download failed');
  }

  return await response.blob();
}
```

`encodeURIComponent` on the name is required — upstream fixed exactly this encoding bug in PR #587.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm vitest run src/tools/file-converter/convertx.service.test.ts
```

Expected: 6 pass.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/tools/file-converter/convertx.service.ts src/tools/file-converter/convertx.service.test.ts
git commit -m "feat(file-converter): add ConvertX API service layer"
```

---

### Task 8: it-tools — the `useConvertX` composable

**Files:**
- Create: `src/tools/file-converter/useConvertX.ts`
- Test: `src/tools/file-converter/useConvertX.test.ts`

**Interfaces:**
- Consumes: everything Task 7 produces
- Produces: `useConvertX()` returning `{ state, targets, converters, results, errorMessage, jobId, selectFile, convert, reset, keepWaiting }` where `state: Ref<'probing' | 'unavailable' | 'needs-account' | 'ready' | 'loading-targets' | 'converting' | 'stalled' | 'done' | 'error'>`, `converters: Ref<Record<string, string[]>>` (feeds the capability panel), and `jobId: Ref<number | null>` (needed for downloads)
- Produces: `classifyJob(job: JobStatus): { done: boolean, results?: ConvertResult[] }` and `type ConvertResult = { name: string, failed: boolean, status: string }`
- Produces: `POLL_INTERVAL_MS = 1000`, `STALL_TIMEOUT_MS = 600000`

- [ ] **Step 1: Write the failing test**

`src/tools/file-converter/useConvertX.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { POLL_INTERVAL_MS, STALL_TIMEOUT_MS, classifyJob } from './useConvertX';

describe('poll timings', () => {
  it('matches the upstream UI interval', () => {
    expect(POLL_INTERVAL_MS).toBe(1000);
  });

  it('uses a ten minute soft stall timeout', () => {
    expect(STALL_TIMEOUT_MS).toBe(600_000);
  });
});

describe('classifyJob', () => {
  it('is incomplete while fewer files have landed than expected', () => {
    expect(classifyJob({ status: 'completed', numFiles: 1, files: [] })).toEqual({ done: false });
  });

  it('reports success from the file status, not the job status', () => {
    const job = {
      status: 'pending',
      numFiles: 1,
      files: [{ fileName: 'a.png', outputFileName: 'a.jpg', status: 'Done' }],
    };
    expect(classifyJob(job)).toEqual({
      done: true,
      results: [{ name: 'a.jpg', failed: false, status: 'Done' }],
    });
  });

  it('reports failure even though the job reads completed', () => {
    const job = {
      status: 'completed',
      numFiles: 1,
      files: [{ fileName: 'a.xyz', outputFileName: 'a.jpg', status: 'Failed, check logs' }],
    };
    expect(classifyJob(job)).toEqual({
      done: true,
      results: [{ name: 'a.jpg', failed: true, status: 'Failed, check logs' }],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/tools/file-converter/useConvertX.test.ts
```

Expected: FAIL — cannot resolve `./useConvertX`.

- [ ] **Step 3: Write the composable**

`src/tools/file-converter/useConvertX.ts`:

```ts
import {
  type JobStatus,
  checkHealth,
  createJob,
  createSession,
  getConverters,
  getTargets,
  isFailureStatus,
  startConvert,
  uploadFile,
  getJob,
} from './convertx.service';

export const POLL_INTERVAL_MS = 1000;
export const STALL_TIMEOUT_MS = 600_000;

export type ConvertState =
  | 'probing'
  | 'unavailable'
  | 'needs-account'
  | 'ready'
  | 'loading-targets'
  | 'converting'
  | 'stalled'
  | 'done'
  | 'error';

export interface ConvertResult {
  name: string
  failed: boolean
  status: string
}

export function classifyJob(job: JobStatus): { done: boolean, failed?: boolean, results?: ConvertResult[] } {
  // Completeness is checked BEFORE the job-level failure flag, deliberately.
  // handleConvert chunks its work, so a job can be marked 'failed' by one chunk's
  // DB write throwing while sibling files still land their rows — checking 'failed'
  // first would hide real, downloadable results from the user.
  if (job.numFiles > 0 && job.files.length === job.numFiles) {
    // fall through to the per-file classification below
  }
  else if (job.status === 'failed') {
    // The ONE case where job.status is authoritative. The API writes 'failed' from
    // handleConvert's .catch(), and from the output-directory failure path — the
    // only signals that the background chain died before producing rows. Without
    // this the client polls until its stall timeout, reporting "still working"
    // about a job that is already dead and, being single-use, unretryable.
    // Every OTHER status value stays untrustworthy: 'completed' is written
    // unconditionally in .then() even when every single file failed.
    return { done: true, failed: true, results: [] };
  }

  if (job.files.length !== job.numFiles) {
    return { done: false };
  }

  return {
    done: true,
    results: job.files.map(file => ({
      name: file.outputFileName,
      failed: isFailureStatus(file.status),
      status: file.status,
    })),
  };
}

export function useConvertX() {
  const state = ref<ConvertState>('probing');
  const targets = ref<Record<string, string[]>>({});
  const converters = ref<Record<string, string[]>>({});
  const results = ref<ConvertResult[]>([]);
  const errorMessage = ref('');
  const jobId = ref<number | null>(null);
  const storedNames = ref<string[]>([]);

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let waitingSince = 0;

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  async function init() {
    state.value = 'probing';

    if (!(await checkHealth())) {
      state.value = 'unavailable';
      return;
    }

    try {
      await createSession();
    }
    catch {
      state.value = 'needs-account';
      return;
    }

    converters.value = await getConverters().catch(() => ({}));
    state.value = 'ready';
  }

  async function selectFile(file: File) {
    state.value = 'loading-targets';
    errorMessage.value = '';
    results.value = [];

    const extension = file.name.includes('.') ? file.name.split('.').pop() ?? '' : '';

    try {
      targets.value = await getTargets(extension);
      state.value = 'ready';
    }
    catch (error) {
      errorMessage.value = (error as Error).message;
      state.value = 'error';
    }
  }

  function poll() {
    pollTimer = setTimeout(async () => {
      if (jobId.value === null) {
        return;
      }

      try {
        const job = await getJob(jobId.value);
        const { done, results: finished } = classifyJob(job);

        if (done && finished) {
          results.value = finished;
          state.value = 'done';
          return;
        }

        if (Date.now() - waitingSince > STALL_TIMEOUT_MS) {
          state.value = 'stalled';
          return;
        }

        poll();
      }
      catch (error) {
        errorMessage.value = (error as Error).message;
        state.value = 'error';
      }
    }, POLL_INTERVAL_MS);
  }

  function keepWaiting() {
    waitingSince = Date.now();
    state.value = 'converting';
    poll();
  }

  async function convert(file: File, target: string, converter: string) {
    state.value = 'converting';
    errorMessage.value = '';

    try {
      jobId.value = await createJob();
      storedNames.value = await uploadFile(jobId.value, file);
      await startConvert(jobId.value, target, converter, storedNames.value);
      waitingSince = Date.now();
      poll();
    }
    catch (error) {
      errorMessage.value = (error as Error).message;
      state.value = 'error';
    }
  }

  function reset() {
    stopPolling();
    jobId.value = null;
    storedNames.value = [];
    results.value = [];
    targets.value = {};
    errorMessage.value = '';
    state.value = 'ready';
  }

  onMounted(init);
  onUnmounted(stopPolling);

  return { state, targets, converters, results, errorMessage, jobId, selectFile, convert, reset, keepWaiting };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm vitest run src/tools/file-converter/useConvertX.test.ts
```

Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/file-converter/useConvertX.ts src/tools/file-converter/useConvertX.test.ts
git commit -m "feat(file-converter): add useConvertX composable"
```

---

### Task 9: it-tools — the tool component and registration

**Files:**
- Create: `src/tools/file-converter/index.ts`
- Create: `src/tools/file-converter/file-converter.vue`
- Modify: `src/tools/index.ts`

**Interfaces:**
- Consumes: `useConvertX()` from Task 8, `downloadFile()` from Task 7
- Produces: route `/file-converter`; `data-test-id` hooks `converter-unavailable`, `converter-dropzone`, `converter-targets`, `converter-result`

- [ ] **Step 1: Write the tool definition**

`src/tools/file-converter/index.ts`:

```ts
import { FileExport } from '@vicons/tabler';
import { defineTool } from '../tool';

export const tool = defineTool({
  name: 'File converter',
  path: '/file-converter',
  description: 'Convert files between formats using a self-hosted ConvertX backend.',
  keywords: [
    'file', 'convert', 'converter', 'format', 'transcode',
    'mp4', 'mkv', 'webm', 'mp3', 'wav', 'flac',
    'png', 'jpg', 'webp', 'avif', 'heic', 'svg',
    'pdf', 'docx', 'odt', 'epub', 'mobi', 'csv',
  ],
  component: () => import('./file-converter.vue'),
  icon: FileExport,
  createdAt: new Date('2026-08-19'),
});
```

If `FileExport` does not resolve, pick any exported name from `@vicons/tabler` — `Transform`,
`FileSymlink`, and `Exchange` are all reasonable. `vue-tsc` in Step 4 will catch a bad import.

- [ ] **Step 2: Write the component**

`src/tools/file-converter/file-converter.vue`:

```vue
<script setup lang="ts">
import { config } from '@/config';
import { downloadFile } from './convertx.service';
import { useConvertX } from './useConvertX';

const { state, targets, converters, results, errorMessage, jobId, selectFile, convert, reset, keepWaiting } = useConvertX();

const currentFile = ref<File | null>(null);
const selection = ref<string>('');
const showCapabilities = ref(false);

const targetOptions = computed(() =>
  Object.entries(targets.value).flatMap(([converter, list]) =>
    list.map(target => ({ label: `${target} (${converter})`, value: `${target},${converter}` })),
  ),
);

async function onFileUpload(file: File) {
  currentFile.value = file;
  selection.value = '';
  await selectFile(file);
}

async function onConvert() {
  if (!currentFile.value || !selection.value) {
    return;
  }
  const [target, converter] = selection.value.split(',');
  await convert(currentFile.value, target!, converter!);
}

async function onDownload(name: string) {
  if (jobId.value === null) {
    return;
  }

  try {
    const blob = await downloadFile(jobId.value, name);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  catch (error) {
    errorMessage.value = (error as Error).message === 'expired'
      ? 'This file has expired. Converted files are kept for about 24 hours.'
      : 'Download failed.';
  }
}

function startOver() {
  currentFile.value = null;
  selection.value = '';
  reset();
}
</script>

<template>
  <c-card v-if="state === 'probing'" title="File converter">
    <n-spin size="small" /> Checking the converter backend…
  </c-card>

  <c-card v-else-if="state === 'unavailable'" title="Converter backend not reachable" data-test-id="converter-unavailable">
    <p>
      No ConvertX backend responded at <code>{{ config.app.convertxUrl }}</code>.
    </p>
    <p>
      This tool needs the companion ConvertX service. Start the full stack with
      <code>docker compose up</code>, or set <code>VITE_CONVERTX_URL</code> at build time
      if your backend lives elsewhere.
    </p>
  </c-card>

  <c-card v-else-if="state === 'needs-account'" title="Converter backend requires an account">
    <p>
      The backend responded but rejected an anonymous session. This tool only supports
      backends running with <code>ALLOW_UNAUTHENTICATED=true</code>.
    </p>
  </c-card>

  <template v-else>
    <c-card title="File converter">
      <c-file-upload
        title="Drag and drop a file here, or click to select a file"
        data-test-id="converter-dropzone"
        @file-upload="onFileUpload"
      />

      <div v-if="currentFile" mt-3>
        <p><strong>{{ currentFile.name }}</strong></p>

        <n-spin v-if="state === 'loading-targets'" size="small" />

        <template v-else-if="targetOptions.length > 0">
          <c-select
            v-model:value="selection"
            :options="targetOptions"
            label="Convert to"
            placeholder="Choose an output format"
            data-test-id="converter-targets"
            my-2
          />
          <c-button :disabled="!selection || state === 'converting'" @click="onConvert()">
            Convert
          </c-button>
        </template>

        <n-alert v-else type="warning" mt-2>
          No converter handles this file type. Check the supported formats below — detection is
          based on the file extension, so an unusual or missing extension is a common cause.
        </n-alert>
      </div>

      <div v-if="state === 'converting'" mt-3>
        <n-spin size="small" /> Converting…
      </div>

      <n-alert v-if="state === 'stalled'" type="warning" mt-3>
        <p>Still working after 10 minutes. Large videos and LaTeX documents can legitimately take this long.</p>
        <c-button mt-2 @click="keepWaiting()">
          Keep waiting
        </c-button>
      </n-alert>

      <n-alert v-if="errorMessage" type="error" mt-3>
        {{ errorMessage }}
      </n-alert>

      <div v-if="state === 'done'" mt-3 data-test-id="converter-result">
        <div v-for="result in results" :key="result.name" mb-2>
          <template v-if="result.failed">
            <n-alert type="error">
              {{ result.name }} — {{ result.status }}. Details are in the ConvertX container log.
            </n-alert>
          </template>
          <template v-else>
            <c-button @click="onDownload(result.name)">
              Download {{ result.name }}
            </c-button>
            <span v-if="result.status !== 'Done'" ml-2 op-70>{{ result.status }}</span>
          </template>
        </div>
        <c-button mt-2 @click="startOver()">
          Convert another file
        </c-button>
      </div>
    </c-card>

    <c-card title="Supported formats">
      <c-button @click="showCapabilities = !showCapabilities">
        {{ showCapabilities ? 'Hide' : 'Show' }} what each converter handles
      </c-button>
      <n-table v-if="showCapabilities" mt-3>
        <thead>
          <tr><th>Converter</th><th>Output formats</th></tr>
        </thead>
        <tbody>
          <tr v-for="(list, name) in converters" :key="name">
            <td>{{ name }}</td>
            <td>{{ list.join(', ') }}</td>
          </tr>
        </tbody>
      </n-table>
    </c-card>
  </template>
</template>
```

- [ ] **Step 3: Register the tool**

In `src/tools/index.ts`, add the import alongside the others:

```ts
import { tool as fileConverter } from './file-converter';
```

and add `fileConverter` to the `Converter` category's `components` array.

Registration is unconditional — build-time `VITE_*` values cannot express runtime availability, so the tool always appears and reports its own unreachable state.

- [ ] **Step 4: Verify the build and typecheck**

```bash
pnpm build
```

Expected: PASS, including `vue-tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/file-converter/index.ts src/tools/file-converter/file-converter.vue src/tools/index.ts
git commit -m "feat(file-converter): add file converter tool"
```

---

### Task 10: it-tools — service-worker guards and e2e coverage

**Files:**
- Modify: `vite.config.ts`
- Modify: `playwright.config.ts`
- Create: `src/tools/file-converter/file-converter.e2e.spec.ts`

**Interfaces:**
- Consumes: the routes and test ids from Task 9
- Produces: nothing consumed downstream

- [ ] **Step 1: Add the PWA navigation denylist**

In `vite.config.ts`, inside the `VitePWA({ … })` options, add alongside `manifest`:

```ts
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
      },
```

Without this, `vite-plugin-pwa`'s default `navigateFallback: 'index.html'` answers same-origin navigations to `/api/...` with the SPA shell (spec fact 24). Downloads already avoid this by using `fetch` + blob; this is the second layer.

- [ ] **Step 2: Block service workers in Playwright**

In `playwright.config.ts`, inside `use: { … }`, add:

```ts
    serviceWorkers: 'block',
```

`src/main.ts:17` registers a service worker unconditionally, and `page.route()` does not intercept requests mediated by one — without this the API mocks work on first load and go flaky after activation.

- [ ] **Step 3: Write the e2e spec**

`src/tools/file-converter/file-converter.e2e.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test.describe('Tool - File converter', () => {
  test('Has correct title', async ({ page }) => {
    await page.route('**/api/v1/healthcheck', route =>
      route.fulfill({ json: { status: 'ok' } }));
    await page.route('**/api/v1/session', route => route.fulfill({ json: { userId: 0 } }));
    await page.route('**/api/v1/converters', route => route.fulfill({ json: {} }));

    await page.goto('/file-converter');
    await expect(page).toHaveTitle('File converter - IT Tools');
  });

  test('Shows the unavailable state when no backend answers', async ({ page }) => {
    await page.route('**/api/v1/healthcheck', route => route.abort());

    await page.goto('/file-converter');

    await expect(page.getByTestId('converter-unavailable')).toBeVisible();
  });

  test('Treats a 200 that is not the health payload as unavailable', async ({ page }) => {
    // Reproduces the un-proxied case: nginx serves the SPA shell with status 200.
    await page.route('**/api/v1/healthcheck', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html></html>' }));

    await page.goto('/file-converter');

    await expect(page.getByTestId('converter-unavailable')).toBeVisible();
  });

  test('Reports a failed conversion using the file status', async ({ page }) => {
    await page.route('**/api/v1/healthcheck', route => route.fulfill({ json: { status: 'ok' } }));
    await page.route('**/api/v1/session', route => route.fulfill({ json: { userId: 0 } }));
    await page.route('**/api/v1/converters', route => route.fulfill({ json: { ffmpeg: ['jpg'] } }));
    await page.route('**/api/v1/targets', route => route.fulfill({ json: { ffmpeg: ['jpg'] } }));
    await page.route('**/api/v1/jobs', route => route.fulfill({ json: { jobId: 1 } }));
    await page.route('**/api/v1/jobs/1/files', route =>
      route.fulfill({ json: { files: [{ name: 'input.png' }] } }));
    await page.route('**/api/v1/jobs/1/convert', route => route.fulfill({ json: { accepted: true } }));
    // Job status reads 'completed' while the file itself failed.
    await page.route('**/api/v1/jobs/1', route => route.fulfill({
      json: {
        status: 'completed',
        numFiles: 1,
        files: [{ fileName: 'input.png', outputFileName: 'input.jpg', status: 'Failed, check logs' }],
      },
    }));

    await page.goto('/file-converter');

    await page.setInputFiles('input[type="file"]', {
      name: 'input.png',
      mimeType: 'image/png',
      buffer: Buffer.from('fake'),
    });

    await page.getByTestId('converter-targets').click();
    await page.getByText('jpg (ffmpeg)').click();
    await page.getByRole('button', { name: 'Convert' }).click();

    await expect(page.getByTestId('converter-result')).toContainText('Failed, check logs');
  });
});
```

Note the ordering of the `**/api/v1/jobs` and `**/api/v1/jobs/1` routes — Playwright matches the most recently registered route first, so the more specific pattern is registered last.

- [ ] **Step 4: Run the e2e suite**

```bash
pnpm build && pnpm test:e2e --project=chromium src/tools/file-converter/file-converter.e2e.spec.ts
```

Expected: 4 pass. Then confirm cross-browser:

```bash
pnpm test:e2e src/tools/file-converter/file-converter.e2e.spec.ts
```

Expected: 12 pass (4 tests × 3 browser projects).

- [ ] **Step 5: Commit**

```bash
git add vite.config.ts playwright.config.ts src/tools/file-converter/file-converter.e2e.spec.ts
git commit -m "test(file-converter): add e2e coverage and service worker guards"
```

---

### Task 11: Deployment — Dockerfile, nginx, compose

**Files:**
- Modify: `Dockerfile`
- Modify: `nginx.conf`
- Create: `compose.yaml`
- Create: `.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: the `services/convertx` submodule from Task 1
- Produces: a running stack on `http://localhost:8080`

- [ ] **Step 1: Plumb the config value through the Dockerfile**

In `Dockerfile`, in the build stage before `RUN pnpm build`:

```dockerfile
ARG VITE_CONVERTX_URL=/api/v1
ENV VITE_CONVERTX_URL=$VITE_CONVERTX_URL
```

`ARG` alone is insufficient — Vite reads the value from the environment at build time, so the `ENV` line is what actually exposes it.

- [ ] **Step 2: Add the proxy location to `nginx.conf`**

```nginx
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/v1/ {
        proxy_pass http://convertx:3000;
        proxy_set_header Host $host;
        client_max_body_size 2g;
        proxy_request_buffering off;
    }
}
```

`client_max_body_size` is not optional — nginx's 1 MB default would 413 essentially every real upload. Timeouts are deliberately left at their defaults; no MVP route holds a response that long.

- [ ] **Step 3: Write `compose.yaml`**

```yaml
services:
  it-tools:
    build: .
    ports:
      - "8080:80"
    depends_on:
      - convertx
    restart: unless-stopped

  convertx:
    build: ./services/convertx
    # Intentionally no ports: reachable only through the it-tools nginx.
    environment:
      - ALLOW_UNAUTHENTICATED=true
      - UNAUTHENTICATED_USER_SHARING=true
      - HTTP_ALLOWED=true
      - JWT_SECRET=${JWT_SECRET:?set JWT_SECRET in .env}
      - AUTO_DELETE_EVERY_N_HOURS=24
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

- [ ] **Step 4: Add `.env.example` and ignore the real one**

`.env.example`:

```bash
# Long random string used to sign session tokens.
# Generate one with: openssl rand -hex 32
JWT_SECRET=replace-me
```

Append to `.gitignore`:

```
.env
/data
```

- [ ] **Step 5: Build and smoke-test the stack**

```bash
cp .env.example .env
sed -i "s/replace-me/$(openssl rand -hex 32)/" .env
docker compose build
docker compose up -d
```

The first build takes tens of minutes and several GB — ConvertX installs ~25 native converters. Then:

```bash
curl -s http://localhost:8080/api/v1/healthcheck
```

Expected: `{"status":"ok"}`. If you get HTML instead, the proxy location is not matching.

- [ ] **Step 6: Run the manual conversion checklist**

Nothing in CI exercises the native binaries, so this is the only coverage they get. In the browser at `http://localhost:8080/file-converter`, convert one file per family and confirm each downloads and opens:

- [ ] ImageMagick or vips: `.png` → `.webp`
- [ ] ffmpeg: a short `.mp4` → `.webm`
- [ ] LibreOffice: `.docx` → `.pdf`
- [ ] pandoc: `.md` → `.html`
- [ ] A deliberately corrupt file, to confirm the failure path renders `Failed, check logs`

- [ ] **Step 7: Commit**

```bash
git add Dockerfile nginx.conf compose.yaml .env.example .gitignore
git commit -m "feat(deploy): add compose stack with ConvertX backend"
```

---

### Task 12: Documentation

**Files:**
- Create: `LICENSING.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing
- Produces: nothing

- [ ] **Step 1: Write `LICENSING.md`**

```markdown
# Licensing

This fork combines two separately licensed works:

- **it-tools** — GNU General Public License v3.0 (see `LICENSE`)
- **ConvertX** — GNU Affero General Public License v3.0 (see `services/convertx/LICENSE`),
  vendored as a git submodule

GPLv3 §13 permits combining a GPLv3 work with an AGPLv3 work. The AGPL's network
clause then applies to the combination, so **this combined work is distributed under
the AGPL-3.0**. The two codebases remain separately licensed works under that umbrella.

If you make this stack available to users over a network, AGPL §13 requires you to
offer those users the complete corresponding source, including any modifications.
The source for this fork is available at the repository you cloned it from; the
ConvertX fork's source is at the URL recorded in `.gitmodules`.

> This is the maintainer's reading of the licenses, not verified legal advice.
> If you intend to distribute or publicly host this stack, get your own advice.
```

- [ ] **Step 2: Add a README section**

Insert after the existing installation section:

```markdown
## File converter (self-hosted)

This fork adds a **File converter** tool backed by a companion
[ConvertX](https://github.com/C4illin/ConvertX) service, which converts between
1000+ formats using ffmpeg, LibreOffice, ImageMagick, pandoc and others.

### Running it

```bash
git clone --recurse-submodules <this repo>
cp .env.example .env && sed -i "s/replace-me/$(openssl rand -hex 32)/" .env
docker compose up -d
```

Then open <http://localhost:8080>. The first build downloads several GB of converters
and takes tens of minutes; later rebuilds reuse the cached layer and take minutes.

Without the backend, it-tools still builds and deploys as a normal static site — the
File converter tool simply reports that its backend is unreachable.

### Read this before exposing it

The stack runs ConvertX in unauthenticated shared mode
(`ALLOW_UNAUTHENTICATED=true`, `UNAUTHENTICATED_USER_SHARING=true`). Every job belongs
to one shared identity and job ids are sequential, which means:

> **Anyone who can reach the stack can enumerate every job and download every file
> anyone has converted.**

There is also no rate limiting. This is intended for a trusted LAN or a single-user
homelab. Do not expose it to the internet without adding real authentication in front
of it.

Converted files and their originals are deleted after roughly 24 hours
(`AUTO_DELETE_EVERY_N_HOURS`).
```

- [ ] **Step 3: Commit**

```bash
git add LICENSING.md README.md
git commit -m "docs: document the file converter stack and licensing"
```

---

## Rebase runbook (for later, not part of initial implementation)

When updating the ConvertX fork against upstream:

```bash
cd services/convertx
git fetch upstream
git rebase upstream/main
bun install
JWT_SECRET=test-secret bun test tests/api/   # the failure-set tripwire lives here
bun run lint:tsc
git tag json-api-$(date +%Y-%m-%d)
git push --force-with-lease origin json-api
git push origin --tags
cd ../..
git add services/convertx    # records the tagged commit, which never dangles
git commit -m "chore: rebase convertx fork onto upstream"
docker compose build convertx
```

If `tests/api/failure-set.test.ts` fails, **stop**. Re-read `mainConverter` and reconcile
`FAILURE_STATUSES` in `src/tools/file-converter/convertx.service.ts` before shipping —
a new failure string that the client treats as success will present a broken file as a
successful conversion.
