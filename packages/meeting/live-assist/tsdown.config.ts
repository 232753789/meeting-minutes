import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-live-assist',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
