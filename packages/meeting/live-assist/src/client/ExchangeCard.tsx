/** One counterpart question and the answers suggested for it, as stacked chat bubbles. */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AnswerTrackState } from './exchange-definition.ts'
import css from './ExchangeCard.module.css'

type ExchangeCardProps =
  PropsRuntime<'conversation.chat.node', 'live-assist-exchange'> & PropsLocale<'live-assist'>

/** One track's bubble: its own placeholder until text arrives, then the text itself. */
function AnswerBubble({ state, waiting, label, detailed }: {
  readonly state: AnswerTrackState
  readonly waiting: string
  readonly label?: string
  readonly detailed?: boolean
}) {
  return (
    <div className={css.track}>
      {label === undefined ? null : <div className={css.label}>{label}</div>}
      {state.text === ''
        ? <div className={css.waiting}>{waiting}</div>
        : <div className={detailed === true ? css.detailed : css.answer}>{state.text}</div>}
    </div>
  )
}

/**
 * Render one exchange.
 *
 * The question stays visible from the moment it is recognized, so the interviewee can check the
 * transcript while the answers are still arriving beneath it. The short answer is on top because
 * it lands first and is the one that can be said out loud immediately; the detailed answer grows
 * below it. Each track carries a label only when both are present, since a Host without a deep
 * route has nothing to distinguish.
 * @param props - the projected exchange node and this surface's dictionary.
 * @returns the stacked question and answer bubbles.
 */
export function ExchangeCard({ node, t }: ExchangeCardProps) {
  const { question, seconds, fast, deep, skipped } = node.data
  return (
    <div className={css.exchange}>
      <div className={css.question}>
        {question}
        <div className={css.meta}>{t('exchange.heard', { seconds: seconds.toFixed(1) })}</div>
      </div>
      {skipped !== undefined
        ? <div className={css.skipped}>{t('answer.skipped')}</div>
        : (
          <>
            <AnswerBubble
              state={fast}
              waiting={t('state.thinking')}
              {...(deep === undefined ? {} : { label: t('answer.fast') })}
            />
            {deep === undefined
              ? null
              : <AnswerBubble state={deep} waiting={t('state.thinkingDeep')} label={t('answer.deep')} detailed />}
          </>
        )}
    </div>
  )
}
