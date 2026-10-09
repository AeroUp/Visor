# Changelog

## 1.0.2

- **Server-join toast:** the Visor badge is now drawn as a single image, so the mark stays centered at every Windows display scale, and it's centered on how it looks rather than on its outline.

## 1.0.1

- **Server-join toast:** the Visor mark is now centered in its badge.
- **Widgets:** the resize handle is a thin arc that follows the widget's rounded corner. It appears when you hover a widget and turns green when you grab it, instead of a grey bracket that was always visible.

## 1.0.0

The first public release.

- **Overlay:** opens with one hotkey and pops up over the Roblox window with a quick fade-and-rise animation (reduced-motion is respected). A bottom bar shows your profile, the game you're in and a session timer.
- **Widgets:** Servers (with server hop), Accounts, Badges, Game history, Games, Messages, Notes and Settings. Pinned widgets stay visible while the overlay is closed.
- **Multi-account:** works out which account is in each Roblox window, lets you join as any saved account, and has **Join my server**.
- **Server-join toasts:** "Connected to public server · Location" notifications in the corner.
- **Shipping:**
  - a one-click installer, plus a portable zip;
  - automatic updates from GitHub Releases;
  - signed-in cookies encrypted at rest by Windows;
  - hardened Electron settings.
