import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureCorpusRelease } from '../src/installer.js'
import { CorpusStore } from '../src/store.js'

const dir = await mkdtemp(join(tmpdir(), 'prts-real-dl-'))
console.log('download dir:', dir)
const started = Date.now()
try {
  const result = await ensureCorpusRelease({
    releasesDir: dir,
    logger: { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) },
  })
  console.log('result:', result, `elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`)
  const store = new CorpusStore({ releasesDir: dir })
  await store.ready()
  console.log('store:', store.releaseId, 'docs=', store.documents.size, 'packs=', store.packs.size)
  const { executeSearch } = await import('../src/search.js')
  const hit = await executeSearch(store, { query: '阿米娅', character_names: ['阿米娅'], max_results: 2 })
  console.log('search status:', hit.status, 'hits:', hit.hits?.length, hit.hits?.[0]?.title)
} finally {
  await rm(dir, { recursive: true, force: true })
  console.log('cleaned')
}
