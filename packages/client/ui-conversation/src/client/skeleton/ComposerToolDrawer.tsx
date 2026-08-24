/**
 * Composer tool drawer: the `conversation.input.tool` entries as one icon row
 * in the composer's tool row, plus an expandable panel naming and describing
 * each of them.
 */

import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronUpOutline14, Tooltip, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationSlotProps, InputZone } from '../contract/slots.ts'
import css from './ComposerToolDrawer.module.css'

/** What the drawer needs from the conversation root: the ledger, the currency, and one render share. */
export interface ComposerToolDrawerProps {
  /** Tool entry ids projected from the slot ledger (subscribed here, not by the root). */
  tools: {
    list: () => readonly string[]
    subscribe: (fn: () => void) => () => void
    version: () => number
  }
  /** The input-region currency every entry reads. */
  zone: InputZone
  /** The root's render share, narrowed to the tool slot at the call site. */
  renderSlot: ConversationSlotProps['renderSlot']
  /** The conversation dictionary. */
  t: ConversationSlotProps['t']
}

/**
 * Render the tool row's icon seats and the drawer that names them.
 * @param props - the ledger, the input-region currency, and the render/locale shares.
 * @returns the drawer, or null while no tool is registered.
 */
export function ComposerToolDrawer({ tools, zone, renderSlot, t }: ComposerToolDrawerProps): ReactNode {
  useSyncExternalStore(tools.subscribe, tools.version)
  const ids = tools.list()
  const [expanded, setExpanded] = useState(false)
  // One open tool at a time: the dialogs are modal, and the drawer row and the
  // row icon must reach the same one.
  const [openId, setOpenId] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useDismissOnOutsidePointer(root, expanded, setExpanded)

  // Identity per entry id so a tool's props stay stable across drawer toggles.
  const openers = useRef(new Map<string, (open: boolean) => void>())
  const openerFor = useCallback((id: string): ((open: boolean) => void) => {
    const existing = openers.current.get(id)
    if (existing !== undefined) return existing
    const opener = (open: boolean): void => {
      setOpenId(current => (open ? id : current === id ? null : current))
      // Opening from the drawer hands the screen to that tool's own surface;
      // leaving the panel up would cover it.
      if (open) setExpanded(false)
    }
    openers.current.set(id, opener)
    return opener
  }, [])

  if (ids.length === 0) return null

  const seat = (id: string, surface: 'bar' | 'drawer'): ReactNode => renderSlot(
    'conversation.input.tool',
    { ...zone, surface, open: openId === id, setOpen: openerFor(id) },
    { only: id },
  )

  return (
    <div ref={root} className={css.root}>
      <div className={css.icons}>
        {ids.map(id => <span key={id} className={css.icon}>{seat(id, 'bar')}</span>)}
      </div>
      <Tooltip label={t('tools.drawer')} side="top" delayMs={500}>
        <button
          type="button"
          className={clsx(css.toggle, expanded && css.toggleExpanded)}
          aria-label={t('tools.drawer')}
          aria-expanded={expanded}
          onClick={() => { setExpanded(open => !open) }}
        >
          <IconChevronUpOutline14 size={12} />
        </button>
      </Tooltip>
      {expanded && (
        <div className={css.panel} role="group" aria-label={t('tools.drawer')}>
          {ids.map(id => <div key={id} className={css.row}>{seat(id, 'drawer')}</div>)}
        </div>
      )}
    </div>
  )
}
