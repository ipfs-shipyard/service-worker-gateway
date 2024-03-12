import { dnsJsonOverHttps } from '@helia/ipns/dns-resolvers'
import { createVerifiedFetch, type VerifiedFetch } from '@helia/verified-fetch'
import { HeliaServiceWorkerCommsChannel, type ChannelMessage } from './lib/channel.ts'
import { getConfig } from './lib/config-db.ts'
import { contentTypeParser } from './lib/content-type-parser.ts'
import { getRedirectUrl, isDeregisterRequest } from './lib/deregister-request.ts'
import { GenericIDB } from './lib/generic-db'
import { getSubdomainParts } from './lib/get-subdomain-parts.ts'
import { isConfigPage } from './lib/is-config-page.ts'
import { error, log, trace } from './lib/logger.ts'
import { findOriginIsolationRedirect } from './lib/path-or-subdomain.ts'

/**
 ******************************************************
 * Types
 ******************************************************
 */

/**
 * Not available in ServiceWorkerGlobalScope
 */
interface AggregateError extends Error {
  errors: Error[]
}

interface FetchHandlerArg {
  path: string
  request: Request

}
interface GetVerifiedFetchUrlOptions {
  protocol?: string | null
  id?: string | null
  path: string
}

/**
 * IndexedDB schema for each registered service worker
 *
 * NOTE: this is not intended to be shared between service workers, unlike the
 * default used by config-db.ts
 */
interface LocalSwConfig {
  installTimestamp: number
}

/**
 ******************************************************
 * "globals"
 ******************************************************
 */
declare let self: ServiceWorkerGlobalScope
let verifiedFetch: VerifiedFetch
const channel = new HeliaServiceWorkerCommsChannel('SW')
const urlInterceptRegex = [new RegExp(`${self.location.origin}/ip(n|f)s/`)]
const updateVerifiedFetch = async (): Promise<void> => {
  verifiedFetch = await getVerifiedFetch()
}
let swIdb: GenericIDB<LocalSwConfig>
let firstInstallTime: number
const getSwConfig = (): GenericIDB<LocalSwConfig> => {
  return swIdb ?? new GenericIDB<LocalSwConfig>('helia-sw-unique', 'config')
}

/**
 ******************************************************
 * Service Worker Lifecycle Events
 ******************************************************
 */
self.addEventListener('install', (event) => {
  // 👇 When a new version of the SW is installed, activate immediately
  void self.skipWaiting()
  event.waitUntil(addInstallTimestampToConfig())
})

self.addEventListener('activate', (event) => {
  // ensure verifiedFetch is ready for use
  event.waitUntil(updateVerifiedFetch())
  /**
   * 👇 Claim all clients immediately. This handles the case when subdomain is
   * loaded for the first time, and config is updated and then a pre-fetch is
   * sent (await fetch(window.location.href, { method: 'GET' })) to start
   * loading the content prior the user reloading or clicking the "load content"
   * button.
   */
  event.waitUntil(self.clients.claim())
  channel.onmessagefrom('WINDOW', async (message: MessageEvent<ChannelMessage<'WINDOW', null>>) => {
    const { action } = message.data
    switch (action) {
      case 'RELOAD_CONFIG':
        void updateVerifiedFetch().then(() => {
          channel.postMessage({ action: 'RELOAD_CONFIG_SUCCESS' })
          trace('sw: RELOAD_CONFIG_SUCCESS for %s', self.location.origin)
        })
        break
      default:
        log('unknown action: ', action)
    }
  })
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const urlString = request.url
  const url = new URL(urlString)

  event.waitUntil(requestRouting(event, url).then(async (shouldHandle) => {
    if (shouldHandle) {
      event.respondWith(fetchHandler({ path: url.pathname, request }))
    }
  }))
})

/**
 ******************************************************
 * Functions
 ******************************************************
 */
async function requestRouting (event: FetchEvent, url: URL): Promise<boolean> {
  if (await isTimebombExpired()) {
    trace('helia-sw: timebomb expired, deregistering service worker')
    event.waitUntil(deregister(event, false))
    return false
  } else if (isDeregisterRequest(event.request.url)) {
    event.waitUntil(deregister(event))
    return false
  } else if (isConfigPageRequest(url) || isSwAssetRequest(event)) {
    // get the assets from the server
    trace('helia-sw: config page or js asset request, ignoring ', event.request.url)
    return false
  } else if (!isValidRequestForSW(event)) {
    trace('helia-sw: not a valid request for helia-sw, ignoring ', event.request.url)
    return false
  }

  if (isRootRequestForContent(event) || isSubdomainRequest(event)) {
    return true
  }
  return false
}

async function getVerifiedFetch (): Promise<VerifiedFetch> {
  const config = await getConfig()
  log(`config-debug: got config for sw location ${self.location.origin}`, config)

  const verifiedFetch = await createVerifiedFetch({
    gateways: config.gateways ?? ['https://trustless-gateway.link'],
    routers: config.routers ?? ['https://delegated-ipfs.dev'],
    dnsResolvers: ['https://delegated-ipfs.dev/dns-query'].map(dnsJsonOverHttps)
  }, {
    contentTypeParser
  })

  return verifiedFetch
}

// potential race condition
async function deregister (event, redirectToConfig = true): Promise<void> {
  if (!isSubdomainRequest(event)) {
    // if we are at the root, we need to ignore this request due to race conditions with the UI
    return
  }
  await self.registration.unregister()
  const clients = await self.clients.matchAll({ type: 'window' })

  for (const client of clients) {
    const newUrl = redirectToConfig ? getRedirectUrl(client.url) : client.url
    try {
      await client.navigate(newUrl)
    } catch (e) {
      error('error navigating client to ', newUrl, e)
    }
  }
}

