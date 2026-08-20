<picture>
    <source srcset="./.github/logo-dark.png" media="(prefers-color-scheme: light)">
    <source srcset="./.github/logo-white.png" media="(prefers-color-scheme: dark)">
    <img src="./.github/logo-dark.png" alt="logo">
</picture>

<p align="center">
Useful tools for developer and people working in IT. <a href="https://it-tools.tech">Try it!</a>
</p>

## Functionalities and roadmap

Please check the [issues](https://github.com/CorentinTh/it-tools/issues) to see if some feature listed to be implemented.

You have an idea of a tool? Submit a [feature request](https://github.com/CorentinTh/it-tools/issues/new/choose)!

## Self host

Self host solutions for your homelab

**From docker hub:**

```sh
docker run -d --name it-tools --restart unless-stopped -p 8080:80 corentinth/it-tools:latest
```

**From github packages:**

```sh
docker run -d --name it-tools --restart unless-stopped -p 8080:80 ghcr.io/corentinth/it-tools:latest
```

**Other solutions:**

- [Cloudron](https://www.cloudron.io/store/tech.ittools.cloudron.html)
- [Tipi](https://www.runtipi.io/docs/apps-available)
- [Unraid](https://unraid.net/community/apps?q=it-tools)

## File converter (self-hosted)

This fork adds a **File converter** tool backed by a companion
[ConvertX](https://github.com/C4illin/ConvertX) service, which converts between
1000+ formats using ffmpeg, LibreOffice, ImageMagick, pandoc and others. It ships as
a second container in the `compose.yaml` at the repo root and is not part of the
plain Docker Hub / GHCR images above.

> **This currently only builds in this exact checkout.** The `services/convertx`
> submodule is pinned to a commit on `json-api`, a branch of the ConvertX fork that
> has never been pushed anywhere — `.gitmodules` still points at the upstream
> `C4illin/ConvertX` repository, which does not and will never contain that commit.
> The commit's objects live only in *this* working copy's `.git/modules/services/convertx`.
> A plain `git clone --recurse-submodules` of this repo — from this machine or any
> other — cannot fetch it: it will fail with something like `Fetched in submodule
> path 'services/convertx', but it did not contain <sha>…`, leaving
> `services/convertx` empty and `compose.yaml`'s `build: ./services/convertx` with
> nothing to build. See "Publishing the ConvertX fork" below for how to make this
> distributable.

### Running it

From this checkout, where `services/convertx` is already populated with `json-api`:

```sh
cp .env.example .env && sed -i "s/replace-me/$(openssl rand -hex 32)/" .env
docker compose up -d
```

If `services/convertx` is ever emptied in this same checkout (e.g. after `git
submodule deinit`), `git submodule update --init` restores it without touching the
network — the commit is already present locally at `.git/modules/services/convertx`.
That recovery path does **not** work from a different clone; see the note above.

Then open <http://localhost:8080>. The first `docker compose build` downloads
several GB of native converters (LibreOffice, TeX Live, ImageMagick, ffmpeg, and
more) via `apt-get` and takes tens of minutes; later rebuilds reuse the cached apt
layer and take minutes.

Without the backend, it-tools still builds and deploys as a normal static site — the
File converter tool simply reports that its backend is not reachable.

### Publishing the ConvertX fork

The local-only setup above is a deliberate, temporary state, not a bug. To make the
`services/convertx` submodule resolvable from a fresh clone elsewhere:

1. **Push `json-api` to a fork you control** — e.g. push it to your own
   `ConvertX` fork on GitHub rather than upstream `C4illin/ConvertX`, which you
   don't have write access to:
   ```sh
   cd services/convertx
   git remote add fork <your-fork-url>   # or: git push <your-fork-url> json-api
   git push fork json-api
   ```
2. **Tag the verified state**, per the spec's pin policy (`json-api` is force-pushed
   freely on rebase, so the umbrella repo must pin an immutable tag, not the branch
   tip):
   ```sh
   git tag json-api-YYYY-MM-DD
   git push fork json-api-YYYY-MM-DD
   ```
3. **Repoint `.gitmodules`** in the it-tools root to `fork`'s URL instead of
   `https://github.com/C4illin/ConvertX.git`, then `git submodule sync`.
4. **Re-record the gitlink** — commit the updated `.gitmodules` together with the
   `services/convertx` submodule pointer now sitting at the tagged commit.
5. **Verify with a throwaway clone**: `git clone --recurse-submodules <this repo's
   remote URL> /tmp/verify-clone` and confirm `services/convertx` is populated, not
   empty, before relying on it anywhere else.

This is also the prerequisite for opening the upstream ConvertX PR the JSON API was
designed for (see the design spec, D7) — that PR needs a public branch to point at,
not a local-only one.

### Read this before exposing it

The stack runs ConvertX in unauthenticated shared mode
(`ALLOW_UNAUTHENTICATED=true`, `UNAUTHENTICATED_USER_SHARING=true` in
`compose.yaml`). That pins every job to the same synthetic user, and job ids are
sequential integers, so the ownership check every route performs
(`WHERE id = ? AND user_id = ?`) passes for any caller on any job:

> **Anyone who can reach the stack can enumerate every job and download every file
> anyone has converted.**

There is also **no rate limiting** anywhere in front of ConvertX. Both are
deliberate trade-offs for a trusted LAN or a single-user homelab, not oversights —
do not expose this stack to the internet without adding real authentication and
rate limiting in front of it.

Converted files and their originals are deleted after roughly 24 hours
(`AUTO_DELETE_EVERY_N_HOURS`, set in `compose.yaml`).

### Manual verification checklist

Nothing in this repo's CI or test suite exercises the native converter binaries —
ffmpeg, LibreOffice, ImageMagick/vips, pandoc, and the rest exist only inside the
`services/convertx` Docker image, not on the machine running `pnpm test`. This
checklist is the **only** coverage those binaries get, so run it by hand after any
`docker compose build convertx` that touches the converter image:

- [ ] ImageMagick/vips: convert a `.png` to `.webp`
- [ ] ffmpeg: convert a `.mp4` to `.webm`
- [ ] LibreOffice: convert a `.docx` to `.pdf`
- [ ] pandoc: convert a `.md` to `.html`
- [ ] Failure path: upload a deliberately corrupt file and confirm the UI renders
      `Failed, check logs` instead of silently offering a broken download

### Licensing

ConvertX is vendored as a submodule under its own AGPL-3.0 license, distinct from
this project's GPLv3 license. See [`LICENSING.md`](LICENSING.md) for how the two
combine and what that means if you redistribute this stack.

## Contribute

### Recommended IDE Setup

[VSCode](https://code.visualstudio.com/) with the following extensions:

- [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur)
- [TypeScript Vue Plugin (Volar)](https://marketplace.visualstudio.com/items?itemName=Vue.vscode-typescript-vue-plugin).
- [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)
- [i18n Ally](https://marketplace.visualstudio.com/items?itemName=lokalise.i18n-ally)

with the following settings:

```json
{
  "editor.formatOnSave": false,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "i18n-ally.localesPaths": ["locales", "src/tools/*/locales"],
  "i18n-ally.keystyle": "nested"
}
```

### Type Support for `.vue` Imports in TS

TypeScript cannot handle type information for `.vue` imports by default, so we replace the `tsc` CLI with `vue-tsc` for type checking. In editors, we need [TypeScript Vue Plugin (Volar)](https://marketplace.visualstudio.com/items?itemName=Vue.vscode-typescript-vue-plugin) to make the TypeScript language service aware of `.vue` types.

If the standalone TypeScript plugin doesn't feel fast enough to you, Volar has also implemented a [Take Over Mode](https://github.com/johnsoncodehk/volar/discussions/471#discussioncomment-1361669) that is more performant. You can enable it by the following steps:

1. Disable the built-in TypeScript Extension
   1. Run `Extensions: Show Built-in Extensions` from VSCode's command palette
   2. Find `TypeScript and JavaScript Language Features`, right click and select `Disable (Workspace)`
2. Reload the VSCode window by running `Developer: Reload Window` from the command palette.

### Project Setup

```sh
pnpm install
```

### Compile and Hot-Reload for Development

```sh
pnpm dev
```

### Type-Check, Compile and Minify for Production

```sh
pnpm build
```

### Run Unit Tests with [Vitest](https://vitest.dev/)

```sh
pnpm test
```

### Lint with [ESLint](https://eslint.org/)

```sh
pnpm lint
```

### Create a new tool

To create a new tool, there is a script that generate the boilerplate of the new tool, simply run:

```sh
pnpm run script:create:tool my-tool-name
```

It will create a directory in `src/tools` with the correct files, and a the import in `src/tools/index.ts`. You will just need to add the imported tool in the proper category and develop the tool.

## Contributors

Big thanks to all the people who have already contributed!

[![contributors](https://contrib.rocks/image?repo=corentinth/it-tools&refresh=1)](https://github.com/corentinth/it-tools/graphs/contributors)

## Credits

Coded with ❤️ by [Corentin Thomasset](https://corentin.tech?utm_source=it-tools&utm_medium=readme).

This project is continuously deployed using [vercel.com](https://vercel.com).

Contributor graph is generated using [contrib.rocks](https://contrib.rocks/preview?repo=corentinth/it-tools).

<a href="https://www.producthunt.com/posts/it-tools?utm_source=badge-featured&utm_medium=badge&utm_souce=badge-it&#0045;tools" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=345793&theme=light" alt="IT&#0032;Tools - Collection&#0032;of&#0032;handy&#0032;online&#0032;tools&#0032;for&#0032;devs&#0044;&#0032;with&#0032;great&#0032;UX | Product Hunt" style="width: 250px; height: 54px;" width="250" height="54" /></a>
<a href="https://www.producthunt.com/posts/it-tools?utm_source=badge-top-post-badge&utm_medium=badge&utm_souce=badge-it&#0045;tools" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=345793&theme=light&period=daily" alt="IT&#0032;Tools - Collection&#0032;of&#0032;handy&#0032;online&#0032;tools&#0032;for&#0032;devs&#0044;&#0032;with&#0032;great&#0032;UX | Product Hunt" style="width: 250px; height: 54px;" width="250" height="54" /></a>

## License

This project is under the [GNU GPLv3](LICENSE). This fork also vendors ConvertX, a
separately AGPL-3.0-licensed work — see [`LICENSING.md`](LICENSING.md) for how the
two combine.
