# Licensing

This fork combines two separately licensed works:

- **it-tools** — GNU General Public License v3.0 (see [`LICENSE`](LICENSE))
- **ConvertX** — GNU Affero General Public License v3.0 (see
  [`services/convertx/LICENSE`](services/convertx/LICENSE)), vendored as a git submodule

GPLv3 §13 permits combining a GPLv3 work with an AGPLv3 work. The AGPL's network
clause then applies to the combination, so **this combined work is distributed under
the AGPL-3.0**. The two codebases remain separately licensed works under that umbrella
— each retains its own license file and copyright notices; combining them does not
relicense either codebase individually.

## Written offer of source

If you make this stack available to users over a network (which is the normal way
of running it — see the [File converter section of the README](README.md#file-converter-self-hosted)),
AGPL §13 requires you to offer those users the complete corresponding source,
including any modifications, at no charge.

**Both halves of the source are published, so that offer can be satisfied by
pointing at them:**

- **it-tools side** — <https://github.com/rporterwood/it-tools>, this fork.
- **ConvertX side** — <https://github.com/rporterwood/ConvertX>, on the `json-api`
  branch. The exact commit vendored here as the `services/convertx` submodule is
  `b97aaa2d0204fdd87689d5415cf1d87ce56d08c1`, tagged `json-api-2026-08-20`; the tag
  is what the pin resolves to, so it stays fetchable even though `json-api` itself
  is rebased. The upstream ConvertX license terms this fork's modifications are made
  under still apply — see [`services/convertx/LICENSE`](services/convertx/LICENSE).

Running it only for yourself, on a machine only you can reach, does not trigger §13;
making it reachable by anyone else does.

Publishing the source above satisfies the *availability* side of §13 for the code as
vendored here. It does not discharge §13 for anyone else: if you redistribute this
stack, or run a **modified** copy that other people can reach over a network, you
owe your own users the complete corresponding source of *your* version, including
your modifications — and these URLs do not contain them.

## Not legal advice

> This is the maintainer's reading of the licenses, not verified legal advice.
> If you intend to distribute or publicly host this stack, get your own advice.