function isRootRequestForContent (event: FetchEvent): boolean {
  const urlIsPreviouslyIntercepted = urlInterceptRegex.some(regex => regex.test(event.request.url))
  const isRootRequest = urlIsPreviouslyIntercepted
  return isRootRequest // && getCidFromUrl(event.request.url) != null
}

function isSubdomainRequest (event: FetchEvent): boolean {
  const { id, protocol } = getSubdomainParts(event.request.url)
  trace('isSubdomainRequest.id: ', id)
  trace('isSubdomainRequest.protocol: ', protocol)

  return id != null && protocol != null
}

function isConfigPageRequest (url: URL): boolean {
  return isConfigPage(url.hash)
}

function isValidRequestForSW (event: FetchEvent): boolean {
  return isSubdomainRequest(event) || isRootRequestForContent(event)
}

function isAggregateError (err: unknown): err is AggregateError {
  return err instanceof Error && (err as AggregateError).errors != null
}

function getVerifiedFetchUrl ({ protocol, id, path }: GetVerifiedFetchUrlOptions): string {
  if (id != null && protocol != null) {
    return `${protocol}://${id}${path}`
  }

  const pathParts = path.split('/')

  let pathPartIndex = 0
  let namespaceString = pathParts[pathPartIndex++]
  if (namespaceString === '') {
  // we have a prefixed '/' in the path, use the new index instead
    namespaceString = pathParts[pathPartIndex++]
  }
  if (namespaceString !== 'ipfs' && namespaceString !== 'ipns') {
    throw new Error(`only /ipfs or /ipns namespaces supported got ${namespaceString}`)
  }
  const pathRootString = pathParts[pathPartIndex++]
  const contentPath = pathParts.slice(pathPartIndex++).join('/')
  return `${namespaceString}://${pathRootString}/${contentPath}`
}

function isSwAssetRequest (event: FetchEvent): boolean {
  const isActualSwAsset = /^.+\/(?:ipfs-sw-).+\.js$/.test(event.request.url)
  return isActualSwAsset
}

async function fetchHandler ({ path, request }: FetchHandlerArg): Promise<Response> {
  /**
   * > Any global variables you set will be lost if the service worker shuts down.
   *
   * @see https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
   */
  verifiedFetch = verifiedFetch ?? await getVerifiedFetch()
  // test and enforce origin isolation before anything else is executed
  const originLocation = await findOriginIsolationRedirect(new URL(request.url))
  if (originLocation !== null) {
    const body = 'Gateway supports subdomain mode, redirecting to ensure Origin isolation..'
    return new Response(body, {
      status: 301,
      headers: {
        'Content-Type': 'text/plain',
        Location: originLocation
      }
    })
  }

  /**
   * Note that there are existing bugs regarding service worker signal handling:
   * * https://bugs.chromium.org/p/chromium/issues/detail?id=823697
   * * https://bugzilla.mozilla.org/show_bug.cgi?id=1394102
   */
  // 5 minute timeout
  const signal = AbortSignal.timeout(5 * 60 * 1000)
  try {
    const { id, protocol } = getSubdomainParts(request.url)
    const verifiedFetchUrl = getVerifiedFetchUrl({ id, protocol, path })
    log('verifiedFetch for ', verifiedFetchUrl)

    const headers = request.headers
    return await verifiedFetch(verifiedFetchUrl, {
      signal,
      headers,
      // TODO redirect: 'manual', // enable when http urls are supported by verified-fetch: https://github.com/ipfs-shipyard/helia-service-worker-gateway/issues/62#issuecomment-1977661456
      onProgress: (e) => {
        trace(`${e.type}: `, e.detail)
      }
    })
  } catch (err: unknown) {
    const errorMessages: string[] = []
    if (isAggregateError(err)) {
      error('fetchHandler aggregate error: ', err.message)
      for (const e of err.errors) {
        errorMessages.push(e.message)
        error('fetchHandler errors: ', e)
      }
    } else {
      errorMessages.push(err instanceof Error ? err.message : JSON.stringify(err))
      error('fetchHandler error: ', err)
    }
    const errorMessage = errorMessages.join('\n')

    if (errorMessage.includes('aborted')) {
      return new Response('heliaFetch error aborted due to timeout: ' + errorMessage, { status: 408 })
    }
    return new Response('heliaFetch error: ' + errorMessage, { status: 500 })
  }
}

async function isTimebombExpired (): Promise<boolean> {
  firstInstallTime = firstInstallTime ?? await getInstallTimestamp()
  const now = Date.now()
  // max life (for now) is 24 hours
  const timebomb = 24 * 60 * 60 * 1000
  return now - firstInstallTime > timebomb
}

async function getInstallTimestamp (): Promise<number> {
  try {
    const swidb = getSwConfig()
    await swidb.open()
    firstInstallTime = await swidb.get('installTimestamp')
    swidb.close()
    return firstInstallTime
  } catch (e) {
    error('getInstallTimestamp error: ', e)
    return 0
  }
}

async function addInstallTimestampToConfig (): Promise<void> {
  try {
    const timestamp = Date.now()
    firstInstallTime = timestamp
    const swidb = getSwConfig()
    await swidb.open()
    await swidb.put('installTimestamp', timestamp)
    swidb.close()
  } catch (e) {
    error('addInstallTimestampToConfig error: ', e)
  }
}
