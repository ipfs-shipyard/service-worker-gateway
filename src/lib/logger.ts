import { logger } from '@libp2p/logger'

const logObj = logger('service-worker-gateway:ui')

export const log = logObj
export const error = logObj.error
export const trace = logObj.trace
