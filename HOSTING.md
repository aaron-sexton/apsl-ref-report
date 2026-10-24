# Hosting the forms (fixes the "multiple Google accounts" problem)

When a phone or laptop is signed in to more than one Google account, links to an Apps Script web app can
open as `script.google.com/macros/u/1/s/...` and fail to load. Neither form needs to be served by Google
any more: the pages are plain HTML that can be hosted anywhere, and they talk to Apps Script by a simple
POST that carries no Google sign-in at all. Signed out, one account or six, it works the same.

| Page | File in this repo | Public address (GitHub Pages) |
| --- | --- | --- |
| Referee Match Report | `index.html` | `https://<pages-address>/apsl-ref-report/` |
| Club Post-Match Report | `team-report/index.html` | `https://<pages-address>/apsl-ref-report/team-report/` |

`<pages-address>` is `aaron-sexton.github.io`, or your custom domain if the account has one set.

## One-time switch (about 10 minutes)

1. **Publish the pages.** Repo → Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
   Open both addresses above and note the exact URLs.
2. **Connect each page to its script.** In each Apps Script project: Deploy → Manage deployments → copy the
   **Web app URL** (ends in `/exec`). Paste it into `CONFIG.endpoint` near the top of the script block:
   - referee script's link → `index.html` (`endpoint: "PASTE_APPS_SCRIPT_WEB_APP_URL_HERE"`)
   - club script's link → `team-report/index.html` (`endpoint: "PASTE_CLUB_FORM_WEB_APP_URL_HERE"`)

   Commit. Pages updates in a minute or two.
3. **Point emailed links at the pages.** In each `Code.gs`, set `WEB_APP_URL` to that page's GitHub Pages
   address from step 1. Use the full address, not a tinyurl: the resume (`?r=`) and correction (`?edit=`)
   links add to the end of it, and short-link services don't reliably pass that through.
4. **Update both scripts.** Paste the new `Code.gs`, then Deploy → Manage deployments → pencil → Version: **New version** → Deploy.
   The `/exec` link stays the same. The Index HTML file in Apps Script can stay; it's the fallback.
5. **Repoint the short link.** Edit tinyurl.com/apsl-ref-report to the referee page's GitHub Pages address.
   TeamPass doesn't need to change anything.
6. **Test on the phone that failed before**, with all accounts still signed in: open the form, save a
   pre-match checklist, open the resume link from the email, submit.

## How it works

- Opened from GitHub Pages: each server call is `POST /exec` with body `{"action": "...", "args": [...]}` sent as
  `text/plain` (no CORS preflight, no cookies). `doPost` in `Code.gs` runs the named function and returns JSON.
  Only the functions listed in `API` can be called.
- Opened from the old `/exec` link: it still works exactly as before (`google.script.run`), so nothing breaks
  for anyone using an old link during the switch.
