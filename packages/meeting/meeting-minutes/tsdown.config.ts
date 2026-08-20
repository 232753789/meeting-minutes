import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-meeting-minutes',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
