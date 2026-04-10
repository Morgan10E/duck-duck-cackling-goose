# Duck Duck Cackling Goose

A small browser game: tell two **iNaturalist** species apart from research-grade photos. Defaults to **Cackling Goose** vs **Canada Goose**; you can switch to other preset pairs (finches, swallows) in **Species pair** settings. The static site lives in **`docs/`** for [GitHub Pages](https://pages.github.com/).

## Development

Install dependencies (Node 18+ recommended):

```bash
npm install
```

Compile TypeScript (source in [`src/app.ts`](src/app.ts)) to the deployed script:

```bash
npm run build
```

This writes [`docs/app.js`](docs/app.js). Edit **`src/app.ts`**, not `docs/app.js`, then run `npm run build` before committing.

A **Husky** [`.husky/pre-commit`](.husky/pre-commit) hook runs `npm run build` and stages `docs/app.js` so commits stay in sync with TypeScript. If you commit without `npm install`, install hooks with `npm install` first.

## Run locally

From the repository root:

```bash
npx --yes serve docs
```

Open the URL it prints (for example `http://localhost:3000`). Use a local server so `localStorage` and cookies behave reliably; opening `index.html` directly as a `file://` URL can be flaky.

## iNaturalist access

The game loads photos with **anonymous** `fetch` requests to `https://api.inaturalist.org/v1/observations` (no login, no API token). You may still see **HTTP 403** from the API under heavy use or WAF rules; the game retries automatically.

Each round picks a **random time within the last year**, queries observations for the taxon with `d1`/`d2`, sorts by `observed_on` descending, and uses the **most recent observation at or before** that time (scanning up to a few pages if needed). The response must match the requested `taxon_id` and include photos.

On first load, any legacy **`ddcg_inat_jwt`** value in `localStorage` from an older build is cleared.

## Preset species pairs (taxon IDs)

| Pair | Species A (left button) | Species B (right button) |
|------|-------------------------|--------------------------|
| Geese (default) | Cackling Goose `59220` | Canada Goose `7089` |
| Finches | Purple Finch `199841` | House Finch `199840` |
| Swallows | Violet-green Swallow `11931` | Tree Swallow `11935` |

IDs follow [iNaturalist](https://www.inaturalist.org/) taxa; verify on the taxon page if names change.

## Deploy on GitHub Pages

1. Create a new repository on GitHub (for example `duck-duck-cackling-goose`).
2. From this project directory:

   ```bash
   git init
   git add .
   git commit -m "Add Duck Duck Cackling Goose game"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```

3. On GitHub: **Settings → Pages → Build and deployment**.
4. Under **Branch**, choose **`main`** and folder **`/docs`**, then save.
5. After a minute or two, the site will be at:

   `https://YOUR_USERNAME.github.io/YOUR_REPO/`

## Project layout

| Path | Purpose |
|------|--------|
| `src/app.ts` | TypeScript source (game, API, storage) |
| `docs/app.js` | Compiled output (run `npm run build`) |
| `docs/index.html` | Page structure, statistics and settings modals |
| `docs/styles.css` | Layout and theme |
| `docs/.nojekyll` | Disables Jekyll so odd paths are not mis-processed |

**Storage:** Active species pair and **per-pair** stats (streaks, totals, confusion matrix) live in **`localStorage`** under `ddcg_v2`. A legacy **`ddcg_stats`** cookie from older builds is migrated once into the default geese pair (`59220-7089`) and then cleared.

## API

The game calls `https://api.inaturalist.org/v1/observations` with `quality_grade=research`, `photos=true`, `order_by=observed_on`, `order=desc`, date bounds `d1`/`d2`, and the active pair’s taxon IDs. Photo credit uses the observation’s observer login from the API response.
