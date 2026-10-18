# opencode-image-preview

Hover previews for images pasted into the [OpenCode](https://opencode.ai) v2 prompt.

Inspired by [`better-claude`'s image-preview](https://github.com/midudev/better-claude) by [midudev](https://github.com/midudev).

> Status: early work in progress, developed against OpenCode `2.0.32`.

## Requirements

- OpenCode `2.0.32` or later (the plugin reads the composer editor internals).
- macOS or Linux for the clipboard capture; on any other platform the card shows
  `preview unavailable`.
- A terminal with an image protocol for crisp pixels (Ghostty, kitty, WezTerm,
  iTerm2 or Sixel); anywhere else the preview falls back to Unicode blocks.

## What it does

Paste an image into the prompt and OpenCode turns it into an `[Image N]` token in
the composer. While that token is there — before you send anything — hover it and
a floating card shows the picture, with the same card following the pointer onto
it so it does not flicker. Move the pointer away and the card closes. Click a
token to open the image in your system viewer (Preview on macOS) and close the
card; when the capture is missing, the click places the editor cursor on the
token instead.

That is the whole plugin: no strip above the prompt, no gallery, no commands. The
preview only appears while you hover.

Rendering is done by [OpenTUI](https://opentui.com)'s `<image>` renderable, so the
picture uses the best protocol each terminal supports:

| Terminal | Protocol |
| --- | --- |
| Ghostty, kitty, WezTerm, iTerm2 | Kitty graphics (crisp pixels) |
| Terminals with Sixel | Sixel |
| tmux and everything else | Unicode blocks (layout is visible, text is not readable) |

## How it works

OpenCode 2.0.32 does not expose the composer's in-progress attachments to
plugins, so this plugin works around that by watching the composer editor
renderable itself:

- On every render frame it reads the focused editor (`traits.role === "prompt"`)
  and computes the on-screen rectangle of each `[Image N]` token from the buffer
  text, line info, scroll offset and layout.
- It wraps the editor's `insertText` so it sees the exact moment a paste becomes
  an `[Image N]` token, and captures the image from the system clipboard right
  then — the clipboard still holds what you pasted. Both a copied image
  (captured as PNG, converting TIFF when needed) and pasted path text (captured
  as a file path) work.
- Invisible hover targets are rendered from the root `app` slot, absolutely
  positioned on top of each token, so the token text stays visible and the
  composer layout is untouched.

The capture is a best effort: if the clipboard no longer holds the image, or the
platform has no clipboard reader (only macOS and Linux are implemented), the
card shows `preview unavailable` for that token.

Clicking a token writes the capture to a temp file (`$TMPDIR/opencode-image-preview/`,
named after the payload so repeated clicks reuse the same file) and opens it with
the system viewer: `open -a Preview` on macOS, `explorer` on Windows and
`xdg-open` elsewhere — the same commands better-claude uses.

## Composer and transcript

OpenCode can draw its own image thumbnails, but they are off by default and this
plugin is meant to be used that way: images stay out of the way and only appear
when you hover.

```json
// ~/.config/opencode/cli.json
{
  "prompt": { "image_preview": false },
  "session": { "image_preview": false }
}
```

Both options can be turned on if you prefer the native thumbnails on top of the
plugin's hover previews.

## Install

```sh
opencode plugin add opencode-image-preview
```

> Not published to npm yet. Until then, configure a local checkout with **exactly one** source:

**Global symlink** — the plugin loads in every project and hot reload works because the watcher follows the symlink to the real files:

```sh
ln -s /absolute/path/to/opencode-image-preview ~/.config/opencode/plugins/opencode-image-preview
```

**Project symlink** — only when running OpenCode inside the checkout:

```text
.opencode/plugins/opencode-image-preview -> ../..
```

> Use one source, not both. OpenCode loads each discovered directory as its own plugin, so two paths pointing at the same code register the id twice: the extra copies fail with `Duplicate plugin ID: image-preview` and the status bar shows `plugins failed`. For the same reason, do not add `"./"` to the `plugins` array of `opencode.json`.

## Uninstall

Remove the source you configured and restart OpenCode:

```sh
rm ~/.config/opencode/plugins/opencode-image-preview
```

If you used the project symlink (`.opencode/plugins/opencode-image-preview`) or a
`plugins` entry in `opencode.json`, remove those instead. Optionally turn the
native thumbnails back on in `~/.config/opencode/cli.json`.

## Development

Any of the two install paths above doubles as the dev loop: saving a file reloads the plugin in a running TUI (the watcher subscribes to the resolved paths).

```sh
bun test        # unit tests for the pure helpers
bun run typecheck
```

`src/images.ts` holds the pure logic (token scanning, display width, zone
geometry, clipboard parsing) and `src/tui.tsx` the overlay component. The zone
math is verified end to end in a tmux session by simulating SGR mouse moves; if
you do that, remove any test plugins from the location first — two plugins
rendering zones at the same cells shadow each other in the hit grid and the
hover appears broken.

## Branches

- `main` — released code, tagged for releases; only receives merges from `develop`.
- `develop` — integration branch; every feature and fix lands here first.
- `feature/<name>`, `fix/<name>`, `docs/<name>`, `chore/<name>` — one unit of
  work each, branched from `develop` and merged back with `git merge --no-ff`
  (or a pull request) once `bun test` and `bun run typecheck` pass.

## License

MIT. The interaction is inspired by midudev's better-claude (MIT); no code is shared.
