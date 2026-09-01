# SecRefs documentation site

[Mintlify](https://mintlify.com) source for the user-facing docs. The design
documents in [`../docs`](../docs) are internal architecture notes and are
deliberately not published here.

## Local preview

```bash
npm i -g mint
cd docs-site
mint dev
```

## Deploying

Mintlify builds from this directory on push to `main` once the GitHub app is
installed and pointed at `docs-site/`. Nothing in CI publishes it, so there is
no secret or token for this in the repo.

## Conventions

- Every page in `docs.json` navigation must have a matching `.mdx`, or the
  build fails on a broken link.
- Code samples are copied from working code, not written freehand. If a sample
  changes, run it.
- Tradeoffs get stated at the same volume as benefits — see
  `guides/load-time-vs-use-time.mdx`, which leads with the availability cost of
  the thing the product is for.
