import assert from 'assert'
import axios from 'axios'
import chalk from 'chalk'
import EventEmitter from 'events'
import fs from 'fs'
import JSON5 from 'json5'
import { LoremIpsum } from 'lorem-ipsum'
import NodeCache from 'node-cache'
import os from 'os'
import path from 'path'
import * as vanillaPuppeteer from 'puppeteer'
import puppeteer, {
  Browser,
  BrowserContext,
  CDPSession,
  ElementHandle,
  JSHandle,
  Metrics,
  Page,
} from 'puppeteer-core'
import { addExtra } from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import type { Interception } from 'puppeteer-intercept-and-modify-requests'
import { RequestInterceptionManager } from 'puppeteer-intercept-and-modify-requests'
import { gunzipSync } from 'zlib'

const puppeteerExtra = addExtra(vanillaPuppeteer)
puppeteerExtra.use(StealthPlugin())

// For nexe bundler.
require('puppeteer-extra-plugin-stealth/evasions/chrome.app')
require('puppeteer-extra-plugin-stealth/evasions/chrome.csi')
require('puppeteer-extra-plugin-stealth/evasions/chrome.loadTimes')
require('puppeteer-extra-plugin-stealth/evasions/chrome.runtime')
require('puppeteer-extra-plugin-stealth/evasions/defaultArgs')
require('puppeteer-extra-plugin-stealth/evasions/iframe.contentWindow')
require('puppeteer-extra-plugin-stealth/evasions/media.codecs')
require('puppeteer-extra-plugin-stealth/evasions/navigator.hardwareConcurrency')
require('puppeteer-extra-plugin-stealth/evasions/navigator.languages')
require('puppeteer-extra-plugin-stealth/evasions/navigator.permissions')
require('puppeteer-extra-plugin-stealth/evasions/navigator.plugins')
require('puppeteer-extra-plugin-stealth/evasions/navigator.vendor')
require('puppeteer-extra-plugin-stealth/evasions/navigator.webdriver')
require('puppeteer-extra-plugin-stealth/evasions/sourceurl')
require('puppeteer-extra-plugin-stealth/evasions/user-agent-override')
require('puppeteer-extra-plugin-stealth/evasions/webgl.vendor')
require('puppeteer-extra-plugin-stealth/evasions/window.outerdimensions')
require('puppeteer-extra-plugin-user-data-dir')
require('puppeteer-extra-plugin-user-preferences')
//

import { rtcStatKey, RtcStats, updateRtcStats } from './rtcstats'
import {
  checkChromiumExecutable,
  downloadUrl,
  getProcessStats,
  getSystemStats,
  hideAuth,
  logger,
  md5,
  PeerConnectionExternal,
  PeerConnectionExternalMethod,
  resolveIP,
  resolvePackagePath,
  sleep,
} from './utils'

const log = logger('app:session')

const describeJsHandle = async (jsHandle: JSHandle): Promise<string> => {
  try {
    let value = await jsHandle.jsonValue()

    // Value is unserializable (or an empty oject).
    if (JSON.stringify(value) === JSON.stringify({})) {
      const {
        type,
        subtype,
        description,
        value: objValue,
      } = jsHandle.remoteObject()
      value = `type: ${type} subtype: ${subtype} description: ${description} value: ${JSON.stringify(
        objValue,
      )}`
    }

    if (typeof value === 'string') {
      if (value.match(/^color: /)) {
        return ''
      }
      return value.replace(/%c/g, '')
    } else {
      return JSON.stringify(value)
    }
  } catch (err) {
    log.debug(`describeJsHandle ${jsHandle} error: ${(err as Error).message}`)
  }
  return ''
}

const metricsTotalDuration = (metrics: Metrics): number => {
  return (
    (metrics.LayoutDuration || 0) +
    (metrics.RecalcStyleCount || 0) +
    (metrics.ScriptDuration || 0) +
    (metrics.TaskDuration || 0)
  )
}

declare global {
  let collectPeerConnectionStats: () => Promise<{
    stats: RtcStats[]
    activePeerConnections: number
    signalingHost?: string
  }>
  let collectVideoEndToEndDelayStats: () => {
    videoEndToEndDelay: number
    videoEndToEndNetworkDelay: number
  }
  let collectHttpResourcesStats: () => {
    recvBytes: number
    recvBitrate: number
    recvLatency: number
  }
  let collectCustomMetrics: () => Promise<Record<string, number | string>>
  let getParticipantName: () => string
}

const PageLogColors = {
  error: 'red',
  warning: 'yellow',
  info: 'cyan',
  debug: 'grey',
  requestfailed: 'magenta',
}

type PageLogColorsKey = 'error' | 'warning' | 'info' | 'debug' | 'requestfailed'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SessionStats = Record<string, number | any>

export type SessionParams = {
  /** The chromium running instance url. */
  chromiumUrl: string
  /** The chromium executable path. */
  chromiumPath: string
  /** Chromium additional field trials. */
  chromiumFieldTrials: string
  /** The browser width. */
  windowWidth: number
  /** The browser height. */
  windowHeight: number
  /** The browser device scale factor. */
  deviceScaleFactor: number
  /**
   * If unset, the browser will run in headless mode.
   * When running on Linux, set to a valid X display variable (e.g. `:0`).
   */
  display: string
  /** Enables RED for OPUS codec (experimental).  */
  /* audioRedForOpus: boolean */
  /** The page URL. */
  url: string
  /** The page URL query. */
  urlQuery: string
  /** Custom URL handler. */
  customUrlHandler: string
  videoPath: string
  videoCachePath: string
  videoWidth: number
  videoHeight: number
  videoFramerate: number
  videoFormat: string
  enableGpu: string
  enableBrowserLogging: boolean
  startTimestamp: number
  sessions: number
  tabsPerSession: number
  spawnPeriod: number
  statsInterval: number
  getUserMediaOverride: string
  getDisplayMediaOverride: string
  getDisplayMediaType: string
  getDisplayMediaCrop: string
  localStorage: string
  clearCookies: boolean
  scriptPath: string
  showPageLog: boolean
  pageLogFilter: string
  pageLogPath: string
  userAgent: string
  id: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluateAfter?: any[]
  exposedFunctions?: string
  scriptParams: string
  blockedUrls: string
  extraHeaders: string
  responseModifiers: string
  extraCSS: string
  cookies: string
  debuggingPort: number
  debuggingAddress: string
  randomAudioPeriod: number
  maxVideoDecoders: number
  maxVideoDecodersAt: number
  incognito: boolean
  serverPort: number
  serverSecret: string
  serverUseHttps: boolean
}

