// Starter app: a counter with no external dependencies — works on any deck
// model, in the simulator, and in headless CI. Key 0 shows the count, key 1
// increments, key 2 decrements, long-pressing key 0 resets.
//
// For polling external state with exec() (mocked in tests), see the mic-mute
// example: https://github.com/jackadamson/inkdeck/tree/main/examples/mic-mute

import { useState } from 'react'
import { Deck, Key } from '@jackadamson/inkdeck'
import type { InkdeckConfig } from '@jackadamson/inkdeck'

export const config: InkdeckConfig = { defaultModel: 'mk2' }

export default function App() {
  const [count, setCount] = useState(0)
  const tone = count === 0 ? 'bg-[#374151]' : count > 0 ? 'bg-[#0a7d33]' : 'bg-[#b91c1c]'

  return (
    <Deck>
      <Key position={0} onLongPress={() => setCount(0)} longPressMs={600}>
        <div className={`flex h-full w-full flex-col items-center justify-center gap-1 ${tone}`}>
          <span className="text-[11px] uppercase tracking-wide text-white/70">count</span>
          <span className="text-[24px] font-bold text-white">{String(count)}</span>
        </div>
      </Key>
      <Key position={1} onPress={() => setCount((c) => c + 1)}>
        <div className="flex h-full w-full items-center justify-center bg-[#1d4ed8]">
          <span className="text-[28px] font-bold text-white">+</span>
        </div>
      </Key>
      <Key position={2} onPress={() => setCount((c) => c - 1)}>
        <div className="flex h-full w-full items-center justify-center bg-[#7c3aed]">
          <span className="text-[28px] font-bold text-white">−</span>
        </div>
      </Key>
    </Deck>
  )
}
