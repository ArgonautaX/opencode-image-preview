/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { captureClipboard, captionOf, imageZones, openInViewer, type ImageZone, type ZoneGeometry } from "./images"

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
 * Invisible hover targets over every `[Image N]` token of the composer, plus a
 * floating preview card. The zones live in the root `app` slot so they can sit
 * on top of the composer without disturbing its layout; the token text stays
 * visible underneath.
 */
function HoverOverlay() {
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

  const onFrame = () => {
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
    return sources().get(zone.key)
  })

  const cardWidth = () => Math.max(24, Math.min(72, dimensions().width - 10))
  const cardHeight = () => Math.max(6, Math.min(22, Math.floor(dimensions().height / 3)))

  const cardTop = () => {
    const zone = hovered()
    if (!zone) return 0
    const total = cardHeight() + 3
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
              const captured = sources().get(zone.key)
              if (captured) {
                // Like better-claude: the click opens the image and closes the
                // card; moving the pointer back on the token opens it again.
                cancel()
                setHovered((current) => (current?.key === zone.key ? undefined : current))
                void openInViewer(captured)
                return
              }
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
              {captionOf(zone(), source())}
            </text>
          </box>
        )}
      </Show>
    </>
  )
}

export default Plugin.define({
  id: "image-preview",
  setup(context) {
    // The gallery used to open a session panel; close it in case a hot reload
    // replaced the plugin while the panel was still open.
    context.ui.panel.close()
    const overlay = context.ui.slot({
      append: "app",
      render: () => <HoverOverlay />,
    })
    return () => overlay()
  },
})