/**
 * Implements a test session instance running on a browser instance.
 */
export class Session extends EventEmitter {
  private readonly chromiumUrl: string
  private readonly chromiumPath?: string
  private readonly chromiumFieldTrials?: string
  private readonly windowWidth: number
  private readonly windowHeight: number
  private readonly deviceScaleFactor: number
  private readonly display: string
  /* private readonly audioRedForOpus: boolean */
  private readonly videoPath: string
  private readonly videoCachePath: string
  private readonly videoWidth: number
  private readonly videoHeight: number
  private readonly videoFramerate: number
  private readonly videoFormat: string
  private readonly enableGpu: string
  private readonly enableBrowserLogging: boolean
  private readonly startTimestamp: number
  private readonly sessions: number
  private readonly tabsPerSession: number
  private readonly spawnPeriod: number
  private readonly statsInterval: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly getUserMediaOverride: any | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly getDisplayMediaOverride: any | null
  private readonly getDisplayMediaType: string
  private readonly getDisplayMediaCrop: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly localStorage?: any
  private readonly clearCookies: boolean
  private readonly scriptPath: string
  private readonly showPageLog: boolean
  private readonly pageLogFilter: string
  private readonly pageLogPath: string
  private readonly userAgent: string
  private readonly evaluateAfter: {
    // eslint-disable-next-line @typescript-eslint/ban-types
    pageFunction: Function
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any
  }[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly exposedFunctions: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly scriptParams: any
  private readonly blockedUrls: string[]
  private readonly extraHeaders?: Record<string, Record<string, string>>
  private readonly responseModifiers: Record<
    string,
    { search: RegExp; replace: string }[]
  > = {}
  private readonly extraCSS: string
  private readonly cookies?: Record<string, string>
  private readonly debuggingPort: number
  private readonly debuggingAddress: string
  private readonly randomAudioPeriod: number
  private readonly maxVideoDecoders: number
  private readonly maxVideoDecodersAt: number
  private readonly incognito: boolean
  private readonly serverPort: number
  private readonly serverSecret: string
  private readonly serverUseHttps: boolean

  private running = false
  private browser?: Browser
  private context?: BrowserContext

  /** The numeric id assigned to the session. */
  readonly id: number
  /** The test page url. */
  readonly url: string
  /** The url query. */
  readonly urlQuery: string
  /**
   * The custom URL handler. This is the path to a JavaScript module (.mjs) exporting the function.
   * The function itself takes an object as input with the following parameters:
   *
   * @typedef {Object} CustomUrlHandler
   * @property {string} id - The identifier for the URL.
   * @property {string} sessions - The number of sessions.
   * @property {string} tabIndex - The index of the current tab.
   * @property {string} tabsPerSession - The number of tabs per session.
   * @property {string} index - The index for the URL.
   * @property {string} pid - The process identifier for the URL.
   *
   * @type {string} path - The path to the JavaScript file containing the function:
   *   (params: CustomUrlHandler) => Promise<string>
   */
  readonly customUrlHandler: string
  /**
   * Imported custom URL handler function.
   * @typedef {Object} CustomUrlHandler
   * @property {string} id - The identifier for the URL.
   * @property {string} sessions - The number of sessions.
   * @property {string} tabIndex - The index of the current tab.
   * @property {string} tabsPerSession - The number of tabs per session.
   * @property {string} index - The index for the URL.
   * @property {string} pid - The process identifier for the URL.
   *
   * @type {string} path - The path to the JavaScript file containing the function:
   *   (params: CustomUrlHandler) => Promise<string>
   */
  private customUrlHandlerFn?: (params: {
    id: string
    sessions: string
    tabIndex: string
    tabsPerSession: string
    index: string
    pid: string
  }) => Promise<string>
  /** The latest stats extracted from page. */
  stats: SessionStats = {}
  /** The browser opened pages. */
  readonly pages = new Map<number, Page>()
  /** The browser opened pages metrics. */
  readonly pagesMetrics = new Map<number, Metrics>()
  /** The page warnings count. */
  pageWarnings = 0
  /** The page errors count. */
  pageErrors = 0

  private static readonly jsonFetchCache = new NodeCache({
    stdTTL: 30,
    checkperiod: 15,
  })

  constructor({
    chromiumUrl,
    chromiumPath,
    chromiumFieldTrials,
    windowWidth,
    windowHeight,
    deviceScaleFactor,
    display,
    /* audioRedForOpus, */
    url,
    urlQuery,
    customUrlHandler,
    videoPath,
    videoCachePath,
    videoWidth,
    videoHeight,
    videoFramerate,
    videoFormat,
    enableGpu,
    enableBrowserLogging,
    startTimestamp,
    sessions,
    tabsPerSession,
    spawnPeriod,
    statsInterval,
    getUserMediaOverride,
    getDisplayMediaOverride,
    getDisplayMediaType,
    getDisplayMediaCrop,
    localStorage,
    clearCookies,
    scriptPath,
    showPageLog,
    pageLogFilter,
    pageLogPath,
    userAgent,
    id,
    evaluateAfter,
    exposedFunctions,
    scriptParams,
    blockedUrls,
    extraHeaders,
    responseModifiers,
    extraCSS,
    cookies,
    debuggingPort,
    debuggingAddress,
    randomAudioPeriod,
    maxVideoDecoders,
    maxVideoDecodersAt,
    incognito,
    serverPort,
    serverSecret,
    serverUseHttps,
  }: SessionParams) {
    super()
    log.debug('constructor', { id })
    this.chromiumUrl = chromiumUrl
    this.chromiumPath = chromiumPath || undefined
    this.chromiumFieldTrials = chromiumFieldTrials || undefined
    this.windowWidth = windowWidth || 1920
    this.windowHeight = windowHeight || 1080
    this.deviceScaleFactor = deviceScaleFactor || 1
    this.debuggingPort = debuggingPort || 0
    this.debuggingAddress = debuggingAddress || '127.0.0.1'
    this.display = display
    /* this.audioRedForOpus = !!audioRedForOpus */
    this.url = url
    if (!customUrlHandler) {
      assert(this.url, 'url is required')
    }
    this.urlQuery = urlQuery
    if (!this.urlQuery && url.indexOf('?') !== -1) {
      const parts = url.split('?', 2)
      this.url = parts[0]
      this.urlQuery = parts[1]
    }
    this.customUrlHandler = customUrlHandler
    this.customUrlHandlerFn = undefined
    this.videoPath = videoPath
    this.videoCachePath = videoCachePath
    this.videoWidth = videoWidth
    this.videoHeight = videoHeight
    this.videoFramerate = videoFramerate
    this.videoFormat = videoFormat || 'y4m'
    this.enableGpu = enableGpu
    this.enableBrowserLogging = enableBrowserLogging
    this.startTimestamp = startTimestamp || Date.now()
    this.sessions = sessions || 1
    this.tabsPerSession = tabsPerSession || 1
    assert(this.tabsPerSession >= 1, 'tabsPerSession should be >= 1')
    this.spawnPeriod = spawnPeriod || 1000
    this.statsInterval = statsInterval || 10
    if (getUserMediaOverride) {
      try {
        this.getUserMediaOverride = JSON5.parse(getUserMediaOverride)
      } catch (err: unknown) {
        log.error(`error parsing getUserMediaOverride: ${(err as Error).stack}`)
        this.getUserMediaOverride = null
      }
    }
    if (getDisplayMediaOverride) {
      try {
        this.getDisplayMediaOverride = JSON5.parse(getDisplayMediaOverride)
      } catch (err: unknown) {
        log.error(
          `error parsing getDisplayMediaOverride: ${(err as Error).stack}`,
        )
        this.getDisplayMediaOverride = null
      }
    }
    this.getDisplayMediaType = getDisplayMediaType
    this.getDisplayMediaCrop = getDisplayMediaCrop
    if (localStorage) {
      try {
        this.localStorage = JSON5.parse(localStorage)
      } catch (err: unknown) {
        log.error(`error parsing localStorage: ${(err as Error).stack}`)
        this.localStorage = null
      }
    }
    this.clearCookies = clearCookies
    this.scriptPath = scriptPath
    this.showPageLog = showPageLog
    this.pageLogFilter = pageLogFilter
    this.pageLogPath = pageLogPath
    this.userAgent = userAgent
    this.randomAudioPeriod = randomAudioPeriod
    this.maxVideoDecoders = maxVideoDecoders
    this.maxVideoDecodersAt = maxVideoDecodersAt
    this.incognito = incognito
    this.serverPort = serverPort
    this.serverSecret = serverSecret
    this.serverUseHttps = serverUseHttps

    this.id = id
    this.evaluateAfter = evaluateAfter || []
    this.exposedFunctions = exposedFunctions || {}
    if (scriptParams) {
      try {
        this.scriptParams = JSON5.parse(scriptParams)
      } catch (err) {
        log.error(
          `error parsing scriptParams '${scriptParams}': ${
            (err as Error).stack
          }`,
        )
        throw err
      }
    } else {
      this.scriptParams = {}
    }
    this.blockedUrls = (blockedUrls || '')
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length)
    // Always block sentry.io.
    this.blockedUrls.push('ingest.sentry.io')

    if (extraHeaders) {
      try {
        this.extraHeaders = JSON5.parse(extraHeaders)
      } catch (err) {
        log.error(`error parsing extraHeaders: ${(err as Error).stack}`)
        this.extraHeaders = undefined
      }
    } else {
      this.extraHeaders = undefined
    }

    if (responseModifiers) {
      try {
        const parsed = JSON5.parse(responseModifiers) as Record<
          string,
          { search: string; replace: string }[]
        >
        Object.entries(parsed).forEach(([url, replacements]) => {
          this.responseModifiers[url] = replacements.map(
            ({ search, replace }) => ({
              search: new RegExp(search, 'g'),
              replace,
            }),
          )
        })
      } catch (err) {
        log.error(`error parsing responseModifiers: ${(err as Error).stack}`)
      }
    }

    this.extraCSS = extraCSS

    if (cookies) {
      try {
        this.cookies = JSON5.parse(cookies)
      } catch (err) {
        log.error(`error parsing cookies: ${(err as Error).stack}`)
        this.cookies = undefined
      }
    } else {
      this.cookies = undefined
    }
  }

