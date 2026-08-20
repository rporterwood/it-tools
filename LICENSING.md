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

**That obligation is not currently satisfied, and this stack is not currently
exposed to any users over a network.** Status as of this writing:

- The source for this fork (it-tools side) is available at the repository you cloned
  it from.
- The source for the ConvertX fork is **not currently published anywhere**. It
  exists only as a local branch (`json-api`) in this checkout's `services/convertx`
  submodule — it was never pushed to `.gitmodules`' recorded URL (upstream
  `C4illin/ConvertX`) or to any other remote. See the README's
  ["Publishing the ConvertX fork"](README.md#publishing-the-convertx-fork) section
  for exactly what publishing it involves. Until that is done, source is available
  on request from the maintainer. The upstream ConvertX license terms this fork's
  modifications are made under are unaffected by this and still apply — see
  [`services/convertx/LICENSE`](services/convertx/LICENSE).

**If this stack is ever made available to users over a network — including a
homelab instance reachable by anyone other than you — the ConvertX fork's source
must be published first**, following the README steps referenced above, before
AGPL §13's written-offer obligation can be satisfied. Running it only for yourself,
on a machine only you can reach, does not trigger §13; making it reachable by
anyone else does.

If you redistribute this stack yourself — including running a modified copy that
other people can reach over a network — you take on that same AGPL §13 obligation
for your own users and your own modifications, and the same "not currently
published" gap applies to you until you close it.

## Not legal advice

> This is the maintainer's reading of the licenses, not verified legal advice.
> If you intend to distribute or publicly host this stack, get your own advice.
