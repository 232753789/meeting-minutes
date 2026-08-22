import { describe, expect, it } from 'vitest'
import { ControlLineSplitter } from '../src/answer.ts'

describe('ControlLineSplitter', () => {
  it('withholds text until the control line is complete', () => {
    const splitter = new ControlLineSplitter()
    expect(splitter.push('ANS')).toEqual({ text: '' })
    expect(splitter.push('WER')).toEqual({ text: '' })
    expect(splitter.push('\n我用过 Kafka。')).toEqual({ decided: 'answer', text: '我用过 Kafka。' })
  })

  it('forwards every later delta verbatim once answering', () => {
    const splitter = new ControlLineSplitter()
    splitter.push('ANSWER\n')
    expect(splitter.push('第一段')).toEqual({ text: '第一段' })
    expect(splitter.push('\n- 要点')).toEqual({ text: '\n- 要点' })
  })

  it('drops everything after a SKIP decision', () => {
    const splitter = new ControlLineSplitter()
    expect(splitter.push('SKIP\n')).toEqual({ decided: 'skip', text: '' })
    expect(splitter.push('这段不该出现')).toEqual({ text: '' })
    expect(splitter.finish()).toEqual({ text: '' })
  })

  it('keeps the first line when the model ignored the format', () => {
    const splitter = new ControlLineSplitter()
    expect(splitter.push('我们团队用的是 Rust。\n还有 Go。')).toEqual({
      decided: 'answer',
      text: '我们团队用的是 Rust。\n还有 Go。',
    })
  })

  it('treats a stream that never emitted a newline as its own answer', () => {
    const splitter = new ControlLineSplitter()
    expect(splitter.push('简短回答')).toEqual({ text: '' })
    expect(splitter.finish()).toEqual({ decided: 'answer', text: '简短回答' })
  })

  it('treats a bare ANSWER with no body as an answer with no text', () => {
    const splitter = new ControlLineSplitter()
    splitter.push('ANSWER')
    expect(splitter.finish()).toEqual({ decided: 'answer', text: '' })
  })

  it('treats a bare SKIP with no newline as a skip', () => {
    const splitter = new ControlLineSplitter()
    splitter.push('SKIP')
    expect(splitter.finish()).toEqual({ decided: 'skip', text: '' })
  })

  it('treats an empty stream as a skip', () => {
    expect(new ControlLineSplitter().finish()).toEqual({ decided: 'skip', text: '' })
  })

  it('accepts a control line with surrounding whitespace and any case', () => {
    const splitter = new ControlLineSplitter()
    expect(splitter.push('  skip  \n')).toEqual({ decided: 'skip', text: '' })
  })

  it('reports nothing further once finish has decided', () => {
    const splitter = new ControlLineSplitter()
    splitter.push('ANSWER\n正文')
    expect(splitter.finish()).toEqual({ text: '' })
  })
})
