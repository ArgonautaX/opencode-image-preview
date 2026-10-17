# opencode-image-preview

Hover image previews for the [OpenCode](https://opencode.ai) v2 TUI.

Inspired by [`better-claude`'s image-preview](https://github.com/midudev/better-claude) by [midudev](https://github.com/midudev).

> Status: early work in progress, developed against OpenCode `2.0.32`.

## What it does

- **Composer band**: while a message with images is queued in the session's inbox, a band above the prompt lists each image as a `[Image #N]` chip.
- **Hover preview**: hover a chip and a floating card shows the picture (with format and file name) right above the band; move the pointer away and it closes. Click the chip to open the image in your system viewer (Preview on macOS).
- **Gallery**: run `/images` (or `Image gallery` from the command palette, `ctrl+p`) to list every image of the session — queued and sent, including images returned by tools — with thumbnails, hover previews and click-to-open.

Rendering is done by [OpenTUI](https://opentui.com)'s `<image>` renderable, so the picture uses the best protocol each terminal supports:

| Terminal | Protocol |
| --- | --- |
| Ghostty, kitty, WezTerm, iTerm2 | Kitty graphics (crisp pixels) |
| Terminals with Sixel | Sixel |
| tmux and everything else | Unicode blocks (layout is visible, text is not readable) |

## Draft and sent previews (native settings)

OpenCode v2 renders attached and sent images itself when you enable both options in `~/.config/opencode/cli.json`:

```json
{
  "prompt": { "image_preview": true },
  "session": { "image_preview": true }
}
```

- `prompt.image_preview`: thumbnails above the prompt input while you write (up to 3, then "+N more").
- `session.image_preview`: real thumbnails inside the sent message and in tool results; click one for a full preview with ←/→ navigation.

This plugin complements those with the queued-image band (hover card), the session gallery (`/images`) and click-to-open in the system viewer.

## Install

```sh
opencode plugin add opencode-image-preview
```

> Not published to npm yet. Until then, configure a local path:

```jsonc
// opencode.json
{
  "plugins": ["/absolute/path/to/opencode-image-preview"]
}
```

For the TUI part with local paths, OpenCode looks for `tui.tsx` (or `tui/index.ts`) at the root of the plugin directory — this repo has that entry, so pointing at the checkout works.

## Development

OpenCode v2 discovers local plugins from `.opencode/plugins/` in the project. This repo ships a symlink there so running `opencode` inside the checkout loads the plugin with hot reload:

```text
.opencode/plugins/opencode-image-preview -> ../..
```

```sh
bun test        # unit tests for the image extraction helpers
bun run typecheck
```

## How it works

- `src/images.ts` extracts images from the session's public data: queued inbox items (`session.pending`) and sent messages (`session.message`), where user attachments and completed tool file results carry either a `data:` URI or a file URL.
- `src/tui.tsx` registers the composer band (`session.composer.top` slot), the gallery (`session.panel` slot + a palette/slash command) and renders `<image protocol="auto">` previews.
- Clicking materializes inline images into a temp file under `opencode-image-preview/` and opens them with the system viewer.

### Why the band shows queued images, not the live draft

OpenCode 2.0.32 does not expose the composer's in-progress attachments to plugins, so a plugin cannot know which images you are about to send while you type. For the draft and the transcript, use the native options above; this plugin covers what plugins can see: the queued inbox (hover cards) and the whole session (gallery).

## License

MIT. The interaction is inspired by midudev's better-claude (MIT); no code is shared.
