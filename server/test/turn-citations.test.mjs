import assert from 'node:assert/strict'
import test from 'node:test'
import { TurnCitations } from '../src/voice/turn-citations.mjs'

test('assigns stable per-turn citation ids across retrieval calls', () => {
  const citations = new TurnCitations()
  const first = citations.project('turn-1', {
    results: [
      { title: 'Alpha', url: 'https://example.com/a', citation_id: 'source_1' },
      { title: 'Beta', url: 'https://example.com/b', citation_id: 'source_2' },
    ],
    citations: [
      { id: 'source_1', title: 'Alpha', url: 'https://example.com/a' },
      { id: 'source_2', title: 'Beta', url: 'https://example.com/b' },
    ],
  })
  const second = citations.project('turn-1', {
    results: [
      { title: 'Beta again', url: 'https://example.com/b', citation_id: 'source_1' },
      { title: 'Gamma', url: 'https://example.com/c', citation_id: 'source_2' },
    ],
    citations: [
      { id: 'source_1', title: 'Beta again', url: 'https://example.com/b' },
      { id: 'source_2', title: 'Gamma', url: 'https://example.com/c' },
    ],
  })

  assert.deepEqual(first.results.map(result => result.citation_id), [
    'source_1',
    'source_2',
  ])
  assert.deepEqual(second.results.map(result => result.citation_id), [
    'source_2',
    'source_3',
  ])
  assert.deepEqual(citations.consume('turn-1').map(source => source.id), [
    'source_1',
    'source_2',
    'source_3',
  ])
  assert.deepEqual(citations.consume('turn-1'), [])
})

test('bounds citations retained for one turn', () => {
  const citations = new TurnCitations({ maxCitationsPerTurn: 1 })
  const output = citations.project('turn-1', {
    results: [
      { title: 'One', url: 'https://example.com/1' },
      { title: 'Two', url: 'https://example.com/2' },
    ],
    citations: [
      { title: 'One', url: 'https://example.com/1' },
      { title: 'Two', url: 'https://example.com/2' },
    ],
  })

  assert.equal(output.results.length, 1)
  assert.equal(output.citations.length, 1)
  assert.equal(citations.consume('turn-1').length, 1)
})
