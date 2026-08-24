import { describe, expect, it } from 'vitest'
import { QuestionAccumulator, questionTextIsComplete } from '../src/question-segmentation.ts'

describe('QuestionAccumulator', () => {
  it('holds a fragment that ends in a continuation and releases it with the next fragment', () => {
    const accumulator = new QuestionAccumulator()

    expect(accumulator.push({ index: 1, text: '你在上一家公司主要负责', seconds: 1.2 })).toEqual([])
    expect(accumulator.push({ index: 2, text: '支付系统，后来为什么要重新设计缓存层', seconds: 2.4 })).toEqual([
      { sourceIndex: 2, text: '你在上一家公司主要负责支付系统，后来为什么要重新设计缓存层', seconds: 3.6 },
    ])
  })

  it('splits multiple questions in one VAD fragment', () => {
    const accumulator = new QuestionAccumulator()

    expect(accumulator.push({
      index: 1,
      text: '为什么重新设计缓存层？另外流量增加之后怎么处理？',
      seconds: 4,
    })).toEqual([
      { sourceIndex: 1, text: '为什么重新设计缓存层？', seconds: 4 },
      { sourceIndex: 2, text: '另外流量增加之后怎么处理？', seconds: 4 },
    ])
  })

  it('flushes a final fragment when the recognizer closes', () => {
    const accumulator = new QuestionAccumulator()
    accumulator.push({ index: 3, text: '你们的发布流程如果', seconds: 1 })

    expect(accumulator.flush()).toEqual([
      { sourceIndex: 3, text: '你们的发布流程如果', seconds: 1 },
    ])
    expect(accumulator.flush()).toEqual([])
  })
})

describe('questionTextIsComplete', () => {
  it('recognizes both punctuation and question cues without punctuation', () => {
    expect(questionTextIsComplete('你做过哪些缓存优化？')).toBe(true)
    expect(questionTextIsComplete('你做过哪些缓存优化')).toBe(true)
    expect(questionTextIsComplete('你在上一家公司主要负责')).toBe(false)
  })
})
