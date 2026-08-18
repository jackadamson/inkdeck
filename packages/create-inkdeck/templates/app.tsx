// Reference example (SPEC §14): macOS mic-mute key. Polls the input volume via
// osascript, shows MUTED/LIVE, toggles on press with an optimistic update that
// the next poll reconciles. Acceptance vehicle for M1–M4.

import { useCallback, useState } from 'react'
import { Deck, Key, exec, usePoller } from '@jackadamson/inkdeck'
import type { InkdeckConfig } from '@jackadamson/inkdeck'

export const config: InkdeckConfig = { model: 'mk2' }

const READ_VOLUME = ['osascript', '-e', 'input volume of (get volume settings)']
const setVolume = (level: number) => ['osascript', '-e', `set volume input volume ${level}`]

export default function App() {
  const [muted, setMuted] = useState<boolean | null>(null)

  const { refresh } = usePoller(async () => {
    const { stdout, exitCode } = await exec(READ_VOLUME)
    if (exitCode === 0) {
      const volume = Number.parseInt(stdout.trim(), 10)
      if (!Number.isNaN(volume)) setMuted(volume === 0)
    }
  }, 1000)

  const toggle = useCallback(async () => {
    const next = !(muted ?? false)
    setMuted(next) // optimistic…
    await exec(setVolume(next ? 0 : 75))
    refresh() // …then reconcile immediately instead of waiting for the next poll
  }, [muted, refresh])

  const bg = muted === null ? 'bg-[#374151]' : muted ? 'bg-[#b91c1c]' : 'bg-[#0a7d33]'
  const label = muted === null ? '?' : muted ? 'MUTED' : 'LIVE'

  return (
    <Deck>
      <Key position={0} onPress={toggle}>
        <div className={`flex h-full w-full flex-col items-center justify-center gap-1 ${bg}`}>
          <span className="text-[12px] uppercase tracking-wide text-white/70">mic</span>
          <span className="text-[18px] font-bold text-white">{label}</span>
        </div>
      </Key>
    </Deck>
  )
}
