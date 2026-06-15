# Deploying the Jakarta AQI site to GitHub Pages

The site in this `web/` folder is **fully static** (HTML/CSS/JS + JSON data), so GitHub
Pages can serve it for free with no backend.

> ⚠️ **Push ONLY this `web/` folder — never the whole project root.**
> The project root contains the Kaggle data mirror and a flagged Copernicus API key
> (see `docs/PROJECT_STATUS.md` §6). Initialising git at the root would risk publishing
> data and secrets. The steps below `cd` into `web/` and make *that* the repo, so the
> public repository contains only the website.

---

## 0. Prerequisites

- **git** — installed (`git version 2.54`).
- **A GitHub account.**
- `gh` (GitHub CLI) is **not** installed here, so the steps use plain `git` + the GitHub
  web UI. (Optional `gh` path is at the bottom.)

## 1. Build the data (already done for the preview)

```powershell
# Coming-soon / preview build (current state — no forecast numbers yet):
python web/build_web_data.py --mode pending

# After the pm25_conc re-train + NB8 re-run lands, swap in real forecasts:
python web/build_web_data.py --mode live
```

Both write to `web/data/` and need no front-end change.

## 2. Create an empty repo on GitHub

Go to <https://github.com/new>, name it e.g. **`jakarta-aqi-web`**, set it **Public**
(Pages is free for public repos), and **do not** add a README/.gitignore/license
(the folder already has its files). Click *Create repository*.

## 3. Push the `web/` folder

In PowerShell, from the project:

```powershell
cd "C:\Users\Lenovo\Documents\AQI research data Kaggle Notebook Jupyter\web"
git init
git add .
git commit -m "Jakarta AQI website (preview)"
git branch -M main
git remote add origin https://github.com/<YOUR-USERNAME>/jakarta-aqi-web.git
git push -u origin main
```

(Replace `<YOUR-USERNAME>`. On first push, git will prompt you to authenticate to GitHub.)

## 4. Turn on GitHub Pages

In the new repo: **Settings → Pages → Build and deployment**
→ **Source: Deploy from a branch** → **Branch: `main` / `(root)`** → **Save**.

After ~1 minute the site is live at:

```
https://<YOUR-USERNAME>.github.io/jakarta-aqi-web/
```

All asset paths in the site are **relative** (`style.css`, `app.js`, `data/...`), so it
works correctly under that `/jakarta-aqi-web/` sub-path with no extra config. The
`.nojekyll` file (already present) tells Pages to serve the files as-is.

> Geolocation ("Locate me") needs HTTPS — GitHub Pages serves HTTPS, so it works in
> production. Locally it only works on `localhost`.

## 5. Updating the live site later

```powershell
cd "C:\Users\Lenovo\Documents\AQI research data Kaggle Notebook Jupyter\web"
python ..\web\build_web_data.py --mode live   # or --mode pending
git add data
git commit -m "Update forecast data"
git push
```

GitHub Pages redeploys automatically on every push to `main`.

---

## Optional: one-liner with the GitHub CLI

If you later install [`gh`](https://cli.github.com/) and run `gh auth login`:

```powershell
cd "C:\Users\Lenovo\Documents\AQI research data Kaggle Notebook Jupyter\web"
git init; git add .; git commit -m "Jakarta AQI website (preview)"
gh repo create jakarta-aqi-web --public --source=. --push
```

Then enable Pages as in step 4 (or `gh` will offer it).

---

## Notes

- **Custom domain:** add it under Settings → Pages → Custom domain, and create a
  `CNAME` file in this folder.
- **Tiles & libraries** (Leaflet, Chart.js, h3-js, OpenStreetMap tiles) load from public
  CDNs at runtime, so the page needs internet access — fine on GitHub Pages.
- This deploys the **static demonstrator**. Serving a *live, on-demand* model is a
  separate, possibly-paid stage (a Python backend host) — see `docs/PROJECT_STATUS.md` §10.
