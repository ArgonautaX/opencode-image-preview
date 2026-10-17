import type { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"

type Context = Plugin.Context

export type SessionImage = {
  key: string
  number: number
  mime: string
  name?: string
  /** A data URI or a local file path, ready for <image source>. */
  source: string
  queued: boolean
}

const isImage = (mime: string | undefined): mime is string => Boolean(mime?.startsWith("image/"))

const base64ish = (value: string) => value.length > 0 && /^[A-Za-z0-9+/=\r\n]+$/.test(value.slice(0, 64))

function fromData(data: string, mime: string): string | undefined {
  if (data.startsWith("data:")) return data
  if (base64ish(data)) return `data:${mime};base64,${data}`
  return undefined
}

function fromUri(uri: string): string | undefined {
  if (uri.startsWith("data:")) return uri
  if (uri.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(uri).pathname)
    } catch {
      return undefined
    }
  }
  if (uri.startsWith("/")) return uri
  return undefined
}

type FileAttachment = {
  data: string
  mime: string
  name?: string
  source?: { type: "inline" } | { type: "uri"; uri: string }
}

function attachmentSource(file: FileAttachment): string | undefined {
  if (file.source?.type === "uri") {
    const source = fromUri(file.source.uri)
    if (source) return source
  }
  return fromData(file.data, file.mime)
}

function fileImage(file: FileAttachment, key: string, queued: boolean): SessionImage | undefined {
  if (!isImage(file.mime)) return undefined
  const source = attachmentSource(file)
  if (!source) return undefined
  return { key, number: 0, mime: file.mime, name: file.name, source, queued }
}

/** Images waiting in the session's inbox (queued prompts). */
export function pendingImages(context: Context, sessionID: string): SessionImage[] {
  const items = context.data.session.pending.list(sessionID) ?? []
  const images: SessionImage[] = []
  for (const item of items) {
    if (item.type !== "user") continue
    const files = item.payload.files ?? []
    files.forEach((file, index) => {
      const image = fileImage(file, `pending:${item.id}:${index}`, true)
      if (image) images.push(image)
    })
  }
  return images.map((image, index) => ({ ...image, number: index + 1 }))
}

/** Images sent in the session, oldest first: user attachments and completed tool file results. */
export function messageImages(context: Context, sessionID: string): SessionImage[] {
  const messages = context.data.session.message.list(sessionID) ?? []
  const images: SessionImage[] = []
  for (const message of messages) {
    if (message.type === "user") {
      const files = message.files ?? []
      files.forEach((file, index) => {
        const image = fileImage(file, `message:${message.id}:${index}`, false)
        if (image) images.push(image)
      })
      continue
    }
    if (message.type !== "assistant") continue
    for (const part of message.content ?? []) {
      if (part.type !== "tool") continue
      const state = part.state
      if (state.status !== "completed") continue
      for (const content of state.content ?? []) {
        if (content.type !== "file") continue
        if (!isImage(content.mime)) continue
        const source = fromUri(content.uri)
        if (!source) continue
        images.push({
          key: `tool:${message.id}:${part.id}:${images.length}`,
          number: 0,
          mime: content.mime,
          name: content.name ?? undefined,
          source,
          queued: false,
        })
      }
    }
  }
  return images
}

/** Every image of the session: queued ones first, then sent ones, deduplicated and numbered. */
export function sessionImages(context: Context, sessionID: string): SessionImage[] {
  const seen = new Set<string>()
  const images: SessionImage[] = []
  for (const image of [...pendingImages(context, sessionID), ...messageImages(context, sessionID)]) {
    const fingerprint = `${image.mime}:${image.source.length}:${image.source.slice(0, 96)}`
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    images.push({ ...image, number: images.length + 1 })
  }
  return images
}

const extensionFor = (mime: string, fallback?: string) => {
  if (fallback && extname(fallback)) return extname(fallback)
  const subtype = mime.split("/")[1]?.split("+")[0] ?? "png"
  return `.${subtype === "jpeg" ? "jpg" : subtype}`
}

const safeName = (image: SessionImage) => {
  const extension = extensionFor(image.mime, image.name)
  const stem = (image.name ?? `image-${image.number}`).replace(/[^A-Za-z0-9._-]+/g, "_")
  return stem.toLowerCase().endsWith(extension) ? stem : `${stem}${extension}`
}

/** Writes an inline image to a temp file so external programs can open it. */
async function materialize(image: SessionImage): Promise<string | undefined> {
  if (!image.source.startsWith("data:")) return image.source
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(image.source)
  if (!match) return undefined
  const [, , base64, payload] = match
  const directory = join(tmpdir(), "opencode-image-preview")
  await mkdir(directory, { recursive: true })
  const file = join(directory, safeName(image))
  await writeFile(file, Buffer.from(payload, base64 ? "base64" : "utf8"))
  return file
}

/** Opens the image in the system viewer: Preview on macOS, the desktop default elsewhere. */
export async function openImageInViewer(image: SessionImage): Promise<void> {
  const file = await materialize(image).catch(() => undefined)
  if (!file) return
  const command =
    process.platform === "darwin"
      ? ["open", "-a", "Preview", file]
      : process.platform === "win32"
        ? ["explorer", file]
        : ["xdg-open", file]
  const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: "ignore" })
  child.unref()
}

export const captionOf = (image: SessionImage) =>
  `[Image #${image.number}] ${image.mime.replace("image/", "").toUpperCase()}${image.name ? ` · ${image.name}` : ""}`
