/**
 * Geometry shared by the editor and its stand-in, so the swap moves nothing:
 * same font, same line height, same padding, same height.
 */

export const LINE_HEIGHT = 20;
export const FONT_SIZE = 12.5;
/** Vertical padding inside the editor (half above the first line, half below the last). */
export const PAD = 8;
/** Monaco's `lineDecorationsWidth` with line numbers, glyph margin and folding off. */
export const TEXT_LEFT = 6;
/** Monaco's vertical scrollbar, which Monaco keeps clear of wrapped text. */
export const SCROLLBAR = 8;
export const FONT_FAMILY = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace';

export function editorHeight(lines: number, minLines: number, maxLines: number, lineHeight: number) {
  return Math.min(maxLines, Math.max(minLines, lines)) * lineHeight + PAD;
}
