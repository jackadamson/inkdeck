import { createContext } from 'react'
import type { DeckController } from './controller.js'

export const DeckContext = createContext<DeckController | null>(null)
