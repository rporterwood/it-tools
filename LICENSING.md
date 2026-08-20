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

This project satisfies that obligation as follows:

- The source for this fork (it-tools side) is available at the repository you cloned
  it from.
- The source for the ConvertX fork is available at the URL recorded in
  [`.gitmodules`](.gitmodules), pinned to the exact commit vendored as the
  `services/convertx` submodule.

If you redistribute this stack yourself — including running a modified copy that
other people can reach over a network — you take on that same AGPL §13 obligation
for your own users and your own modifications.

## Not legal advice

> This is the maintainer's reading of the licenses, not verified legal advice.
> If you intend to distribute or publicly host this stack, get your own advice.