  /**
   * Returns the chromium browser launch args
   * @return the args list
   */
  getBrowserArgs(): string[] {
    // https://peter.sh/experiments/chromium-command-line-switches/
    // https://source.chromium.org/chromium/chromium/src/+/main:testing/variations/fieldtrial_testing_config.json;l=8877?q=%20fieldtrial_testing_config.json&ss=chromium
    let args = [
      '--no-sandbox',
      '--no-zygote',
      '--ignore-certificate-errors',
      '--no-user-gesture-required',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-infobars',
      '--allow-running-insecure-content',
      `--unsafely-treat-insecure-origin-as-secure=http://${
        new URL(this.url || 'http://localhost').host
      }`,
      '--use-fake-ui-for-media-stream',
      '--enable-usermedia-screen-capturing',
      '--allow-http-screen-capture',
      '--auto-accept-this-tab-capture',
      `--use-fake-device-for-media-stream=display-media-type=${
        this.getDisplayMediaType || 'monitor'
      },fps=30`,
      // '--auto-select-desktop-capture-source=Entire screen',
      // `--auto-select-tab-capture-source-by-title=about:blank`,
      `--remote-debugging-port=${
        this.debuggingPort ? this.debuggingPort + this.id : 0
      }`,
      `--remote-debugging-address=${this.debuggingAddress}`,
    ]

    // 'WebRTC-VP8ConferenceTemporalLayers/2',
    // 'AutomaticTabDiscarding/Disabled',
    // 'WebRTC-Vp9DependencyDescriptor/Enabled',
    // 'WebRTC-DependencyDescriptorAdvertised/Enabled',
    const fieldTrials = (this.chromiumFieldTrials || '')
      .split(',')
      .filter(s => !!s)
    /* if (this.audioRedForOpus) {
      fieldTrials.push('WebRTC-Audio-Red-For-Opus/Enabled')
    } */
    if (this.maxVideoDecoders !== -1 && this.id >= this.maxVideoDecodersAt) {
      fieldTrials.push(`WebRTC-MaxVideoDecoders/${this.maxVideoDecoders}`)
    }
    if (fieldTrials.length) {
      args.push(`--force-fieldtrials=${fieldTrials.join('/')}`)
    }

    if (this.videoPath) {
      const videoPaths = this.videoPath.split(',')
      const videoPath = videoPaths[this.id % videoPaths.length]
      log.debug(`${this.id} using ${videoPath} as fake source`)
      const name = md5(videoPath)
      args.push(
        `--use-file-for-fake-video-capture=${this.videoCachePath}/${name}_${this.videoWidth}x${this.videoHeight}_${this.videoFramerate}fps.${this.videoFormat}`,
      )
      args.push(
        `--use-file-for-fake-audio-capture=${this.videoCachePath}/${name}.wav`,
      )
    }

    if (this.enableGpu) {
      args = args.concat([
        '--ignore-gpu-blocklist',
        '--enable-features=VaapiVideoDecoder',
        '--enable-gpu-rasterization',
        '--enable-zero-copy',
        '--disable-gpu-sandbox',
        '--enable-vulkan',
      ])
      if (this.enableGpu === 'egl') {
        args.push('--use-gl=egl')
      }
    } else {
      args = args.concat([
        // Disables webgl support.
        '--disable-3d-apis',
        '--disable-site-isolation-trials',
        // '--renderer-process-limit=2',
        // '--single-process',
      ])
    }

    if (this.enableBrowserLogging) {
      args = args.concat(['--enable-logging=stderr', '--vmodule=*/webrtc/*=1'])
    }

    return args
  }

