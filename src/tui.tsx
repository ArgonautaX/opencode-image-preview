/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import {
  captureClipboard,
  captionOf,
  copyImageToClipboard,
  describeSource,
  imageZones,
  infoLine,
  openInViewer,
  type ImageZone,
  type SourceInfo,
  type ZoneGeometry,
} from "./images"

/** Grace period so the pointer can travel from a token onto the floating card. */
const HOVER_GRACE_MS = 120
/** Slot for the replaced insertText hook, kept on the editor so hot reloads swap it instead of stacking. */
const INSERT_HOOK = Symbol.for("opencode-image-preview.insertText")
const IMAGE_INSERT = /^\[Image (\d+)\]\s*$/

/** The subset of OpenTUI's EditBufferRenderable this plugin reads. */
type ComposerEditor = {
  id: string
  traits?: { role?: string }
  isDestroyed: boolean
  visible: boolean
  plainText: string
  scrollY: number
  screenX: number
  screenY: number
  width: number
  height: number
  cursorOffset: number
  focus(): void
  insertText(text: string): void
  editorView: { getViewport(): { offsetX?: number } }
  lineInfo: { lineStartCols: number[]; lineWidthCols: number[]; lineSources: number[] }
}

/** A hoverable zone bound to the editor it was computed from. */
type Zone = ImageZone & { key: string }

type Hooked = { original: (text: string) => unknown; wrapper: (text: string) => unknown }

function readGeometry(editor: ComposerEditor): ZoneGeometry {
  const viewport = editor.editorView.getViewport()
  const info = editor.lineInfo
  return {
    text: editor.plainText,
    screenX: editor.screenX,
    screenY: editor.screenY,
    width: editor.width,
    height: editor.height,
    scrollY: editor.scrollY,
    offsetX: viewport.offsetX ?? 0,
    lineStartCols: info.lineStartCols,
    lineWidthCols: info.lineWidthCols,
    lineSources: info.lineSources,
  }
}

/**
 * Wraps `insertText` so the plugin notices the exact moment OpenCode turns a
 * paste into an `[Image N]` token: the clipboard still holds that image and can
 * be captured as the preview source. Previous wrappers are replaced, never
 * stacked, so hot reloads stay clean.
 */
function installInsertHook(editor: ComposerEditor, capture: (token: string) => void) {
  const target = editor as ComposerEditor & { [INSERT_HOOK]?: Hooked }
  const previous = target[INSERT_HOOK]
  if (previous && editor.insertText === previous.wrapper) editor.insertText = previous.original
  const original = editor.insertText.bind(editor)
  const wrapper = (text: string) => {
    const result = original(text)
    const match = IMAGE_INSERT.exec(text)
    if (match) capture(`[Image ${match[1]}]`)
    return result
  }
  editor.insertText = wrapper
  target[INSERT_HOOK] = { original, wrapper }
}

/**
 * Invisible hover targets over every `[Image N]` token and every image path in
 * the composer, plus a floating preview card with open/copy actions. The zones
 * live in the root `app` slot so they can sit on top of the composer without
 * disturbing its layout; the text stays visible underneath.
 */
