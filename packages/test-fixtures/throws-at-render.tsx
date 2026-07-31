// Typechecks fine, throws at render — `inkdeck check` must exit 1 because the
// key paints its error tile.

import { Deck, Key } from '@jackadamson/inkdeck'

function Boom(): never {
  throw new Error('kaboom')
}

export default function App() {
  return (
    <Deck>
      <Key position={0}>
        <Boom />
      </Key>
    </Deck>
  )
}
