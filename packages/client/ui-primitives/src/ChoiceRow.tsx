/** One selectable feature row: leading glyph, name, and a sentence about what it does. */

import type { ReactNode } from 'react'
import clsx from 'clsx'
import css from './ChoiceRow.module.css'

/** Content and behavior of one choice row. */
export interface ChoiceRowProps {
  /** Leading glyph, rendered in the row's secondary ink. */
  icon: ReactNode
  /** The feature's name (the row's accessible name). */
  title: string
  /** One sentence saying what picking this row does; wraps to at most two lines. */
  description?: string | undefined
  /** Trailing status text (a running feature's state), kept on one line. */
  status?: string | undefined
  /** Invoked on click and on keyboard activation. */
  onSelect: () => void
  disabled?: boolean | undefined
  className?: string | undefined
}

/**
 * Render a full-width row users pick a feature from.
 * @param props - the row's glyph, copy, and selection callback.
 * @returns the row button.
 */
export function ChoiceRow({
  icon, title, description, status, onSelect, disabled = false, className,
}: ChoiceRowProps): ReactNode {
  return (
    <button
      type="button"
      className={clsx(css.row, className)}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className={css.icon} aria-hidden>{icon}</span>
      <span className={css.text}>
        <span className={css.title}>{title}</span>
        {description !== undefined && <span className={css.description}>{description}</span>}
      </span>
      {status !== undefined && <span className={css.status}>{status}</span>}
    </button>
  )
}
