# Duck Duck Cackling Goose

A small browser game: guess **Cackling Goose** vs **Canada Goose** from research-grade photos on [iNaturalist](https://www.inaturalist.org/). The static site lives in **`docs/`** for [GitHub Pages](https://pages.github.com/).

## Run locally

From the repository root:

```bash
npx --yes serve docs
```

Open the URL it prints (for example `http://localhost:3000`). Use a local server so cookies behave reliably; opening `index.html` directly as a `file://` URL can be flaky.

## iNaturalist access

The game loads photos with **anonymous** `fetch` requests to `https://api.inaturalist.org/v1/observations` (no login, no API token). You may still see **HTTP 403** from the API under heavy use or WAF rules; the game retries automatically.

**Pagination limit:** that endpoint returns **403** when `page` is greater than **200** (with typical `per_page` such as 50), which caps usable results at about **the first 10,000** observations per taxon. The game wraps its per-species photo cursor inside that window so common taxa (e.g. Canada Goose) do not request illegal pages.

On first load, any legacy **`ddcg_inat_jwt`** value in `localStorage` from an older build is cleared; it is no longer used.

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
| `docs/index.html` | Page structure and stats modal |
| `docs/styles.css` | Layout and theme |
| `docs/app.js` | iNaturalist API, game loop, cookie stats |
| `docs/.nojekyll` | Disables Jekyll so odd paths are not mis-processed |

Stats (streaks, percentages, and per-species **observation cursor** `cacklingGooseIndex` / `canadaGooseIndex` for cycling photos in order) are stored in a cookie named `ddcg_stats` on your site’s origin.

## API

The game calls `https://api.inaturalist.org/v1/observations` with `quality_grade=research`, `photos=true`, and taxon IDs **59220** (Cackling Goose) and **7089** (Canada Goose). Photo credit uses the observation’s observer login from the API response.