function HoverOverlay(props: { prefs: { readonly enabled: boolean } }) {
  const context = usePlugin()
  const dimensions = useTerminalDimensions()
  const [zones, setZones] = createSignal<Zone[]>([])
  const [hovered, setHovered] = createSignal<Zone | undefined>()
  const [sources, setSources] = createSignal(new Map<string, string>())
  const hooked = new WeakSet<object>()
  let editor: ComposerEditor | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const capture = (editorID: string) => (token: string) => {
    const key = `${editorID}:${token}`
    setSources((current) => {
      const next = new Map(current)
      next.delete(key)
      return next
    })
    void captureClipboard().then((source) => {
      if (!source) return
      setSources((current) => {
        const next = new Map(current)
        next.set(key, source)
        return next
      })
    })
  }

  const cancel = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  const show = (zone: Zone) => {
    cancel()
    setHovered(zone)
  }

  const hide = (zone: Zone) => {
    cancel()
    timer = setTimeout(() => {
      timer = undefined
      setHovered((current) => (current?.key === zone.key ? undefined : current))
    }, HOVER_GRACE_MS)
  }

  const sourceFor = (zone: Zone) => (zone.kind === "path" ? zone.path : sources().get(zone.key))

  const openZone = (zone: Zone) => {
    const source = sourceFor(zone)
    if (!source) return false
    // Like better-claude: opening closes the card; moving the pointer back on
    // the target opens the card again.
    cancel()
    setHovered((current) => (current?.key === zone.key ? undefined : current))
    void openInViewer(source)
    return true
  }

  const copyZone = (zone: Zone) => {
    const source = sourceFor(zone)
    if (!source) return
    void copyImageToClipboard(source).then((ok) => {
      context.ui.toast.show({
        message: ok ? "Image copied to the clipboard" : "Could not copy the image",
        variant: ok ? "success" : "error",
      })
    })
  }

  const onFrame = () => {
    if (!props.prefs.enabled) {
      if (zones().length > 0) setZones([])
      if (hovered() !== undefined) setHovered(undefined)
      return
    }
    const focused = context.renderer.currentFocusedEditor as ComposerEditor | null
    if (focused && (focused.traits as { role?: string } | undefined)?.role === "prompt") editor = focused
    const current = editor
    if (!current || current.isDestroyed || !current.visible) {
      if (zones().length > 0) setZones([])
      return
    }
    if (!hooked.has(current)) {
      hooked.add(current)
      installInsertHook(current, capture(current.id))
    }
    const next = imageZones(readGeometry(current)).map((zone) => ({ ...zone, key: `${current.id}:${zone.text}` }))
    if (JSON.stringify(next) === JSON.stringify(zones())) return
    setZones(next)
    const hoveredKey = hovered()?.key
    if (hoveredKey && !next.some((zone) => zone.key === hoveredKey)) setHovered(undefined)
  }
  context.renderer.on("frame", onFrame)
  onCleanup(() => {
    context.renderer.off("frame", onFrame)
    cancel()
  })

  const source = createMemo(() => {
    const zone = hovered()
    if (!zone) return undefined
    return zone.kind === "path" ? zone.path : sources().get(zone.key)
  })

  const [infos, setInfos] = createSignal(new Map<string, SourceInfo>())

  createEffect(() => {
    const src = source()
    if (!src || infos().has(src)) return
    void describeSource(src).then((info) => {
      setInfos((current) => {
        const next = new Map(current)
        next.set(src, info)
        return next
      })
    })
  })

  const caption = createMemo(() => {
    const zone = hovered()
    if (!zone) return ""
    const src = source()
    const label = captionOf(zone, src)
    const line = infoLine(src === undefined ? {} : (infos().get(src) ?? {}))
    return line ? `${label} · ${line}` : label
  })

  const cardWidth = () => Math.max(24, Math.min(72, dimensions().width - 10))
  const cardHeight = () => Math.max(6, Math.min(22, Math.floor(dimensions().height / 3)))

  const cardTop = () => {
    const zone = hovered()
    if (!zone) return 0
    const total = cardHeight() + 4
    const above = zone.row - total - 1
    if (above >= 0) return above
    return Math.max(0, Math.min(zone.row + 2, dimensions().height - total - 1))
  }

  const cardLeft = () => {
    const zone = hovered()
    if (!zone) return 0
    return Math.max(0, Math.min(zone.col - 1, dimensions().width - cardWidth() - 4))
  }

  return (
    <>
      <For each={zones()}>
        {(zone) => (
          <box
            position="absolute"
            top={zone.row}
            left={zone.col}
            width={zone.width}
            height={1}
            zIndex={2000}
            onMouseOver={() => show(zone)}
            onMouseOut={() => hide(zone)}
            onMouseUp={() => {
              if (openZone(zone)) return
              if (!editor || editor.isDestroyed) return
              editor.focus()
              editor.cursorOffset = zone.start
            }}
          />
        )}
      </For>
      <Show when={hovered()}>
        {(zone) => (
          <box
            position="absolute"
            top={cardTop()}
            left={cardLeft()}
            width={cardWidth() + 2}
            paddingLeft={1}
            paddingRight={1}
            border
            borderStyle="rounded"
            borderColor={context.theme.border.base}
            backgroundColor={context.theme.background.raised.base}
            flexDirection="column"
            zIndex={2001}
            onMouseOver={() => show(zone())}
            onMouseOut={() => hide(zone())}
          >
            <Show
              when={source()}
              fallback={
                <text fg={context.theme.text.muted} wrapMode="none">
                  preview unavailable
                </text>
              }
            >
              {(src) => (
                <image
                  source={src()}
                  fit="fit"
                  protocol="auto"
                  width={cardWidth()}
                  height={cardHeight()}
                  onMouseOver={() => show(zone())}
                  onError={() => {}}
                />
              )}
            </Show>
            <text fg={context.theme.text.muted} wrapMode="none" truncate onMouseOver={() => show(zone())}>
              {caption()}
            </text>
            <Show when={source()}>
              <box flexDirection="row" columnGap={2} onMouseOver={() => show(zone())}>
                <text fg={context.theme.text.muted} wrapMode="none" onMouseUp={() => openZone(zone())}>
                  {"↗ open"}
                </text>
                <text fg={context.theme.text.muted} wrapMode="none" onMouseUp={() => copyZone(zone())}>
                  {"⧉ copy"}
                </text>
              </box>
            </Show>
          </box>
        )}
      </Show>
    </>
  )
}

export default Plugin.define({
  id: "image-preview",
  setup(context) {
    /** Durable preferences: the toggle survives hot reloads and TUI restarts. */
    const [prefs, updatePreferences] = context.storage.store("image-preview.preferences", {
      initial: { enabled: true },
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "image-preview.toggle",
          title: "Toggle image preview",
          description: "Enable or disable the hover previews over [Image N] tokens and image paths",
          group: "Image preview",
          palette: true,
          slash: { name: "image-preview", aliases: ["img-preview"] },
          run: () => {
            const enabled = !prefs.enabled
            void updatePreferences((draft) => {
              draft.enabled = enabled
            })
            context.ui.toast.show({
              message: enabled ? "Image preview enabled" : "Image preview disabled",
              variant: "info",
            })
          },
        },
      ],
    }))

    // The gallery used to open a session panel; close it in case a hot reload
    // replaced the plugin while the panel was still open.
    context.ui.panel.close()
    const overlay = context.ui.slot({
      append: "app",
      render: () => <HoverOverlay prefs={prefs} />,
    })
    return () => overlay()
  },
})
