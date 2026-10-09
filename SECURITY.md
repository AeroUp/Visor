# Security

Visor handles Roblox sign-ins, so security reports are taken seriously.

**To report a problem, don't open a public issue.** Use [Report a vulnerability](../../security/advisories/new) on this repo, which is private between you and the maintainer.

## How Visor protects your account

- **Sign-in happens on roblox.com's own page,** inside a sandboxed window. Visor never sees or stores your password.
- **Each saved account gets its own cookie jar.** Release builds encrypt those cookies at rest using Windows' data protection (DPAPI), through Electron's cookie-encryption fuse.
- **Signed-in requests only go to Roblox domains.** Links can only open `https://*.roblox.com`.
- **The interface is locked down.** The overlay runs sandboxed, with context isolation and a strict Content Security Policy. Untrusted text, such as chat messages and game names, is never inserted as HTML.
- **Release builds disable Electron's debugging and `ELECTRON_RUN_AS_NODE` entry points,** and verify the integrity of their own app archive.
