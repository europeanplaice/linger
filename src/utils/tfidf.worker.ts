import { buildIndex, type TfIdfDoc } from './tfidf'

interface BuildRequest {
  generation: number
  docs: TfIdfDoc[]
}

self.onmessage = (event: MessageEvent<BuildRequest>) => {
  const { generation, docs } = event.data
  const index = buildIndex(docs)
  self.postMessage({ generation, index })
}