  /**
   * Start
   */
  async start(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    if (this.browser) {
      log.warn(`${this.id} start: already running`)
      return
    }
    log.debug(`${this.id} start`)

    if (this.chromiumUrl) {
      // connect to a remote chrome instance
      try {
        this.browser = await puppeteer.connect({
          browserURL: this.chromiumUrl,
          ignoreHTTPSErrors: true,
          defaultViewport: {
            width: this.windowWidth,
            height: this.windowHeight,
            deviceScaleFactor: this.deviceScaleFactor,
            isMobile: false,
            hasTouch: false,
            isLandscape: false,
          },
        })
      } catch (err) {
        log.error(`${this.id} browser connect error: ${(err as Error).stack}`)
        return this.stop()
      }
    } else {
      // run a browser instance locally
      let executablePath = this.chromiumPath
      if (!executablePath || !fs.existsSync(executablePath)) {
        executablePath = await checkChromiumExecutable()
        log.debug(`using executablePath=${executablePath}`)
      }

      const env = { ...process.env }
      if (!this.display) {
        delete env.DISPLAY
      } else {
        env.DISPLAY = this.display
      }

      const args = this.getBrowserArgs()

      log.debug(`Using args:\n  ${args.join('\n  ')}`)
      log.debug(`Default args:\n  ${puppeteer.defaultArgs().join('\n  ')}`)

      try {
        // log.debug('defaultArgs:', puppeteer.defaultArgs());
        this.browser = (await (process.env.USE_PUPPETEER_EXTRA === 'true'
          ? puppeteerExtra
          : puppeteer
        ).launch({
          headless: this.display ? false : true,
          executablePath,
          handleSIGINT: false,
          env,
          dumpio: this.enableBrowserLogging,
          // devtools: true,
          ignoreHTTPSErrors: true,
          defaultViewport: {
            width: this.windowWidth,
            height: this.windowHeight,
            deviceScaleFactor: this.deviceScaleFactor,
            isMobile: false,
            hasTouch: false,
            isLandscape: false,
          },
          ignoreDefaultArgs: [
            '--disable-dev-shm-usage',
            '--remote-debugging-port',
            '--hide-scrollbars',
          ],
          args,
        })) as Browser
        // const version = await this.browser.version();
        // console.log(`[session ${this.id}] Using chrome version: ${version}`);
      } catch (err) {
        log.error(
          `[session ${this.id}] Browser launch error: ${(err as Error).stack}`,
        )
        return this.stop()
      }
    }

    assert(this.browser, 'BrowserNotCreated')
    this.browser.once('disconnected', () => {
      log.warn('browser disconnected')
      return this.stop()
    })

    // get GPU infos from chrome://gpu page
    /* if (this.enableGpu) {
      try {
        const page = await this.browser.newPage()
        await page.goto('chrome://gpu')
        const data = await page.evaluate(() =>
          [
            // eslint-disable-next-line no-undef
            ...document.querySelectorAll('ul.feature-status-list > li > span'),
          ].map(
            (e, i) =>
              `${i % 2 === 0 ? '\n- ' : ''}${(e as HTMLSpanElement).innerText}`,
          ),
        )
        await page.close()
        console.log(`GPU infos:${data.join('')}`)
      } catch (err) {
        log.warn(`${this.id} error getting gpu info: %j`, err)
      }
    } */

    // open pages
    for (let i = 0; i < this.tabsPerSession; i++) {
      this.openPage(i).catch(err =>
        log.error(`openPage error: ${(err as Error).stack}`),
      )
      if (i < this.tabsPerSession - 1) {
        await sleep(this.spawnPeriod)
      }
    }
  }

