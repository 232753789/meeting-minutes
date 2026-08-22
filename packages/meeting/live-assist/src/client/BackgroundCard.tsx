/** The background material one listening run was opened with, shown in full. */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './BackgroundCard.module.css'

type BackgroundCardProps =
  PropsRuntime<'conversation.chat.node', 'live-assist-background'> & PropsLocale<'live-assist'>

/**
 * Render the material verbatim.
 *
 * Every answer request in the run carries exactly this text, so it is not truncated or
 * summarized here: what is on screen is what the model was given.
 * @param props - the projected background node and this surface's dictionary.
 * @returns the material, or a note that the run was opened without any.
 */
export function BackgroundCard({ node, t }: BackgroundCardProps) {
  const { background } = node.data
  return (
    <div className={css.background}>
      <div className={css.title}>{t('background.title')}</div>
      {background.trim() === ''
        ? <div className={css.empty}>{t('background.empty')}</div>
        : <div className={css.material}>{background}</div>}
    </div>
  )
}
