import { effectiveDisks } from '@asi/sense-types'
import type { ComponentProps } from 'react'
import { useClock } from '../clock'
import type { DisksFact } from '../view-model'
import { TileDetail } from './tile'

export function DisksDetail({ disks, now, ...props }: Omit<ComponentProps<typeof TileDetail>, 'fact'> & {
  disks: DisksFact
}) {
  const effNow = useClock(now)
  return <TileDetail {...props} fact={effectiveDisks(disks, effNow)} now={effNow} />
}