  /**
   * openPage
   * @param tabIndex
   */
  async openPage(tabIndex: number): Promise<void> {
    if (!this.browser) {
      return
    }
    const index = this.id + tabIndex

    let url = this.url

    if (this.customUrlHandler && !this.url) {
      const customUrlHandlerPath = path.resolve(
        process.cwd(),
        this.customUrlHandler,
      )
      if (!fs.existsSync(customUrlHandlerPath)) {
        log.error(`Custom error handler not found: "${customUrlHandlerPath}"`)
        throw new Error(
          `Custom error handler not found: "${customUrlHandlerPath}"`,
        )
      }
      this.customUrlHandlerFn = (
        await import(/* webpackIgnore: true */ customUrlHandlerPath)
      ).default
      if (this.customUrlHandlerFn) {
        url = await this.customUrlHandlerFn({
          id: this.id.toString(10),
          sessions: this.sessions.toString(10),
          tabIndex: tabIndex.toString(10),
          tabsPerSession: this.tabsPerSession.toString(10),
          index: index.toString(10),
          pid: process.pid.toString(),
        })
      }
    }

    if (this.urlQuery) {
      url += `?${this.urlQuery
        .replace(/\$s/g, String(this.id + 1))
        .replace(/\$S/g, String(this.sessions))
        .replace(/\$t/g, String(tabIndex + 1))
        .replace(/\$T/g, String(this.tabsPerSession))
        .replace(/\$i/g, String(index + 1))
        .replace(/\$p/g, String(process.pid))}`
    }

    log.info(
      `opening page ${index} (session: ${this.id + 1} tab: ${
        tabIndex + 1
      }): ${hideAuth(url)}`,
    )

    if (this.incognito) {
      this.context = await this.browser.createIncognitoBrowserContext()
    } else {
      this.context = this.browser.defaultBrowserContext()
    }

    const page = await this.getNewPage(tabIndex)

    await page.setBypassCSP(true)

    if (this.userAgent) {
      await page.setUserAgent(this.userAgent)
    }

    await Promise.all(
      Object.keys(this.exposedFunctions).map(
        async (name: string) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await page.exposeFunction(name, (...args: any[]) =>
            this.exposedFunctions[name](...args),
          ),
      ),
    )

    // Export config to page.
    let cmd = `\
window.WEBRTC_STRESS_TEST_START_TIMESTAMP = ${this.startTimestamp};
window.WEBRTC_STRESS_TEST_URL = "${hideAuth(url)}";
window.WEBRTC_STRESS_TEST_SESSION = ${this.id + 1};
window.WEBRTC_STRESS_TEST_TAB_INDEX = ${tabIndex + 1};
window.WEBRTC_STRESS_TEST_INDEX = ${index + 1};
window.STATS_INTERVAL = ${this.statsInterval};
window.VIDEO_WIDTH = ${this.videoWidth};
window.VIDEO_HEIGHT = "${this.videoHeight}";
window.VIDEO_FRAMERATE = ${this.videoFramerate};
window.LOCAL_STORAGE = '${
      this.localStorage ? JSON.stringify(this.localStorage) : ''
    }';
window.RANDOM_AUDIO_PERIOD = ${this.randomAudioPeriod};
try {
  window.PARAMS = JSON.parse('${JSON.stringify(this.scriptParams)}' || '{}');
} catch (err) {}
`

    if (this.serverPort) {
      cmd += `\
window.SERVER_PORT = ${this.serverPort};
window.SERVER_SECRET = "${this.serverSecret}";
window.SERVER_USE_HTTPS = ${this.serverUseHttps};
`
    }

    if (this.getUserMediaOverride) {
      log.debug('Using getUserMedia override:', this.getUserMediaOverride)
      cmd += `window.GET_USER_MEDIA_OVERRIDE = JSON.parse('${JSON.stringify(
        this.getUserMediaOverride,
      )}');\n`
    }

    if (this.getDisplayMediaOverride) {
      log.debug('Using getDisplayMedia override:', this.getDisplayMediaOverride)
      cmd += `window.GET_DISPLAY_MEDIA_OVERRIDE = JSON.parse('${JSON.stringify(
        this.getDisplayMediaOverride,
      )}');\n`
    }

    if (this.getDisplayMediaCrop) {
      log.debug('Using getDisplayMedia crop:', this.getDisplayMediaCrop)
      cmd += `window.GET_DISPLAY_MEDIA_CROP = "${this.getDisplayMediaCrop}";\n`
    }

    if (this.localStorage) {
      log.debug('Using localStorage:', this.localStorage)
      Object.entries(this.localStorage).map(([key, value]) => {
        cmd += `localStorage.setItem('${key}', JSON.parse('${JSON.stringify(
          value,
        )}'));\n`
      })
    }

    await page.evaluateOnNewDocument(cmd)

    // Clear cookies.
    if (this.clearCookies) {
      try {
        const client = await page.target().createCDPSession()
        await client.send('Network.clearBrowserCookies')
      } catch (err) {
        log.error(`clearCookies error: ${(err as Error).stack}`)
      }
    }

    // Load scripts.
    for (const name of [
      'scripts/common.js',
      'scripts/get-user-media.js',
      'scripts/peer-connection-stats.js',
      `scripts/peer-connection${
        process.env.EXTERNAL_PEER_CONNECTION === 'true' ? '-external' : ''
      }.js`,
      'scripts/end-to-end-stats.js',
      'scripts/playout-delay-hint.js',
      'scripts/page-stats.js',
    ]) {
      const filePath = resolvePackagePath(name)
      log.debug(`loading ${name} script from: ${filePath}`)
      await page.evaluateOnNewDocument(fs.readFileSync(filePath, 'utf8'))
    }

    // Execute external script(s).
    if (this.scriptPath) {
      if (this.scriptPath.startsWith('base64:gzip:')) {
        const data = Buffer.from(
          this.scriptPath.replace('base64:gzip:', ''),
          'base64',
        )
        const code = gunzipSync(data).toString()
        log.debug(`loading script from ${code.length} bytes`)
        await page.evaluateOnNewDocument(code)
      } else {
        for (const filePath of this.scriptPath.split(',')) {
          if (!filePath.trim()) {
            continue
          }
          if (!fs.existsSync(filePath)) {
            log.warn(`custom script not found: ${filePath}`)
            continue
          }
          log.debug(`loading custom script: ${filePath}`)
          await page.evaluateOnNewDocument(
            await fs.readFileSync(filePath, 'utf8'),
          )
        }
      }
    }

    page.on('dialog', async dialog => {
      log.info(`page ${index + 1} dialog ${dialog.type()}: ${dialog.message()}`)
      try {
        await dialog.accept()
      } catch (err) {
        log.debug(`dialog accept error: ${(err as Error).message}`)
      }
      try {
        await dialog.dismiss()
      } catch (err) {
        log.debug(`dialog dismiss error: ${(err as Error).message}`)
      }
    })

    page.on('close', () => {
      log.info(`page ${index + 1} closed`)
      this.pages.delete(index)
      this.pagesMetrics.delete(index)

      if (this.browser && this.running) {
        setTimeout(() => this.openPage(index), 1000)
      }
    })

    // Enable request interception.
    let setRequestInterceptionState = true

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pageCDPSession = (page as any)._client() as CDPSession
    await pageCDPSession.send('Network.setBypassServiceWorker', {
      bypass: true,
    })

    const interceptManager = new RequestInterceptionManager(pageCDPSession, {
      onError: error => {
        log.error('Request interception error:', error)
      },
    })

    const interceptions: Interception[] = []

    // Blocked URLs.
    this.blockedUrls.forEach(blockedUrl => {
      interceptions.push({
        urlPattern: blockedUrl,
        modifyRequest: () => ({ errorReason: 'BlockedByClient' }),
      })
    })

    // Add extra headers.
    if (this.extraHeaders) {
      Object.entries(this.extraHeaders).forEach(([url, obj]) => {
        const headers = Object.entries(obj).map(([name, value]) => ({
          name,
          value,
        }))
        interceptions.push({
          urlPattern: url,
          modifyRequest: ({ event }) => {
            log.debug(`adding extraHeaders in: ${event.request.url}`, headers)
            return { headers }
          },
        })
      })
    }

    // Response modifiers.
    Object.entries(this.responseModifiers).forEach(([url, replacements]) => {
      interceptions.push({
        urlPattern: url,
        modifyResponse: ({ event, body }) => {
          if (body) {
            log.debug(
              `using responseModifiers in: ${event.request.url}`,
              replacements,
            )
            replacements.forEach(({ search, replace }) => {
              body = body?.replace(search, replace)
            })
          }
          return { body }
        },
      })
    })

    await interceptManager.intercept(...interceptions)

    // Allow to change the setRequestInterception state from page.
    const setRequestInterceptionFunction = async (value: boolean) => {
      if (value === setRequestInterceptionState) {
        return
      }
      log.debug(`setRequestInterception to ${value}`)
      try {
        if (!value) {
          await interceptManager.disable()
        } else {
          await interceptManager.enable()
        }
        setRequestInterceptionState = value
      } catch (err) {
        log.error(`setRequestInterception error: ${(err as Error).stack}`)
      }
    }

    await page.exposeFunction(
      'setRequestInterception',
      setRequestInterceptionFunction,
    )

    await page.exposeFunction(
      'jsonFetch',
      async (
        options: axios.AxiosRequestConfig & {
          validStatuses: number[]
          downloadPath: string
        },
        cacheKey = '',
        cacheTimeout = 0,
      ) => {
        if (cacheKey) {
          const ret = Session.jsonFetchCache.get(cacheKey)
          if (ret) {
            return ret
          }
        }
        try {
          if (options.validStatuses) {
            options.validateStatus = status =>
              options.validStatuses.includes(status)
          }
          const { status, data, headers } = await axios(options)
          if (options.responseType === 'stream') {
            if (options.downloadPath && !fs.existsSync(options.downloadPath)) {
              log.debug(
                `jsonFetch saving file to: ${options.downloadPath}`,
                headers['content-disposition'],
              )
              await fs.promises.mkdir(path.dirname(options.downloadPath), {
                recursive: true,
              })
              const writer = fs.createWriteStream(options.downloadPath)
              await new Promise<void>((resolve, reject) => {
                writer.on('error', err => reject(err))
                writer.on('close', () => resolve())
                data.pipe(writer)
              })
            }
            if (cacheKey) {
              Session.jsonFetchCache.set(cacheKey, { status }, cacheTimeout)
            }
            return { status, headers }
          } else {
            if (cacheKey) {
              Session.jsonFetchCache.set(
                cacheKey,
                { status, data },
                cacheTimeout,
              )
            }
            return { status, headers, data }
          }
        } catch (err) {
          const error = (err as Error).message
          log.warn(`jsonFetch error: ${error}`)
          return { status: 500, error }
        }
      },
    )

    await page.exposeFunction(
      'readLocalFile',
      (filePath: string, encoding?: BufferEncoding) => {
        filePath = path.resolve(process.cwd(), filePath)
        return fs.promises.readFile(filePath, encoding)
      },
    )

    // PeerConnectionExternal
    await page.exposeFunction(
      'createPeerConnectionExternal',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (options: any) => {
        const pc = new PeerConnectionExternal(options)
        return { id: pc.id }
      },
    )

    await page.exposeFunction(
      'callPeerConnectionExternalMethod',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (id: number, name: PeerConnectionExternalMethod, arg: any) => {
        const pc = PeerConnectionExternal.get(id)
        if (pc) {
          return pc[name](arg)
        }
      },
    )

    /* pageCDPSession.on('Network.webSocketFrameSent', ({requestId, timestamp, response}) => {
      log('Network.webSocketFrameSent', requestId, timestamp, response.payloadData)
    })

    pageCDPSession.on('Network.webSocketFrameReceived', ({requestId, timestamp, response}) => {
      log('Network.webSocketFrameReceived', requestId, timestamp, response.payloadData)
    }) */

    // Simulate keypress
    await page.exposeFunction(
      'keypressText',
      async (selector: string, text: string, delay = 20) => {
        await page.type(selector, text, { delay })
      },
    )

    const lorem = new LoremIpsum({
      sentencesPerParagraph: {
        max: 4,
        min: 1,
      },
      wordsPerSentence: {
        max: 16,
        min: 2,
      },
    })

    await page.exposeFunction(
      'keypressRandomText',
      async (
        selector: string,
        count = 1,
        prefix = '',
        suffix = '',
        delay = 0,
      ) => {
        const c = prefix + lorem.generateSentences(count) + suffix
        const frames = await page.frames()
        for (const frame of frames) {
          const el = await frame.$(selector)
          if (el) {
            await el.focus()
            await frame.type(selector, c, { delay })
          }
        }
      },
    )

    await page.exposeFunction(
      'uploadFileFromUrl',
      async (fileUrl: string, selector: string) => {
        const filename = md5(fileUrl) + '.' + fileUrl.split('.').slice(-1)[0]
        const filePath = path.join(
          os.homedir(),
          '.webrtcperf/uploads',
          filename,
        )
        if (!fs.existsSync(filePath)) {
          await downloadUrl(fileUrl, undefined, filePath)
        }
        log.debug(`uploadFileFromUrl: ${filePath}`)
        const frames = await page.frames()
        for (const frame of frames) {
          const el = await frame.$(selector)
          if (el) {
            await (el as ElementHandle<HTMLInputElement>).uploadFile(filePath)
            break
          }
        }
      },
    )

    // add extra styles
    if (this.extraCSS) {
      log.debug(`Add extraCSS: ${this.extraCSS}`)
      try {
        await page.evaluateOnNewDocument((css: string) => {
          // eslint-disable-next-line no-undef
          document.addEventListener('DOMContentLoaded', () => {
            // eslint-disable-next-line no-undef
            const style = document.createElement('style')
            style.setAttribute('id', 'webrtcperf-extra-style')
            style.setAttribute('type', 'text/css')
            style.innerHTML = css
            // eslint-disable-next-line no-undef
            document.head.appendChild(style)
          })
        }, this.extraCSS.replace(/important/g, '!important'))
      } catch (err) {
        log.error(`Add extraCSS error: ${(err as Error).stack}`)
      }
    }

    // add cookies
    if (this.cookies) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars,unused-imports/no-unused-vars-ts
        const [schema, _, domain] = url.split('/').slice(0, 3)
        await Promise.all(
          Object.entries(this.cookies).map(([name, value]) => {
            const cookie = {
              name,
              value,
              domain,
              path: '/',
              httpOnly: true,
              secure: true,
            }
            log.info(`setting cookie: %j`, cookie)
            return page.setCookie(cookie)
          }),
        )
      } catch (err) {
        log.error(`Set cookies error: ${(err as Error).stack}`)
      }
    }

    // Page logs and errors.
    let saveFile: fs.promises.FileHandle | undefined = undefined
    if (this.pageLogPath) {
      try {
        await fs.promises.mkdir(path.dirname(this.pageLogPath), {
          recursive: true,
        })
        saveFile = await fs.promises.open(this.pageLogPath, 'a')
      } catch (err) {
        log.error(
          `error opening page log file: ${this.pageLogPath}: ${
            (err as Error).stack
          }`,
        )
      }
    }

    if (this.showPageLog || saveFile) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page.on('pageerror', async (error: any) => {
        const text = `pageerror: ${error.message?.message || error.message} - ${
          error.message?.stack || error.stack
        }`
        await this.onPageMessage(index, 'error', text, saveFile)
      })

      page.on('requestfailed', async request => {
        const err = (request.failure()?.errorText || '').trim()
        if (err === 'net::ERR_ABORTED') {
          return
        }
        const text = `${request.method()} ${request.url()}: ${err}`
        await this.onPageMessage(index, 'requestfailed', text, saveFile)
      })

      page.on('console', async message => {
        if (!this.running) {
          return
        }
        const type = message.type()
        let text = ''
        const args = await Promise.all(
          message.args().map(arg => describeJsHandle(arg)),
        )
        text = args
          .filter(res => res?.length)
          .join(' ')
          .trim()
        if (!text || text === '{}') {
          text = message.text()
        }
        await this.onPageMessage(index, type, text, saveFile)
      })
    }

    page.on('workercreated', worker =>
      log.debug(`Worker created: ${worker.url()}`),
    )
    page.on('workerdestroyed', worker =>
      log.debug(`Worker created: ${worker.url()}`),
    )

    // open the page url
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60 * 1000,
      })
    } catch (error) {
      log.error(
        `Page ${index + 1} "${url}" load error: ${(error as Error).stack}`,
      )
      await page.close()
      return
    }

    // add to pages map
    this.pages.set(index, page)

    log.debug(`Page ${index + 1} "${url}" loaded`)

    for (let i = 0; i < this.evaluateAfter.length; i++) {
      await page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.evaluateAfter[i].pageFunction as any,
        ...this.evaluateAfter[i].args,
      )
    }

    // If not using a real display, select the first blank page.
    if (!this.display) {
      const pages = await this.browser.pages()
      await pages[0].bringToFront()
    }
  }

  private async getNewPage(_tabIndex: number): Promise<Page> {
    assert(this.context, 'NoBrowserContextCreated')
    return await this.context.newPage()
  }

  private async onPageMessage(
    index: number,
    type: string,
    text: string,
    saveFile?: fs.promises.FileHandle,
  ): Promise<void> {
    if (text.endsWith('net::ERR_BLOCKED_BY_CLIENT.Inspector')) {
      return
    }
    const isBlocked = this.blockedUrls.some(
      blockedUrl =>
        (type === 'requestfailed' || text.search('FetchError') !== -1) &&
        text.search(blockedUrl) !== -1,
    )
    if (isBlocked) {
      return
    }
    const color = PageLogColors[type as PageLogColorsKey] || 'grey'
    const filter = this.pageLogFilter
      ? new RegExp(this.pageLogFilter, 'ig')
      : null
    if (!filter || text.match(filter)) {
      const errorOrWarning = ['error', 'warning'].includes(type)
      if (saveFile) {
        if (!errorOrWarning && text.length > 1024) {
          text = text.slice(0, 1024) + `... +${text.length - 1024} bytes`
        }
        await saveFile.write(
          `${new Date().toISOString()} [page ${index + 1}] (${type}) ${text}\n`,
        )
      }
      if (this.showPageLog) {
        if (!errorOrWarning && text.length > 256) {
          text = text.slice(0, 256) + `... +${text.length - 256} bytes`
        }
        console.log(
          chalk`{bold [page ${index + 1}]} {${color} (${type}) ${text}}`,
        )
      }
      if (type === 'error') {
        this.pageErrors += 1
      } else if (type === 'warning') {
        this.pageWarnings += 1
      }
    }
  }

  /**
   * updateStats
   */
  async updateStats(_now: number): Promise<SessionStats> {
    if (!this.browser) {
      this.stats = {}
      return this.stats
    }

    const collectedStats: SessionStats = {}

    try {
      const processStats = await getProcessStats()
      collectedStats.nodeCpu = processStats.cpu
      collectedStats.nodeMemory = processStats.memory
    } catch (err) {
      log.error(`node getProcessStats error: ${(err as Error).stack}`)
    }

    try {
      const systemStats = getSystemStats()
      if (systemStats) {
        collectedStats.usedCpu = systemStats.usedCpu
        collectedStats.usedMemory = systemStats.usedMemory
        collectedStats.usedGpu = systemStats.usedGpu
      }
    } catch (err) {
      log.error(`node getSystemStats error: ${(err as Error).stack}`)
    }

    const browserProcess = this.browser.process()
    if (browserProcess) {
      try {
        const processStats = await getProcessStats(browserProcess.pid, true)
        processStats.cpu /= this.tabsPerSession
        processStats.memory /= this.tabsPerSession
        Object.assign(collectedStats, processStats)
      } catch (err) {
        log.error(`getProcessStats error: ${(err as Error).stack}`)
      }
    }

    const pages: Record<string, number> = {}
    const peerConnections: Record<string, number> = {}
    const videoEndToEndDelayStats: Record<string, number> = {}
    const videoEndToEndNetworkDelayStats: Record<string, number> = {}
    const httpRecvBytesStats: Record<string, number> = {}
    const httpRecvBitrateStats: Record<string, number> = {}
    const httpRecvLatencyStats: Record<string, number> = {}
    const pageCpu: Record<string, number> = {}
    const pageMemory: Record<string, number> = {}

    const customStats: Record<string, Record<string, number | string>> = {}

    for (const [pageIndex, page] of this.pages.entries()) {
      try {
        // Collect stats from page.
        const { peerConnectionStats, videoEndToEndStats, httpResourcesStats } =
          await page.evaluate(async () => ({
            peerConnectionStats: await collectPeerConnectionStats(),
            videoEndToEndStats: collectVideoEndToEndDelayStats(),
            httpResourcesStats: collectHttpResourcesStats(),
          }))
        const participantName = await page.evaluate(() => getParticipantName())

        // Get host from the first collected remote address.
        if (
          !peerConnectionStats.signalingHost &&
          peerConnectionStats.stats.length
        ) {
          const values = Object.values(peerConnectionStats.stats[0])
          if (values.length) {
            peerConnectionStats.signalingHost = await resolveIP(
              values[0].remoteAddress as string,
            )
          }
        }
        const { stats, activePeerConnections, signalingHost } =
          peerConnectionStats

        // Calculate stats keys.
        const hostKey = rtcStatKey({ hostName: signalingHost, participantName })
        const pageKey = rtcStatKey({
          pageIndex,
          hostName: signalingHost,
          participantName,
        })

        // Set pages counter.
        if (!pages[hostKey]) {
          pages[hostKey] = 0
        }
        pages[hostKey] += 1

        // Set peerConnections counter.
        if (!peerConnections[hostKey]) {
          peerConnections[hostKey] = 0
        }
        peerConnections[hostKey] += activePeerConnections

        // E2E stats.
        if (videoEndToEndStats) {
          const { videoEndToEndDelay, videoEndToEndNetworkDelay } =
            videoEndToEndStats
          videoEndToEndDelayStats[pageKey] = videoEndToEndDelay
          videoEndToEndNetworkDelayStats[pageKey] = videoEndToEndNetworkDelay
        }

        // HTTP stats.
        httpRecvBytesStats[pageKey] = httpResourcesStats.recvBytes
        httpRecvBitrateStats[pageKey] = httpResourcesStats.recvBitrate
        httpRecvLatencyStats[pageKey] = httpResourcesStats.recvLatency

        // Collect RTC stats.
        for (const s of stats) {
          for (const [trackId, value] of Object.entries(s)) {
            try {
              updateRtcStats(
                collectedStats as RtcStats,
                pageIndex,
                trackId,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                value,
                signalingHost,
                participantName,
              )
            } catch (err) {
              log.error(
                `updateRtcStats error for ${trackId}: ${(err as Error).stack}`,
                err,
              )
            }
          }
        }

        // Collect custom metrics.
        try {
          const customMetrics = await page.evaluate(() => {
            if (!('collectCustomMetrics' in window)) {
              return null
            }
            return collectCustomMetrics()
          })
          if (customMetrics) {
            for (const [name, value] of Object.entries(customMetrics)) {
              if (!customStats[name]) {
                customStats[name] = {}
              }
              customStats[name][pageKey] = value
            }
          }
        } catch (err) {
          log.error(
            `updateRtcStats collectCustomMetrics error: ${
              (err as Error).stack
            }`,
          )
        }

        // Collect page metrics
        const metrics = await page.metrics()
        if (metrics.Timestamp) {
          const lastMetrics = this.pagesMetrics.get(pageIndex)
          if (lastMetrics?.Timestamp) {
            const elapsedTime = metrics.Timestamp - lastMetrics.Timestamp
            if (elapsedTime > 10) {
              const durationDiff =
                metricsTotalDuration(metrics) -
                metricsTotalDuration(lastMetrics)
              const usage = (100 * durationDiff) / elapsedTime
              pageCpu[pageKey] = usage
              pageMemory[pageKey] = (metrics.JSHeapUsedSize || 0) / 1e6
              this.pagesMetrics.set(pageIndex, metrics)
            }
          } else {
            this.pagesMetrics.set(pageIndex, metrics)
          }
        }
      } catch (err) {
        log.error(`collectPeerConnectionStats error: ${(err as Error).stack}`)
      }
    }
    collectedStats.pages = pages
    collectedStats.errors = this.pageErrors
    collectedStats.warnings = this.pageWarnings
    collectedStats.peerConnections = peerConnections
    collectedStats.videoEndToEndDelay = videoEndToEndDelayStats
    collectedStats.videoEndToEndNetworkDelay = videoEndToEndNetworkDelayStats
    collectedStats.httpRecvBytes = httpRecvBytesStats
    collectedStats.httpRecvBitrate = httpRecvBitrateStats
    collectedStats.httpRecvLatency = httpRecvLatencyStats
    collectedStats.pageCpu = pageCpu
    collectedStats.pageMemory = pageMemory

    Object.assign(collectedStats, customStats)

    if (pages.size < this.pages.size) {
      log.warn(`updateStats collected pages ${pages.size} < ${this.pages.size}`)
    }

    this.stats = collectedStats
    return this.stats
  }

  /**
   * stop
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return
    }
    this.running = false
    log.info(`${this.id} stop`)

    if (this.browser) {
      // close the opened tabs
      log.debug(`${this.id} closing ${this.pages.size} pages`)
      await Promise.allSettled(
        [...this.pages.values()].map(page => {
          return page.close({ runBeforeUnload: true })
        }),
      )
      let attempts = 20
      while (this.pages.size > 0 && attempts > 0) {
        await sleep(500)
        attempts -= 1
      }
      this.browser.removeAllListeners()
      if (this.chromiumUrl) {
        log.debug(`${this.id} disconnect from browser`)
        try {
          this.browser.disconnect()
        } catch (err) {
          log.warn(`browser disconnect error: ${(err as Error).message}`)
        }
      } else {
        log.debug(`${this.id} closing browser`)
        try {
          await this.browser.close()
        } catch (err) {
          log.error(`browser close error: ${(err as Error).stack}`)
        }
      }
      this.pages.clear()
      this.pagesMetrics.clear()
      this.browser = undefined
    }

    this.emit('stop', this.id)
  }

  /**
   * pageScreenshot
   * @param {number} pageIndex
   * @param {String} format The image format (png|jpeg|webp).
   * @return {String}
   */
  async pageScreenshot(pageIndex = 0, format = 'webp'): Promise<string> {
    log.debug(`pageScreenshot ${this.id}-${pageIndex}`)
    const index = this.id + pageIndex
    const page = this.pages.get(index)
    if (!page) {
      throw new Error(`Page ${index} not found`)
    }
    const filePath = `/tmp/screenshot-${index}.${format}`
    await page.screenshot({
      path: filePath,
      fullPage: true,
    })
    return filePath
  }
}
