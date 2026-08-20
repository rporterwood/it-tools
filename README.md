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

### Running it

The `services/convertx` submodule resolves from a public remote, so a recursive
clone gives you a buildable tree:

```sh
git clone --recurse-submodules https://github.com/rporterwood/it-tools
cd it-tools
cp .env.example .env && sed -i "s/replace-me/$(openssl rand -hex 32)/" .env
docker compose up -d
```

The `.env` step is required, not optional: `compose.yaml` declares
`JWT_SECRET=${JWT_SECRET:?set JWT_SECRET in .env}`, so `docker compose` refuses to
start until it is set. `.env.example` is committed with a `replace-me` placeholder
and `.env` itself is gitignored, so your generated secret stays out of git.

If you already cloned without `--recurse-submodules`, or `services/convertx` is
otherwise empty, `git submodule update --init` populates it.

Then open <http://localhost:8080>. The first `docker compose build` downloads
several GB of native converters (LibreOffice, TeX Live, ImageMagick, ffmpeg, and
more) via `apt-get` and takes tens of minutes; later rebuilds reuse the cached apt
layer and take minutes.

Without the backend, it-tools still builds and deploys as a normal static site — the
File converter tool simply reports that its backend is not reachable.

### Deploying prebuilt images (Portainer, or any pull-only host)

`.github/workflows/fork-ghcr.yml` builds both containers in CI — with a recursive
checkout, so the submodule is populated — and pushes `linux/amd64` images to:

- `ghcr.io/rporterwood/it-tools:latest`
- `ghcr.io/rporterwood/convertx:latest`

`compose.ghcr.yaml` is the deploy-only counterpart to `compose.yaml`: same two
services and the same private-`convertx` topology, but pulling those tags instead
of building, and using a named volume for `/app/data`. Paste it into a Portainer
web-editor stack and set `JWT_SECRET` in the stack's environment-variables section
(`openssl rand -hex 32`).

Do **not** deploy this repo as a Portainer *Repository* stack — Portainer's git
clone does not initialise submodules, so `services/convertx` arrives empty and the
build fails. Pull the images instead.

The ConvertX image only rebuilds when the `services/convertx` pointer moves; a
manual run with `rebuild_convertx: true` forces it. Because the image is tagged
with the pinned ConvertX commit as well as `latest`, a stack can pin an exact
converter build when `latest` moving underneath it would be disruptive.

### The ConvertX fork and its pin policy

`services/convertx` tracks <https://github.com/rporterwood/ConvertX>, a fork of
[C4illin/ConvertX](https://github.com/C4illin/ConvertX) carrying the JSON API this
tool talks to. Development happens on the `json-api` branch, which is rebased and
force-pushed freely.

Because of that, the umbrella repo never pins the branch tip. Each verified state
gets a dated tag (`json-api-YYYY-MM-DD`), and the recorded gitlink is that tag's
commit, so a later rebase can't leave `services/convertx` pointing at an object
that no longer exists on the remote. The current pin is
`b97aaa2d0204fdd87689d5415cf1d87ce56d08c1`, tagged `json-api-2026-08-20`.

To move the pin: push the new work to `json-api`, tag the verified commit, push the
tag, then check out that commit in `services/convertx` and commit the updated
gitlink here.

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
