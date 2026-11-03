import { describe, it, expect, vi } from 'vitest'
import { createStore, createLookup } from './vanilla'

vi.mock('react', () => {
  throw new Error('the vanilla entry imported react')
})

describe('vanilla entry', () => {
  it('loads and runs without react', () => {
    const docs = createLookup((id: string) => ({ id, title: '' }))
    const app = createStore({ count: 0, docs })
    const seen: number[] = []
    app.subscribe(['count'], () => seen.push(app.getKey('count')))
    app.increment('count')
    app.select('docs').at('a').setKey('title', 'A')
    expect(seen).toEqual([1])
    expect(app.select('docs').at('a').getKey('title')).toBe('A')
  })
})
