# Servify landing page

A static, dependency-free page: `index.html`, `styles.css`, `main.js`, the Geist fonts (SIL OFL, see `fonts/OFL-LICENSE.txt`) and the favicon. It makes no third-party requests.

**Preview locally:**

```bash
python3 -m http.server 4321 --bind 127.0.0.1 --directory site
```

Then open http://localhost:4321.

**Before publishing:** set `REPO_URL` at the top of `main.js` to the real repository. The GitHub links in `index.html` also carry the placeholder as a no-JavaScript fallback.

**Hosting:** any static host works (GitHub Pages, Cloudflare Pages, Netlify). Upload the `site/` folder as-is.
