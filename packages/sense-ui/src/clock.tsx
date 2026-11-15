import { createContext, useContext } from 'react'

/**
 * Body 区共享时钟：随 model.now 更新，让事实年龄/走势图窗口这类
 * 纯时间显示自行前进，不必重渲外层 memo 化的指标卡片。
 * Body 之外（单测、其他面板）回退到组件 props 传入的 now。
 */
const ClockCtx = createContext<number | null>(null)

export const ClockProvider = ClockCtx.Provider

export function useClock(fallback: number): number {
  return useContext(ClockCtx) ?? fallback
}
