// The preshow row, pure parts (serg/tasks#1955): what is pasted into the draft right now.
//   Before a submit the plugin sees only the draft's text, and a pasted picture sits in it as
//   an `[Image #N]` placeholder — the pixels ($.prompt.media) exist only inside prompt.submit.
//   So the preview is the placeholders themselves: which slots the draft holds, not the pictures.
import type { Part } from './context'

/** An `[Image #N]` placeholder of the draft text. */
export const IMAGE_RE = /\[Image #\d+\]/g

/** The image placeholders of a draft, in order of appearance; duplicates kept as pasted. */
export function imagesOf(text: unknown): string[] {
  return typeof text === 'string' ? text.match(IMAGE_RE) ?? [] : []
}

export type PreshowRow = { mark: string; parts: Part[] }

const MARK = '▣ '

// `▣ [Image #1] [Image #2]`, the placeholders shown while the row fits `inner`, the rest as
// ` +N`; null with no images, or narrower than the mark and the first placeholder.
export function preshowRow(images: string[], inner: number): PreshowRow | null {
  if (images.length === 0) return null
  const width = (shown: number, hidden: number) => {
    const suffix = hidden > 0 ? ` +${hidden}` : ''
    return MARK.length + images.slice(0, shown).join(' ').length + suffix.length
  }
  let shown = images.length
  while (shown > 1 && width(shown, images.length - shown) > inner) shown--
  const hidden = images.length - shown
  if (width(shown, hidden) > inner) return null
  const parts: Part[] = [{ text: images.slice(0, shown).join(' ') }]
  if (hidden > 0) parts.push({ text: ` +${hidden}`, dim: true })
  return { mark: MARK, parts }
}
