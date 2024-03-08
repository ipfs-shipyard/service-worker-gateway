import React, { useContext, useEffect, useMemo, useState } from 'react'
import { ServiceWorkerReadyButton } from './components/sw-ready-button.tsx'
import { ServiceWorkerContext } from './context/service-worker-context.tsx'
import { HeliaServiceWorkerCommsChannel } from './lib/channel.ts'
import { setConfig, type ConfigDb } from './lib/config-db.ts'
import { getSubdomainParts } from './lib/get-subdomain-parts'
import { error } from './lib/logger.ts'

const ConfigIframe = (): JSX.Element => {
  const { parentDomain } = getSubdomainParts(window.location.href)

  const portString = window.location.port === '' ? '' : `:${window.location.port}`
  const iframeSrc = `${window.location.protocol}//${parentDomain}${portString}#/config@origin=${encodeURIComponent(window.location.origin)}`

  return (
    <iframe id="redirect-config-iframe" src={iframeSrc} style={{ width: '100vw', height: '100vh', border: 'none' }} />
  )
}

const channel = new HeliaServiceWorkerCommsChannel('WINDOW')

export default function RedirectPage (): JSX.Element {
  const [isAutoReloadEnabled, setIsAutoReloadEnabled] = useState(false)
  const { isServiceWorkerRegistered } = useContext(ServiceWorkerContext)

  useEffect(() => {
    async function doWork (config: ConfigDb): Promise<void> {
      try {
        await setConfig(config)
        await channel.messageAndWaitForResponse('SW', { target: 'SW', action: 'RELOAD_CONFIG' })
        // try to preload the content
        await fetch(window.location.href, { method: 'GET' })
      } catch (err) {
        error('config-debug: error setting config on subdomain', err)
      }

      if (config.autoReload) {
        setIsAutoReloadEnabled(config.autoReload)
      }
    }
    const listener = (event: MessageEvent): void => {
      if (event.data?.source === 'helia-sw-config-iframe') {
        const config = event.data?.config
        if (config != null) {
          void doWork(config as ConfigDb)
        }
      }
    }
    window.addEventListener('message', listener)
    return () => {
      window.removeEventListener('message', listener)
    }
  }, [])

  const displayString = useMemo(() => {
    if (!isServiceWorkerRegistered) {
      return 'Registering Helia service worker...'
    }
    if (isAutoReloadEnabled) {
      return 'Redirecting you because Auto Reload is enabled.'
    }

    return 'Please save your changes to the config to apply them. You can then refresh the page to load your content.'
  }, [isAutoReloadEnabled, isServiceWorkerRegistered])

  useEffect(() => {
    if (isAutoReloadEnabled && isServiceWorkerRegistered) {
      window.location.reload()
    }
  }, [isAutoReloadEnabled, isServiceWorkerRegistered])

  return (
    <div className="redirect-page">
      <div className="pa4-l mw7 mv5 center pa4">
        <h3 className="">{displayString}</h3>
        <ServiceWorkerReadyButton id="load-content" label='Load content' waitingLabel='Waiting for service worker registration...' onClick={() => { window.location.reload() }} />
      </div>
      <ConfigIframe />
    </div>
  )
}
