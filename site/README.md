# Servify landing page

A static, dependency-free page: `index.html`, `styles.css`, `main.js`, the Geist fonts (SIL OFL, see `fonts/OFL-LICENSE.txt`) and the favicon. It makes no third-party requests.

**Preview locally:**

```bash
python3 -m http.server 4321 --bind 127.0.0.1 --directory site
```

Then open http://localhost:4321.

**Repository link:** `REPO_URL` at the top of `main.js` (and the fallback links in `index.html`) point at https://github.com/m-akcan/servify.

**Hosting:** published to GitHub Pages at https://m-akcan.github.io/servify/ by `.github/workflows/pages.yml` whenever `site/` changes on `master`. Any static host works too: upload the `site/` folder as-is.
