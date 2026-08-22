/** One counterpart question and the answer suggested for it, as stacked chat bubbles. */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ExchangeCard.module.css'

type ExchangeCardProps =
  PropsRuntime<'conversation.chat.node', 'live-assist-exchange'> & PropsLocale<'live-assist'>

/**
 * Render one exchange.
 *
 * The question stays visible from the moment it is recognized, so the interviewee can check the
 * transcript while the answer is still arriving beneath it.
 * @param props - the projected exchange node and this surface's dictionary.
 * @returns the stacked question and answer bubbles.
 */
export function ExchangeCard({ node, t }: ExchangeCardProps) {
  const { question, seconds, answer, status } = node.data
  return (
    <div className={css.exchange}>
      <div className={css.question}>
        {question}
        <div className={css.meta}>{t('exchange.heard', { seconds: seconds.toFixed(1) })}</div>
      </div>
      {status === 'skipped'
        ? <div className={css.skipped}>{t('answer.skipped')}</div>
        : answer === ''
          ? <div className={css.waiting}>{t('state.thinking')}</div>
          : <div className={css.answer}>{answer}</div>}
    </div>
  )
}
