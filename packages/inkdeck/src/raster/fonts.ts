// Explicit font loading — the determinism mechanism (SPEC §6.1). Takumi cannot
// see system fonts; every glyph comes from file data. Inter (OFL) regular +
// bold ship in assets/fonts and are always registered; apps add faces via
// `export const config = { fonts: [...] }`.

import { join } from 'node:path'
import type { Renderer } from '@takumi-rs/core'

const FONT_DIR = join(import.meta.dir, 'assets', 'fonts')

export const DEFAULT_FONT_FAMILY = 'Inter'

export const BUNDLED_FONTS = [join(FONT_DIR, 'Inter-Regular.ttf'), join(FONT_DIR, 'Inter-Bold.ttf')]

export async function registerBundledFonts(renderer: Renderer): Promise<void> {
  for (const path of BUNDLED_FONTS) {
    const data = await Bun.file(path).bytes()
    await renderer.registerFont({ data, name: DEFAULT_FONT_FAMILY })
  }
}

/** Register app-provided faces (config.fonts), resolved relative to the app file. */
export async function registerAppFonts(renderer: Renderer, fontPaths: string[], appDir: string): Promise<string[]> {
  const families: string[] = []
  for (const fontPath of fontPaths) {
    const resolved = fontPath.startsWith('/') ? fontPath : join(appDir, fontPath)
    const file = Bun.file(resolved)
    if (!(await file.exists())) {
      throw new Error(
        `[inkdeck] config.fonts entry "${fontPath}" not found (checked ${resolved}). Use a path relative to the app file or an absolute path.`,
      )
    }
    const registered = await renderer.registerFont({ data: await file.bytes() })
    for (const family of registered) {
      if (!families.includes(family.name)) families.push(family.name)
    }
  }
  return families
}
