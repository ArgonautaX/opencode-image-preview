/** @jsxImportSource @opentui/solid */
import type { MouseEvent } from "@opentui/core"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { captionOf, openImageInViewer, pendingImages, sessionImages, type SessionImage } from "./images"

const GALLERY = "image-preview.gallery"

function Chip(props: {
  image: SessionImage
  hovered: boolean
  onOver: () => void
  onOut: () => void
  onUp: () => void
}) {
  const context = usePlugin()
  return (
    <text
      fg={props.hovered ? context.theme.text.base : context.theme.text.muted}
      onMouseOver={props.onOver}
      onMouseOut={props.onOut}
      onMouseUp={props.onUp}
      wrapMode="none"
    >
      {`[Image #${props.image.number}]`}
    </text>
  )
}

function PreviewCard(props: { image: SessionImage; width: number; height: number }) {
  const context = usePlugin()
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={context.theme.border.base}
      backgroundColor={context.theme.background.raised.base}
      flexDirection="column"
      width={props.width + 2}
      paddingLeft={1}
      paddingRight={1}
      zIndex={100}
    >
      <image
        source={props.image.source}
        fit="fit"
        protocol="auto"
        width={props.width}
        height={props.height}
        onError={() => {}}
      />
      <text fg={context.theme.text.muted} wrapMode="none" truncate>
        {captionOf(props.image)}
      </text>
    </box>
  )
}

function ImageBand(props: { sessionID: string }) {
  const context = usePlugin()
  const dimensions = useTerminalDimensions()
  const [hovered, setHovered] = createSignal<SessionImage | undefined>()
  const images = createMemo(() => pendingImages(context, props.sessionID))

  onMount(() => {
    void context.data.session.pending.sync(props.sessionID).catch(() => {})
  })

  const cardWidth = () => Math.max(24, Math.min(72, dimensions().width - 10))
  const cardHeight = () => Math.max(6, Math.min(22, Math.floor(dimensions().height / 3)))

  return (
    <Show when={images().length > 0}>
      <box width="100%" flexDirection="column" position="relative" flexShrink={0}>
        <Show when={hovered()}>
          {(image) => (
            <box position="absolute" bottom={2} left={1} zIndex={100}>
              <PreviewCard image={image()} width={cardWidth()} height={cardHeight()} />
            </box>
          )}
        </Show>
        <box flexDirection="row" columnGap={1} height={1} flexShrink={0}>
          <For each={images()}>
            {(image) => (
              <Chip
                image={image}
                hovered={hovered()?.key === image.key}
                onOver={() => setHovered(image)}
                onOut={() => setHovered((current) => (current?.key === image.key ? undefined : current))}
                onUp={() => void openImageInViewer(image)}
              />
            )}
          </For>
          <text fg={context.theme.text.faint} wrapMode="none">
            hover to preview · click to open
          </text>
        </box>
      </box>
    </Show>
  )
}

function Gallery(props: { panel: PanelInput }) {
  const context = usePlugin()
  const dimensions = useTerminalDimensions()
  const [hovered, setHovered] = createSignal<SessionImage | undefined>()
  const images = createMemo(() => sessionImages(context, props.panel.sessionID))

  onMount(() => {
    void context.data.session.pending.sync(props.panel.sessionID).catch(() => {})
    void context.data.session.message.sync(props.panel.sessionID).catch(() => {})
  })

  const previewWidth = () => Math.max(24, Math.min(72, dimensions().width - 12))
  const previewHeight = () => Math.max(6, Math.min(24, Math.floor(dimensions().height / 3)))

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <text fg={context.theme.text.base} wrapMode="none">
        {`Session images (${images().length})`}
      </text>
      <Show when={images().length === 0}>
        <text fg={context.theme.text.muted} wrapMode="none">
          No images yet. Paste one into the prompt with ctrl+v, then send it.
        </text>
      </Show>
      <Show when={hovered()}>
        {(image) => <PreviewCard image={image()} width={previewWidth()} height={previewHeight()} />}
      </Show>
      <box flexDirection="column" flexGrow={1} flexShrink={1}>
        <For each={images()}>
          {(image) => (
            <box
              flexDirection="row"
              columnGap={1}
              height={6}
              flexShrink={0}
              onMouseOver={() => setHovered(image)}
              onMouseOut={() => setHovered((current) => (current?.key === image.key ? undefined : current))}
              onMouseUp={() => void openImageInViewer(image)}
            >
              <image
                source={image.source}
                fit="cover"
                protocol="auto"
                width={12}
                height={6}
                onError={() => {}}
              />
              <box flexDirection="column" flexGrow={1}>
                <text fg={hovered()?.key === image.key ? context.theme.text.base : context.theme.text.muted} wrapMode="none" truncate>
                  {captionOf(image)}
                </text>
                <text fg={context.theme.text.faint} wrapMode="none" truncate>
                  {image.queued ? "queued" : "sent"} · hover to preview · click to open
                </text>
              </box>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "image-preview",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: GALLERY,
          title: "Image gallery",
          description: "Browse and preview the images of this session",
          group: "Image preview",
          palette: true,
          slash: { name: "images", aliases: ["img"] },
          run: () => {
            if (!context.ui.panel.open(GALLERY)) {
              context.ui.toast.show({ message: "Open a session to browse its images", variant: "info" })
            }
          },
        },
      ],
    }))

    const band = context.ui.slot({
      append: "session.composer.top",
      render: (input) => <ImageBand sessionID={input.sessionID} />,
    })

    const panel = context.ui.slot({
      append: "session.panel",
      render: (input) => (
        <Show when={input.name === GALLERY}>
          <Gallery panel={input} />
        </Show>
      ),
    })

    return () => {
      band()
      panel()
    }
  },
})
